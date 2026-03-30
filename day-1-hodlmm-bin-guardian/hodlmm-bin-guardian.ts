#!/usr/bin/env bun
/**
 * HODLMM Bin Guardian
 * Monitors Bitflow HODLMM bins to keep LP positions in the active earning range.
 *
 * Self-contained: uses Bitflow public HTTP APIs directly + Hiro Stacks API + CoinGecko.
 *
 * Usage:
 *   bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
 *   bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet <STX_ADDRESS>
 *   bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet <STX_ADDRESS> --pool-id dlmm_1
 *
 * Output: strict JSON { status, action, data, error }
 */

import { Command }  from "commander";
import { homedir }  from "os";
import { join }     from "path";
import { readFileSync, writeFileSync } from "fs";

// ── Constants ──────────────────────────────────────────────────────────────────
const MIN_24H_VOLUME_USD  = 10_000;
const MAX_SLIPPAGE_PCT    = 0.5;   // 0.5% max price deviation
const MAX_GAS_STX         = 50;    // max spend per rebalance in STX
const COOLDOWN_HOURS      = 4;
const PRICE_SCALE         = 1e8;   // Bitflow bin price scale factor
const STATE_FILE          = join(homedir(), ".hodlmm-guardian-state.json");

// ── API bases ──────────────────────────────────────────────────────────────────
const BITFLOW_TICKER_API  = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev";
const BITFLOW_HODLMM_API  = "https://bff.bitflowapis.finance";
const HIRO_API            = "https://api.mainnet.hiro.so";
const COINGECKO_API       = "https://api.coingecko.com/api/v3";

// ── Types ──────────────────────────────────────────────────────────────────────
interface HodlmmPool {
  pool_id:         string;
  pool_name?:      string;
  pool_symbol?:    string;
  token_x:         string;
  token_y:         string;
  bin_step:        number;
  active_bin:      number;
  x_total_fee_bps?: string;
  y_total_fee_bps?: string;
  x_provider_fee?: number;
  x_protocol_fee?: number;
}

interface HodlmmBin {
  bin_id:       number;
  price?:       string;
  reserve_x?:   string;
  reserve_y?:   string;
  liquidity?:   string;
  user_liquidity?: string | number;
}

interface GuardianState {
  last_rebalance_at?: string;   // ISO timestamp
}

interface CooldownResult {
  ok:                     boolean;
  remaining_hours:        number;
  last_rebalance_at:      string | null;
}

interface SlippageResult {
  ok:           boolean;
  pct:          number;
  pool_price:   number;
  market_price: number;
  source:       string;
}

interface GasResult {
  ok:             boolean;
  estimated_stx:  number;
  limit_stx:      number;
}

interface UserBinRange {
  min:    number;
  max:    number;
  count:  number;
  bins:   number[];
}

// ── State helpers ──────────────────────────────────────────────────────────────
function readState(): GuardianState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as GuardianState;
  } catch {
    return {};
  }
}

function checkCooldown(): CooldownResult {
  const state = readState();
  if (!state.last_rebalance_at) {
    return { ok: true, remaining_hours: 0, last_rebalance_at: null };
  }
  const elapsed = (Date.now() - new Date(state.last_rebalance_at).getTime()) / 3_600_000;
  const remaining = Math.max(0, COOLDOWN_HOURS - elapsed);
  return {
    ok:                 remaining === 0,
    remaining_hours:    parseFloat(remaining.toFixed(2)),
    last_rebalance_at:  state.last_rebalance_at,
  };
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-bin-guardian" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchPools(): Promise<HodlmmPool[]> {
  const data = await fetchJson(`${BITFLOW_HODLMM_API}/api/quotes/v1/pools`);
  return (data.pools ?? []) as HodlmmPool[];
}

/** Fetch the pool's bin list — returns active_bin_id and bin price map. */
async function fetchPoolBins(poolId: string): Promise<{
  active_bin_id: number;
  priceByBinId:  Map<number, number>;
}> {
  const data = await fetchJson(`${BITFLOW_HODLMM_API}/api/quotes/v1/bins/${poolId}`);
  const priceByBinId = new Map<number, number>(
    ((data.bins ?? []) as HodlmmBin[]).map((b) => [b.bin_id, parseFloat(b.price ?? "0")])
  );
  return { active_bin_id: data.active_bin_id as number, priceByBinId };
}

