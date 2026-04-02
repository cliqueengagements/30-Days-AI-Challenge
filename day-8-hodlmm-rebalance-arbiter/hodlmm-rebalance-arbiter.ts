#!/usr/bin/env bun
/**
 * hodlmm-rebalance-arbiter — Decision gate for HODLMM LP rebalancing.
 *
 * Consumes 3 independent signals:
 *   1. hodlmm-bin-guardian   → Is a rebalance needed? (bin drift)
 *   2. hodlmm-tenure-protector → Is it safe to act? (Bitcoin block timing)
 *   3. sbtc-proof-of-reserve  → Is the sBTC peg healthy?
 *
 * Outputs a single verdict: REBALANCE, WAIT, HOLD, or DEGRADED.
 *
 * Does NOT execute transactions. Does NOT move funds.
 * It answers one question: "Should I rebalance right now, or wait?"
 *
 * Usage:
 *   bun run hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts doctor
 *   bun run hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts run --wallet <STX_ADDRESS>
 *   bun run hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts run --wallet <STX_ADDRESS> --pool <id>
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
const STALE_DATA_THRESHOLD_S = 300; // 5 minutes — data older than this is suspect
const USER_AGENT = "bff-skills/hodlmm-rebalance-arbiter";

// Bitflow & Hiro API bases
const BITFLOW_BASE = "https://bff.bitflowapis.finance";
const HIRO_BASE = "https://api.mainnet.hiro.so";
const MEMPOOL_BASE = "https://mempool.space/api";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const BITFLOW_TICKER = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker";

// Tenure risk thresholds (seconds since last Bitcoin block)
const TENURE_GREEN_MAX_S = 600;
const TENURE_YELLOW_MAX_S = 900;
const TENURE_RED_MAX_S = 1200;

// HODLMM pool gates
const MIN_TVL_USD = 10_000;
const MIN_VOLUME_USD = 10_000;
const MAX_SLIPPAGE_PCT = 0.5;

// sBTC reserve thresholds
const SBTC_GREEN_RATIO = 0.999;
const SBTC_YELLOW_RATIO = 0.995;
const SBTC_DECIMALS = 8;

// sBTC contracts
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_REGISTRY = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_REGISTRY_NAME = "sbtc-registry";

// ── Types ──────────────────────────────────────────────────────────────────────

type SignalColor = "GREEN" | "YELLOW" | "RED" | "ERROR";
type ArbiterDecision = "REBALANCE" | "BLOCKED" | "IN_RANGE" | "DEGRADED";

interface BinGuardianSignal {
  color: SignalColor;
  needs_rebalance: boolean;
  active_bin: number;
  user_bin_range: { min: number; max: number; count: number } | null;
  in_range: boolean | null;
  slippage_pct: number;
  volume_24h_usd: number;
  apr_24h_pct: number;
  pool_id: string;
  pair: string;
  raw_action: string;
}

interface TenureSignal {
  color: SignalColor;
  tenure_age_s: number;
  risk_level: string;
  burn_block_height: number;
  predicted_next_block_s: number;
  stacks_tip_height: number;
}

interface ReserveSignal {
  color: SignalColor;
  reserve_ratio: number | null;
  score: number;
  hodlmm_signal: string;
  sbtc_circulating: number | null;
  btc_reserve: number | null;
  signer_address: string | null;
  recommendation: string;
}

interface ArbiterResult {
  status: "ok" | "degraded" | "error";
  decision: ArbiterDecision;
  reason: string;
  signals: {
    bin_guardian: BinGuardianSignal;
    tenure_protector: TenureSignal;
    sbtc_reserve: ReserveSignal;
  };
  blockers: string[];
  retry_after: string | null;
  pool_id: string;
  wallet: string;
  timestamp: string;
  error: string | null;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorResult {
  status: "ok" | "degraded" | "error";
  checks: DoctorCheck[];
  message: string;
}

// ── Bitflow API types ──────────────────────────────────────────────────────────

interface AppPoolToken {
  contract: string;
  priceUsd: number;
  decimals: number;
  symbol: string;
}

interface AppPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  apr24h: number;
  binStep: number;
  tokens: { tokenX: AppPoolToken; tokenY: AppPoolToken };
}

interface QuotesPool {
  pool_id: string;
  active_bin: number;
  token_x: string;
  token_y: string;
  bin_step: number;
}

interface UserBin {
  binId?: number | string;
  bin_id?: number | string;
  liquidity?: number | string;
  user_liquidity?: number | string;
  userLiquidity?: number | string;
  isActive?: boolean;
}

interface BinQuote {
  bin_id: number;
  price?: string;
}

interface BinsResponse {
  bins?: BinQuote[];
  active_bin_id?: number;
}

// ── Fetch helper ───────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1500));
      const retry = await fetch(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init?.headers ?? {}) },
      });
      if (!retry.ok) throw new Error(`HTTP ${retry.status} from ${url} (after retry)`);
      return retry.json() as Promise<T>;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Signal 1: Bin Guardian (inline) ────────────────────────────────────────────

async function fetchBinGuardianSignal(wallet: string, poolId: string): Promise<BinGuardianSignal> {
  const errorSignal = (msg: string): BinGuardianSignal => ({
    color: "ERROR",
    needs_rebalance: false,
    active_bin: 0,
    user_bin_range: null,
    in_range: null,
    slippage_pct: 0,
    volume_24h_usd: 0,
    apr_24h_pct: 0,
    pool_id: poolId,
    pair: "unknown",
    raw_action: msg,
  });

  try {
    // Fetch pool data from quotes API
    const quotesData = await fetchJson<{ pools?: QuotesPool[] }>(
      `${BITFLOW_BASE}/api/quotes/v1/pools`
    );
    const pool = (quotesData.pools ?? []).find(p => p.pool_id === poolId);
    if (!pool) return errorSignal(`Pool ${poolId} not found`);

    // Fetch app pool stats (TVL, volume, APR, prices)
    const appData = await fetchJson<{ data?: AppPool[] }>(`${BITFLOW_BASE}/api/app/v1/pools`);
    const appPool = (appData.data ?? []).find(p => p.poolId === poolId);

    const tvl = appPool?.tvlUsd ?? 0;
    const volume = appPool?.volumeUsd1d ?? 0;
    const apr = appPool?.apr24h ?? 0;
    const tokenXSymbol = appPool?.tokens?.tokenX?.symbol ?? "?";
    const tokenYSymbol = appPool?.tokens?.tokenY?.symbol ?? "?";
    const pair = `${tokenXSymbol}/${tokenYSymbol}`;

    // Fetch bin data for active bin and price
    const binsData = await fetchJson<BinsResponse>(
      `${BITFLOW_BASE}/api/quotes/v1/bins/${poolId}`
    );
    const activeBin = binsData.active_bin_id ?? pool.active_bin ?? 0;

    // Fetch user position bins (404 = no position, not an error)
    let userBins: UserBin[] = [];
    try {
      const posUrl = `${BITFLOW_BASE}/api/app/v1/users/${wallet}/positions/${poolId}/bins`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(posUrl, {
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        });
        if (res.status === 404) {
          // No position — not an error, just empty
          userBins = [];
        } else if (res.ok) {
          const userBinsRaw = await res.json() as UserBin[] | { bins?: UserBin[]; data?: UserBin[]; detail?: string };
          if (Array.isArray(userBinsRaw)) {
            userBins = userBinsRaw;
          } else if (typeof userBinsRaw === "object" && userBinsRaw !== null) {
            if ("detail" in userBinsRaw) {
              userBins = []; // API returns {detail: "..."} for no position
            } else {
              userBins = (userBinsRaw as { bins?: UserBin[]; data?: UserBin[] }).bins
                ?? (userBinsRaw as { bins?: UserBin[]; data?: UserBin[] }).data
                ?? [];
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Network error fetching positions — treat as no data
      userBins = [];
    }

    const activeBinIds = userBins
      .filter(b => {
        const liq = typeof b.userLiquidity === "number"
          ? b.userLiquidity
          : typeof b.user_liquidity === "number"
            ? b.user_liquidity
            : parseFloat(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0"));
        return liq > 0;
      })
      .map(b => Number(b.binId ?? b.bin_id ?? 0))
      .filter(id => id > 0)
      .sort((a, z) => a - z);

    const inRange = activeBinIds.length > 0 ? activeBinIds.includes(activeBin) : null;
    const userBinRange = activeBinIds.length > 0
      ? { min: activeBinIds[0], max: activeBinIds[activeBinIds.length - 1], count: activeBinIds.length }
      : null;

    // Compute slippage from bin price vs app price
    let slippagePct = 0;
    if (appPool?.tokens?.tokenX?.priceUsd && binsData.bins?.length) {
      const activeBinData = binsData.bins.find(b => b.bin_id === activeBin);
      if (activeBinData?.price) {
        const binPrice = parseFloat(activeBinData.price);
        const xDec = appPool.tokens.tokenX.decimals;
        const yDec = appPool.tokens.tokenY.decimals;
        const scaledPrice = (binPrice / 1e8) * Math.pow(10, xDec - yDec);
        if (appPool.tokens.tokenX.priceUsd > 0) {
          slippagePct = Math.abs(scaledPrice - appPool.tokens.tokenX.priceUsd)
            / appPool.tokens.tokenX.priceUsd * 100;
        }
      }
    }

    // Determine if rebalance is needed
    const needsRebalance = inRange === false && tvl >= MIN_TVL_USD && volume >= MIN_VOLUME_USD;
    const volumeOk = volume >= MIN_VOLUME_USD;
    const slippageOk = slippagePct <= MAX_SLIPPAGE_PCT;

    let color: SignalColor = "GREEN";
    let action = "HOLD — position in range";
    if (inRange === null) {
      color = "YELLOW";
      action = "No position data — cannot determine range";
    } else if (!inRange) {
      if (!volumeOk || !slippageOk) {
        color = "YELLOW";
        action = `Out of range but blocked: ${!volumeOk ? "low volume" : ""}${!slippageOk ? " high slippage" : ""}`.trim();
      } else {
        color = "RED";
        action = `REBALANCE — out of range (active bin ${activeBin}, position ${userBinRange?.min}–${userBinRange?.max})`;
      }
    }

    return {
      color,
      needs_rebalance: needsRebalance,
      active_bin: activeBin,
      user_bin_range: userBinRange,
      in_range: inRange,
      slippage_pct: parseFloat(slippagePct.toFixed(4)),
      volume_24h_usd: Math.round(volume),
      apr_24h_pct: apr,
      pool_id: poolId,
      pair,
      raw_action: action,
    };
  } catch (err: unknown) {
    return errorSignal(err instanceof Error ? err.message : "Unknown error");
  }
}

// ── Signal 2: Tenure Protector (inline) ────────────────────────────────────────

async function fetchTenureSignal(): Promise<TenureSignal> {
  const errorSignal: TenureSignal = {
    color: "ERROR",
    tenure_age_s: 9999,
    risk_level: "CRITICAL",
    burn_block_height: 0,
    predicted_next_block_s: 0,
    stacks_tip_height: 0,
  };

  try {
    const [nodeInfo, blocksData, burnData] = await Promise.all([
      fetchJson<{ tenure_height?: number; stacks_tip_height?: number; burn_block_height?: number }>(
        `${HIRO_BASE}/v2/info`
      ),
      fetchJson<{ results: { burn_block_time: number; burn_block_height: number; height: number; tenure_height: number }[] }>(
        `${HIRO_BASE}/extended/v2/blocks?limit=1`
      ),
      fetchJson<{ results: { burn_block_time: number; burn_block_height: number }[] }>(
        `${HIRO_BASE}/extended/v2/burn-blocks?limit=10`
      ),
    ]);

    const latestBlock = blocksData.results?.[0];
    if (!latestBlock) return errorSignal;

    const nowUnix = Math.floor(Date.now() / 1000);
    const tenureAgeS = nowUnix - latestBlock.burn_block_time;

    // Classify risk
    let color: SignalColor = "GREEN";
    let riskLevel = "GREEN";
    if (tenureAgeS > TENURE_RED_MAX_S) {
      color = "RED";
      riskLevel = "CRITICAL";
    } else if (tenureAgeS > TENURE_YELLOW_MAX_S) {
      color = "RED";
      riskLevel = "RED";
    } else if (tenureAgeS > TENURE_GREEN_MAX_S) {
      color = "YELLOW";
      riskLevel = "YELLOW";
    }

    // Compute average gap for prediction
    const burnBlocks = burnData.results ?? [];
    const gaps: number[] = [];
    for (let i = 0; i < burnBlocks.length - 1; i++) {
      const gap = burnBlocks[i].burn_block_time - burnBlocks[i + 1].burn_block_time;
      if (gap > 0) gaps.push(gap);
    }
    const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 600;

    return {
      color,
      tenure_age_s: tenureAgeS,
      risk_level: riskLevel,
      burn_block_height: latestBlock.burn_block_height,
      predicted_next_block_s: Math.round(avgGap),
      stacks_tip_height: nodeInfo.stacks_tip_height ?? latestBlock.height,
    };
  } catch {
    return errorSignal;
  }
}

// ── Signal 3: sBTC Reserve (inline) ────────────────────────────────────────────

async function fetchReserveSignal(): Promise<ReserveSignal> {
  const errorSignal: ReserveSignal = {
    color: "ERROR",
    reserve_ratio: null,
    score: 0,
    hodlmm_signal: "DATA_UNAVAILABLE",
    sbtc_circulating: null,
    btc_reserve: null,
    signer_address: null,
    recommendation: "Cannot fetch reserve data — treat as RED.",
  };

  try {
    // We need tiny-secp256k1 for taproot derivation — but to keep this skill
    // self-contained without importing from sbtc-proof-of-reserve, we use
    // the simpler approach: fetch supply and use Bitflow ticker for peg ratio.

    // 1. Fetch sBTC supply
    const [addr, name] = SBTC_CONTRACT.split(".");
    const supplyRes = await fetchJson<{ okay: boolean; result: string }>(
      `${HIRO_BASE}/v2/contracts/call-read/${addr}/${name}/get-total-supply`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: addr, arguments: [] }) }
    );

    let sbtcSupply = 0;
    if (supplyRes.okay && supplyRes.result) {
      const hex = supplyRes.result.replace(/^0x/, "");
      if (hex.startsWith("01")) {
        sbtcSupply = Number(BigInt("0x" + hex.slice(2))) / 10 ** SBTC_DECIMALS;
      }
    }
    if (sbtcSupply === 0) {
      const meta = await fetchJson<{ total_supply?: string }>(
        `${HIRO_BASE}/metadata/v1/ft/${SBTC_CONTRACT}`
      );
      sbtcSupply = Number(BigInt(meta?.total_supply ?? "0")) / 10 ** SBTC_DECIMALS;
    }

    // 2. Fetch signer aggregate pubkey and derive P2TR address for BTC balance
    const pubkeyRes = await fetchJson<{ okay: boolean; result: string }>(
      `${HIRO_BASE}/v2/contracts/call-read/${SBTC_REGISTRY}/${SBTC_REGISTRY_NAME}/get-current-aggregate-pubkey`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: SBTC_REGISTRY, arguments: [] }) }
    );

    let signerAddress: string | null = null;
    let btcReserve = 0;

    if (pubkeyRes.okay && pubkeyRes.result) {
      // Import tiny-secp256k1 dynamically for taproot key tweak
      const ecc = await import("tiny-secp256k1");
      const { createHash } = await import("crypto");

      const hex = pubkeyRes.result.replace(/^0x/, "");
      const compressedPubkey = hex.slice(10);
      const xOnlyHex = compressedPubkey.slice(2);

      // BIP-341 tagged hash
      const tagHash = createHash("sha256").update("TapTweak").digest();
      const tweak = createHash("sha256").update(tagHash).update(tagHash).update(Buffer.from(xOnlyHex, "hex")).digest();
      const tweaked = ecc.xOnlyPointAddTweak(Buffer.from(xOnlyHex, "hex"), tweak);

      if (tweaked) {
        // Bech32m encode
        const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

        function polymod(values: number[]): number {
          let chk = 1;
          for (const v of values) {
            const b = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ v;
            for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
          }
          return chk;
        }

        function hrpExpand(hrp: string): number[] {
          const ret: number[] = [];
          for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
          ret.push(0);
          for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
          return ret;
        }

        function convertBits(data: Uint8Array, fromBits: number, toBits: number): number[] {
          let acc = 0, bits = 0;
          const result: number[] = [];
          const maxV = (1 << toBits) - 1;
          for (const value of data) {
            acc = (acc << fromBits) | value;
            bits += fromBits;
            while (bits >= toBits) { bits -= toBits; result.push((acc >> bits) & maxV); }
          }
          if (bits > 0) result.push((acc << (toBits - bits)) & maxV);
          return result;
        }

        const witnessData = [1, ...convertBits(tweaked.xOnlyPubkey, 8, 5)];
        const expanded = hrpExpand("bc").concat(witnessData).concat([0, 0, 0, 0, 0, 0]);
        const poly = polymod(expanded) ^ 0x2bc830a3;
        const checksum = Array.from({ length: 6 }, (_, i) => (poly >> (5 * (5 - i))) & 31);
        signerAddress = "bc1" + [...witnessData, ...checksum].map(d => CHARSET[d]).join("");

        // Fetch BTC balance
        const addrInfo = await fetchJson<{ chain_stats?: { funded_txo_sum: number; spent_txo_sum: number } }>(
          `${MEMPOOL_BASE}/address/${signerAddress}`
        );
        const funded = addrInfo?.chain_stats?.funded_txo_sum ?? 0;
        const spent = addrInfo?.chain_stats?.spent_txo_sum ?? 0;
        btcReserve = (funded - spent) / 1e8;
      }
    }

    // 3. Compute reserve ratio
    const reserveRatio = sbtcSupply > 0 && btcReserve > 0 ? btcReserve / sbtcSupply : 0;

    // 4. Derive signal color
    let color: SignalColor = "ERROR";
    let hodlmmSignal = "DATA_UNAVAILABLE";
    let recommendation = "Cannot compute reserve ratio.";

    if (reserveRatio > 0) {
      if (reserveRatio >= SBTC_GREEN_RATIO) {
        color = "GREEN";
        hodlmmSignal = "GREEN";
        recommendation = "sBTC fully backed. Safe for HODLMM operations.";
      } else if (reserveRatio >= SBTC_YELLOW_RATIO) {
        color = "YELLOW";
        hodlmmSignal = "YELLOW";
        recommendation = "sBTC reserve slightly below 1:1. Hold current positions, avoid new sBTC exposure.";
      } else {
        color = "RED";
        hodlmmSignal = "RED";
        recommendation = "sBTC under-collateralized. Do not rebalance into sBTC-paired pools.";
      }
    }

    // 5. Compute score (simplified from sbtc-proof-of-reserve)
    let score = 100;
    if (reserveRatio > 0 && reserveRatio < 1 / 1.05) score -= 30;
    else if (reserveRatio > 0 && reserveRatio < 1 / 1.002) score -= 15;

    return {
      color,
      reserve_ratio: reserveRatio > 0 ? parseFloat(reserveRatio.toFixed(6)) : null,
      score: Math.max(0, score),
      hodlmm_signal: hodlmmSignal,
      sbtc_circulating: sbtcSupply > 0 ? sbtcSupply : null,
      btc_reserve: btcReserve > 0 ? btcReserve : null,
      signer_address: signerAddress,
      recommendation,
    };
  } catch {
    return errorSignal;
  }
}

// ── Decision Gate ──────────────────────────────────────────────────────────────

function arbiterDecision(
  bin: BinGuardianSignal,
  tenure: TenureSignal,
  reserve: ReserveSignal,
): { decision: ArbiterDecision; reason: string; blockers: string[]; retryAfter: string | null } {
  const blockers: string[] = [];

  // Any ERROR → DEGRADED
  if (bin.color === "ERROR") blockers.push("bin_guardian: data source unreachable");
  if (tenure.color === "ERROR") blockers.push("tenure_protector: data source unreachable");
  if (reserve.color === "ERROR") blockers.push("sbtc_reserve: data source unreachable");

  if (blockers.length > 0) {
    return {
      decision: "DEGRADED",
      reason: `Cannot make decision — ${blockers.length} signal(s) unavailable. Fix data sources before retrying.`,
      blockers,
      retryAfter: null,
    };
  }

  // No rebalance needed → IN_RANGE
  if (!bin.needs_rebalance) {
    return {
      decision: "IN_RANGE",
      reason: bin.in_range === null
        ? `No HODLMM position found for this wallet on pool ${bin.pool_id}. Deploy liquidity first.`
        : `Position in range at active bin ${bin.active_bin}. No rebalance needed. APR: ${bin.apr_24h_pct.toFixed(2)}%.`,
      blockers: [],
      retryAfter: null,
    };
  }

  // Rebalance needed — check safety signals
  const yellowCount = [tenure.color, reserve.color].filter(c => c === "YELLOW").length;

  // Any RED → BLOCKED
  if (tenure.color === "RED") {
    const retryS = Math.max(30, tenure.predicted_next_block_s - tenure.tenure_age_s);
    const retryAt = new Date(Date.now() + retryS * 1000).toISOString();
    blockers.push(`tenure_protector: ${tenure.risk_level} — tenure stale (${(tenure.tenure_age_s / 60).toFixed(1)}m), prices unreliable`);
    return {
      decision: "BLOCKED",
      reason: `Rebalance needed but blocked — tenure stale (${(tenure.tenure_age_s / 60).toFixed(1)}m). Executing at stale prices risks adverse fill. Wait for fresh Bitcoin block.`,
      blockers,
      retryAfter: retryAt,
    };
  }

  if (reserve.color === "RED") {
    // Structural wait — sBTC peg issue, longer recovery
    const retryAt = new Date(Date.now() + 3600 * 1000).toISOString();
    blockers.push(`sbtc_reserve: RED — reserve ratio ${reserve.reserve_ratio?.toFixed(4) ?? "unknown"}, peg unhealthy`);
    return {
      decision: "BLOCKED",
      reason: `Rebalance needed but blocked — sBTC peg unhealthy (ratio: ${reserve.reserve_ratio?.toFixed(4) ?? "unknown"}). Moving capital during de-peg risks value loss. Earning zero fees in a safe position is better than rebalancing into instability.`,
      blockers,
      retryAfter: retryAt,
    };
  }

  // Double YELLOW → BLOCKED (environment degrading on multiple fronts)
  if (yellowCount >= 2) {
    const retryS = Math.max(60, tenure.predicted_next_block_s - tenure.tenure_age_s);
    const retryAt = new Date(Date.now() + retryS * 1000).toISOString();
    blockers.push("tenure_protector: YELLOW — tenure aging");
    blockers.push("sbtc_reserve: YELLOW — reserve slightly below 1:1");
    return {
      decision: "BLOCKED",
      reason: "Rebalance needed but two caution signals active simultaneously. One YELLOW is acceptable risk; two means the environment is degrading on multiple fronts. Wait until at least one clears to GREEN.",
      blockers,
      retryAfter: retryAt,
    };
  }

  // All clear (all GREEN, or one YELLOW + rest GREEN) → REBALANCE
  const safetyNote = yellowCount === 1
    ? ` (one signal at YELLOW — acceptable risk)`
    : "";
  return {
    decision: "REBALANCE",
    reason: `All signals aligned${safetyNote}. Bins out of range (active: ${bin.active_bin}, position: ${bin.user_bin_range?.min ?? "?"}–${bin.user_bin_range?.max ?? "?"}). Safe to rebalance.`,
    blockers: [],
    retryAfter: null,
  };
}

// ── Check data freshness ───────────────────────────────────────────────────────

function checkStaleness(tenure: TenureSignal): { stale: boolean; note: string } {
  // If stacks tip is more than 5 minutes behind wall clock, data might be stale
  // We approximate this by checking if tenure_age_s is unreasonably large
  if (tenure.tenure_age_s > 7200) {
    return { stale: true, note: "Tenure age >2h — Hiro API may be returning stale block data" };
  }
  return { stale: false, note: "" };
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  const checks: DoctorCheck[] = [];

  // 1. Bitflow Quotes API (pools)
  try {
    const data = await fetchJson<{ pools?: QuotesPool[] }>(`${BITFLOW_BASE}/api/quotes/v1/pools`);
    const poolCount = data.pools?.length ?? 0;
    checks.push({ name: "Bitflow Quotes API", ok: poolCount > 0, detail: `${poolCount} pools` });
  } catch (e: unknown) {
    checks.push({ name: "Bitflow Quotes API", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 2. Bitflow App API (TVL, volume)
  try {
    const data = await fetchJson<{ data?: AppPool[] }>(`${BITFLOW_BASE}/api/app/v1/pools`);
    const poolCount = data.data?.length ?? 0;
    checks.push({ name: "Bitflow App API", ok: poolCount > 0, detail: `${poolCount} pools with stats` });
  } catch (e: unknown) {
    checks.push({ name: "Bitflow App API", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 3. Bitflow Bins API
  try {
    const data = await fetchJson<BinsResponse>(`${BITFLOW_BASE}/api/quotes/v1/bins/dlmm_1`);
    checks.push({ name: "Bitflow Bins API", ok: (data.active_bin_id ?? 0) > 0, detail: `active_bin=${data.active_bin_id}, ${data.bins?.length ?? 0} bins` });
  } catch (e: unknown) {
    checks.push({ name: "Bitflow Bins API", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 4. Hiro Stacks API (node info + blocks)
  try {
    const info = await fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(`${HIRO_BASE}/v2/info`);
    checks.push({ name: "Hiro Stacks API", ok: info.stacks_tip_height > 0, detail: `stacks=${info.stacks_tip_height}, btc=${info.burn_block_height}` });
  } catch (e: unknown) {
    checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 5. Hiro Burn Blocks
  try {
    const data = await fetchJson<{ results: { burn_block_height: number }[] }>(`${HIRO_BASE}/extended/v2/burn-blocks?limit=1`);
    checks.push({ name: "Hiro Burn Blocks", ok: data.results?.length > 0, detail: `latest: ${data.results?.[0]?.burn_block_height ?? "none"}` });
  } catch (e: unknown) {
    checks.push({ name: "Hiro Burn Blocks", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 6. sBTC Supply (Clarity contract read)
  try {
    const [addr, cname] = SBTC_CONTRACT.split(".");
    const res = await fetchJson<{ okay: boolean }>(`${HIRO_BASE}/v2/contracts/call-read/${addr}/${cname}/get-total-supply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: addr, arguments: [] }),
    });
    checks.push({ name: "sBTC Supply Contract", ok: res.okay, detail: res.okay ? "contract callable" : "call failed" });
  } catch (e: unknown) {
    checks.push({ name: "sBTC Supply Contract", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 7. Mempool.space (BTC reserve balance)
  try {
    await fetchJson<{ fastestFee: number }>(`${MEMPOOL_BASE}/v1/fees/recommended`);
    checks.push({ name: "mempool.space", ok: true, detail: "reachable" });
  } catch (e: unknown) {
    checks.push({ name: "mempool.space", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  const allOk = checks.every(c => c.ok);
  const noneOk = checks.every(c => !c.ok);

  const result: DoctorResult = {
    status: noneOk ? "error" : allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All 7 data sources reachable. Arbiter ready — all 3 signals operational."
      : noneOk
        ? "All data sources unreachable. Check network connectivity."
        : `Some sources degraded: ${checks.filter(c => !c.ok).map(c => c.name).join(", ")}`,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(allOk ? 0 : noneOk ? 3 : 1);
}

async function runArbiter(opts: { wallet: string; pool: string }): Promise<void> {
  const wallet = opts.wallet;
  const poolId = opts.pool;

  if (!/^SP[A-Z0-9]{30,}$/.test(wallet)) {
    console.log(JSON.stringify({
      status: "error",
      decision: "DEGRADED",
      reason: "Invalid wallet address. Must be a Stacks mainnet address (SP...).",
      signals: { bin_guardian: { color: "ERROR" }, tenure_protector: { color: "ERROR" }, sbtc_reserve: { color: "ERROR" } },
      blockers: ["invalid_wallet"],
      retry_after: null,
      pool_id: poolId,
      wallet,
      timestamp: new Date().toISOString(),
      error: "INVALID_WALLET",
    }, null, 2));
    process.exit(1);
    return;
  }

  // Fetch all 3 signals in parallel
  const [binSignal, tenureSignal, reserveSignal] = await Promise.all([
    fetchBinGuardianSignal(wallet, poolId),
    fetchTenureSignal(),
    fetchReserveSignal(),
  ]);

  // Check for stale data
  const staleness = checkStaleness(tenureSignal);
  if (staleness.stale && tenureSignal.color !== "ERROR") {
    tenureSignal.color = "YELLOW";
    tenureSignal.risk_level = "STALE_DATA";
  }

  // Run decision gate
  const { decision, reason, blockers, retryAfter } = arbiterDecision(binSignal, tenureSignal, reserveSignal);

  // Determine overall status
  const errorCount = [binSignal.color, tenureSignal.color, reserveSignal.color].filter(c => c === "ERROR").length;
  const status: ArbiterResult["status"] = errorCount > 0 ? "degraded" : "ok";

  const result: ArbiterResult = {
    status,
    decision,
    reason,
    signals: {
      bin_guardian: binSignal,
      tenure_protector: tenureSignal,
      sbtc_reserve: reserveSignal,
    },
    blockers,
    retry_after: retryAfter,
    pool_id: poolId,
    wallet,
    timestamp: new Date().toISOString(),
    error: null,
  };

  console.log(JSON.stringify(result, null, 2));

  if (decision === "DEGRADED") process.exit(3);
  if (decision === "BLOCKED") process.exit(1);
  process.exit(0);
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-rebalance-arbiter")
  .description("Decision gate for HODLMM LP rebalancing — consumes 3 signals, outputs GO or WAIT")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify all data sources across all 3 signals are reachable")
  .action(runDoctor);

program
  .command("install-packs")
  .description("No additional packs required")
  .action(() => {
    console.log(JSON.stringify({
      status: "ok",
      message: "No packs required. Uses native fetch for Bitflow, Hiro, and mempool.space APIs.",
    }));
  });

program
  .command("run")
  .description("Evaluate all 3 signals and output rebalance decision")
  .requiredOption("--wallet <address>", "Stacks mainnet wallet address (SP...)")
  .option("--pool <id>", "HODLMM pool ID", "dlmm_1")
  .action(runArbiter);

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(JSON.stringify({ error: msg }));
    process.exit(3);
  });
}