/**
 * Fetch the user's position bins for a given pool.
 * Returns null if the user has no position (404).
 */
async function fetchUserPositionBins(address: string, poolId: string): Promise<HodlmmBin[] | null> {
  const url = `${BITFLOW_HODLMM_API}/api/app/v1/users/${address}/positions/${poolId}/bins`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-bin-guardian" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching user position`);
  const data = await res.json() as any;

  // Normalize: API may return bins under different keys
  const rawBins: HodlmmBin[] = Array.isArray(data?.bins)
    ? data.bins
    : Array.isArray(data?.position_bins)
      ? data.position_bins
      : Array.isArray(data?.positions?.bins)
        ? data.positions.bins
        : [];

  return rawBins;
}

/** Fetch FT decimals from Hiro metadata API. Returns 6 on failure (safe default for stablecoins). */
async function fetchTokenDecimals(contractId: string): Promise<number> {
  try {
    const data = await fetchJson(`${HIRO_API}/metadata/v1/ft/${contractId}`);
    return typeof data.decimals === "number" ? data.decimals : 6;
  } catch {
    return 6;
  }
}

/** Fetch BTC/USD price from CoinGecko. */
async function fetchBtcPriceUsd(): Promise<number> {
  const data = await fetchJson(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`);
  return data?.bitcoin?.usd ?? 0;
}

/** Fetch 24h volume and liquidity from Bitflow ticker for a pool. */
async function fetchPoolTicker(pool: HodlmmPool): Promise<{ volume24hUsd: number; liquidityUsd: number }> {
  try {
    const tickers = await fetchJson(`${BITFLOW_TICKER_API}/ticker`);
    // Match by pool_id or by token pair
    const match = tickers.find((t: any) =>
      t.pool_id === pool.pool_id ||
      (t.base_currency === pool.token_x && t.target_currency === pool.token_y)
    );
    if (!match) return { volume24hUsd: 0, liquidityUsd: 0 };
    return {
      volume24hUsd: parseFloat(match.base_volume ?? "0") * 69_000, // sBTC volume × proxy BTC price
      liquidityUsd: parseFloat(match.liquidity_in_usd ?? "0") || 0,
    };
  } catch {
    return { volume24hUsd: 0, liquidityUsd: 0 };
  }
}

/** Estimate fee APR from 7d volume proxy and liquidity. */
function estimateApr(liquidityUsd: number, volume24hUsd: number, feeBps: number): string {
  if (!isFinite(liquidityUsd) || !isFinite(volume24hUsd) || liquidityUsd <= 0 || volume24hUsd <= 0) return "N/A";
  const annualizedVolume = volume24hUsd * 365;
  const annualFeeRevenue = annualizedVolume * (feeBps / 10_000);
  return `${((annualFeeRevenue / liquidityUsd) * 100).toFixed(2)}%`;
}

/**
 * Compute pool price vs CoinGecko price for slippage check.
 * Only meaningful for sBTC/USD-pegged stablecoin pools.
 */
async function checkSlippage(
  pool:         HodlmmPool,
  activeBinPrice: number,   // raw from API
  xDecimals:    number,
  yDecimals:    number,
): Promise<SlippageResult> {
  // Detect if y token is a USD-pegged stablecoin
  const yId = pool.token_y.toLowerCase();
  const isUsdPair = ["usdcx", "usdc", "usdt", "busd"].some((s) => yId.includes(s));

  if (!isUsdPair) {
    // Cross-rate slippage is out of scope for now — report as N/A
    return { ok: true, pct: 0, pool_price: 0, market_price: 0, source: "unavailable (non-USD pair)" };
  }

  // pool_price_usd = (activeBinPrice / PRICE_SCALE) * 10^(xDecimals - yDecimals)
  const poolPriceUsd = (activeBinPrice / PRICE_SCALE) * Math.pow(10, xDecimals - yDecimals);

  const marketPriceUsd = await fetchBtcPriceUsd();
  if (!marketPriceUsd) {
    return { ok: true, pct: 0, pool_price: poolPriceUsd, market_price: 0, source: "coingecko-unavailable" };
  }

  const pct = Math.abs(poolPriceUsd - marketPriceUsd) / marketPriceUsd * 100;
  return {
    ok:           pct <= MAX_SLIPPAGE_PCT,
    pct:          parseFloat(pct.toFixed(4)),
    pool_price:   parseFloat(poolPriceUsd.toFixed(2)),
    market_price: marketPriceUsd,
    source:       "coingecko-btc-vs-pool-active-bin",
  };
}

/** Estimate gas cost for a two-transaction rebalance (withdraw + add). */
async function checkGas(): Promise<GasResult> {
  let feeUstx = 0;
  try {
    // Hiro returns fee per byte; contract calls are ~2-3x more expensive than transfers.
    // Apply a 20% safety buffer on top of the 2-3x multiplier to enforce the hard limit.
    const raw = await fetchJson(`${HIRO_API}/v2/fees/transfer`);
    const feePerByte = typeof raw === "number" ? raw : 6; // µSTX/byte default
    // 500 bytes × 2 txns × 3x contract-call multiplier × 1.2 safety buffer
    feeUstx = feePerByte * 500 * 2 * 3 * 1.2;
  } catch {
    feeUstx = 6 * 500 * 2 * 3 * 1.2; // fallback with same multipliers
  }
  const estimatedStx = feeUstx / 1_000_000;
  return {
    ok:            estimatedStx <= MAX_GAS_STX,
    estimated_stx: parseFloat(estimatedStx.toFixed(6)),
    limit_stx:     MAX_GAS_STX,
  };
}

// ── Core logic ─────────────────────────────────────────────────────────────────
async function runGuardian(
  wallet?:  string,
  poolId?:  string,
): Promise<{
  status:  "success" | "error";
  action:  string;
  data:    Record<string, any>;
  error:   any;
}> {
  // Input validation
  if (wallet && !/^SP[A-Z0-9]{30,}$/.test(wallet)) {
    return {
      status: "error",
      action: "Validation failed",
      data:   {},
      error:  { code: "INVALID_WALLET", message: "Wallet must be a valid Stacks mainnet address (SP...)", next: "Pass a valid --wallet address" },
    };
  }
  if (poolId && !/^[a-zA-Z0-9_-]+$/.test(poolId)) {
    return {
      status: "error",
      action: "Validation failed",
      data:   {},
      error:  { code: "INVALID_POOL_ID", message: "pool-id must be alphanumeric (e.g. dlmm_1)", next: "Pass a valid --pool-id" },
    };
  }

  // Fetch pool list
  const pools = await fetchPools();
  const sbtcPools = pools.filter((p) =>
    p.token_x.toLowerCase().includes("sbtc") || p.token_y.toLowerCase().includes("sbtc")
  );

  let pool: HodlmmPool | undefined;
  if (poolId) {
    pool = pools.find((p) => p.pool_id === poolId);
  } else {
    pool = sbtcPools.find((p) => p.pool_id === "dlmm_1") ?? sbtcPools[0];
  }
  if (!pool) {
    return {
      status: "error",
      action: "Pool not found",
      data:   {},
      error:  { code: "POOL_NOT_FOUND", message: `No pool found for id: ${poolId ?? "default"}`, next: "Run doctor to list available pools" },
    };
  }

  // Fetch pool bins and user position (in parallel where possible)
  const [binsData, tickerData, gasResult, cooldownResult] = await Promise.all([
    fetchPoolBins(pool.pool_id),
    fetchPoolTicker(pool),
    checkGas(),
    Promise.resolve(checkCooldown()),
  ]);

  const { active_bin_id, priceByBinId } = binsData;

  // ── In-range check (real position check) ────────────────────────────────────
  let inRange: boolean | null = null;
  let userBinRange: UserBinRange | null = null;
  let positionNote: string | undefined;

  if (wallet) {
    const userBins = await fetchUserPositionBins(wallet, pool.pool_id);
    if (userBins === null) {
      inRange     = false;
      positionNote = `No position found for ${wallet} in pool ${pool.pool_id}.`;
    } else {
      // Only count bins where the user has actual liquidity
      const activeBins = userBins.filter((b) => {
        const liq = typeof b.user_liquidity === "number"
          ? b.user_liquidity
          : parseFloat(String(b.user_liquidity ?? "0"));
        return liq > 0;
      });
      const binIds = activeBins.map((b) => b.bin_id).sort((a, z) => a - z);
      inRange = binIds.includes(active_bin_id);
      if (binIds.length > 0) {
        userBinRange = {
          min:   binIds[0],
          max:   binIds[binIds.length - 1],
          count: binIds.length,
          bins:  binIds,
        };
      } else {
        positionNote = "User has a position record but no bins with liquidity.";
      }
    }
  } else {
    positionNote = "No wallet provided — in-range check skipped. Pass --wallet <STX_ADDRESS>.";
  }

  // ── Slippage check (real pool price vs market) ───────────────────────────────
  const activeBinRawPrice = priceByBinId.get(active_bin_id) ?? 0;
  const [xDecimals, yDecimals] = await Promise.all([
    fetchTokenDecimals(pool.token_x),
    fetchTokenDecimals(pool.token_y),
  ]);
  const slippageResult = await checkSlippage(pool, activeBinRawPrice, xDecimals, yDecimals);

  // ── Volume / refusal check ────────────────────────────────────────────────────
  const { volume24hUsd, liquidityUsd } = tickerData;
  const volumeOk = isFinite(volume24hUsd) && volume24hUsd >= MIN_24H_VOLUME_USD;

  // ── APR estimate ───────────────────────────────────────────────────────────────
  const feeBps = parseFloat(pool.x_total_fee_bps ?? "30");
  const currentApr = estimateApr(liquidityUsd, volume24hUsd, feeBps);

  // ── Build refusal summary ──────────────────────────────────────────────────────
  const refusals: string[] = [];
  if (!volumeOk)          refusals.push(`24h volume $${Math.round(volume24hUsd).toLocaleString()} < $${MIN_24H_VOLUME_USD.toLocaleString()} minimum`);
  if (!slippageResult.ok) refusals.push(`price slippage ${slippageResult.pct.toFixed(2)}% > ${MAX_SLIPPAGE_PCT}% cap`);
  if (!gasResult.ok)      refusals.push(`estimated gas ${gasResult.estimated_stx} STX > ${MAX_GAS_STX} STX limit`);
  if (!cooldownResult.ok) refusals.push(`cooldown: ${cooldownResult.remaining_hours}h remaining (${COOLDOWN_HOURS}h window)`);

  const canRebalance = refusals.length === 0;

  // ── Recommendation ─────────────────────────────────────────────────────────────
  let action: string;
  if (inRange === null) {
    action = `CHECK — ${positionNote}`;
  } else if (inRange) {
    action = `HOLD — position in range at active bin ${active_bin_id}. APR: ${currentApr}.`;
  } else if (!canRebalance) {
    action = `HOLD — position out of range but rebalance blocked: ${refusals.join("; ")}.`;
  } else {
    action = `REBALANCE — position out of range (active bin ${active_bin_id}${userBinRange ? `, position bins ${userBinRange.min}–${userBinRange.max}` : ""}). Requires human approval.`;
  }

  return {
    status: "success",
    action,
    data: {
      in_range:               inRange,
      active_bin:             active_bin_id,
      user_bin_range:         userBinRange,
      can_rebalance:          canRebalance,
      refusal_reasons:        refusals.length > 0 ? refusals : null,
      slippage_ok:            slippageResult.ok,
      slippage_pct:           slippageResult.pct,
      bin_price_raw:          activeBinRawPrice,
      pool_price_usd:         slippageResult.pool_price || null,
      market_price_usd:       slippageResult.market_price || null,
      slippage_source:        slippageResult.source,
      gas_ok:                 gasResult.ok,
      gas_estimated_stx:      gasResult.estimated_stx,
      cooldown_ok:            cooldownResult.ok,
      cooldown_remaining_h:   cooldownResult.remaining_hours,
      last_rebalance_at:      cooldownResult.last_rebalance_at,
      volume_ok:              volumeOk,
      volume_24h_usd:         Math.round(volume24hUsd),
      liquidity_usd:          Math.round(liquidityUsd),
      current_apr:            currentApr,
      pool_id:                pool.pool_id,
      pool_name:              pool.pool_name ?? pool.pool_symbol ?? pool.pool_id,
      fee_bps:                feeBps,
      ...(positionNote ? { position_note: positionNote } : {}),
    },
    error: null,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-bin-guardian")
  .description("Monitor Bitflow HODLMM bins and output LP health status")
  .version("2.0.0");

program
  .command("doctor")
  .description("Check all API dependencies for reachability")
  .action(async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    try {
      const pools = await fetchPools();
      const sbtcPool = pools.find((p) => p.pool_id === "dlmm_1");
      checks.push({
        name:   "Bitflow HODLMM API",
        ok:     pools.length > 0,
        detail: `${pools.length} pools found${sbtcPool ? `, dlmm_1 active bin: ${sbtcPool.active_bin}` : ""}`,
      });
    } catch (e: any) {
      checks.push({ name: "Bitflow HODLMM API", ok: false, detail: e.message });
    }

    try {
      const binsData = await fetchPoolBins("dlmm_1");
      checks.push({
        name:   "Bitflow Bins API (dlmm_1)",
        ok:     binsData.active_bin_id > 0,
        detail: `active_bin_id=${binsData.active_bin_id}, ${binsData.priceByBinId.size} bins`,
      });
    } catch (e: any) {
      checks.push({ name: "Bitflow Bins API (dlmm_1)", ok: false, detail: e.message });
    }

    try {
      const tickers = await fetchJson(`${BITFLOW_TICKER_API}/ticker`);
      checks.push({
        name:   "Bitflow Ticker API",
        ok:     Array.isArray(tickers) && tickers.length > 0,
        detail: `${tickers.length} pairs`,
      });
    } catch (e: any) {
      checks.push({ name: "Bitflow Ticker API", ok: false, detail: e.message });
    }

    try {
      const btc = await fetchBtcPriceUsd();
      checks.push({
        name:   "CoinGecko BTC Price",
        ok:     btc > 0,
        detail: `$${btc.toLocaleString()}`,
      });
    } catch (e: any) {
      checks.push({ name: "CoinGecko BTC Price", ok: false, detail: e.message });
    }

    try {
      const fee = await fetchJson(`${HIRO_API}/v2/fees/transfer`);
      checks.push({
        name:   "Hiro Stacks API (fees)",
        ok:     fee > 0,
        detail: `${fee} µSTX/byte`,
      });
    } catch (e: any) {
      checks.push({ name: "Hiro Stacks API (fees)", ok: false, detail: e.message });
    }

    const allOk = checks.every((c) => c.ok);
    console.log(JSON.stringify({
      status:  allOk ? "ok" : "degraded",
      checks,
      message: allOk
        ? "All data sources reachable. Ready to run."
        : "One or more sources failed — oracle output may be incomplete.",
    }, null, 2));
    if (!allOk) process.exit(1);
  });

program
  .command("install-packs")
  .description("No additional packs required — uses public HTTP APIs directly")
  .action(() => {
    console.log(JSON.stringify({
      status:  "ok",
      message: "No packs required. hodlmm-bin-guardian uses Bitflow, Hiro, and CoinGecko public APIs.",
      data:    { requires: [] },
    }, null, 2));
  });

program
  .command("run")
  .description("Check HODLMM bin status for a wallet and output recommendation")
  .option("--wallet <address>",  "Stacks wallet address (SP...) to check position for")
  .option("--pool-id <id>",      "Specific pool ID to check (default: dlmm_1)")
  .action(async (options) => {
    try {
      const result = await runGuardian(options.wallet, options.poolId);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "error") process.exit(1);
    } catch (err: any) {
      console.error(JSON.stringify({
        status: "error",
        action: "Guardian run failed",
        data:   {},
        error:  { code: "RUN_ERROR", message: err.message, next: "Run doctor to diagnose" },
      }, null, 2));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(JSON.stringify({ status: "error", error: err.message }));
  process.exit(1);
});
