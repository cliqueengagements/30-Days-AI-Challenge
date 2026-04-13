#!/usr/bin/env bun
/**
 * sbtc-capital-allocator — Multi-protocol sBTC yield router.
 *
 * Compares real-time APY across HODLMM pools and Zest lending, with DCA
 * execution mode triggered by risk signals. Detects stale pricing via Pyth
 * oracle, monitors LP range drift, tracks whale repositioning via mempool,
 * and routes capital to the highest risk-adjusted yield.
 *
 * Commands:
 *   install-packs       — install @stacks/transactions, @stacks/network, commander
 *   doctor              — pre-flight checks (wallet, APIs, oracles, mempool)
 *   scan                — live APY across HODLMM + Zest, normalised to annual %
 *   monitor             — oracle price gate, range drift, whale signals
 *   recommend           — two-layer decision: WHERE (protocol) + HOW (lump_sum/dca)
 *   execute             — move capital (requires --confirm)
 *
 * Output: JSON { status, action, data, error }
 */

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  principalCV,
  contractPrincipalCV,
  fetchCallReadOnlyFunction,
  cvToJSON,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ── Constants ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
const HIRO_API = "https://api.mainnet.hiro.so";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const PYTH_HERMES_API = "https://hermes.pyth.network";

const PYTH_BTC_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_FT_KEY = `${SBTC_TOKEN}::sbtc-token`;

// Zest Protocol v2 contracts
const ZEST_POOL_BORROW = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";

// HODLMM pools (sBTC pairs) — contracts verified in knowledge-base.md
const HODLMM_SBTC_POOLS = ["dlmm_1", "dlmm_2", "dlmm_6"] as const;
const HODLMM_POOL_CONTRACTS: Record<string, string> = {
  dlmm_1: "dlmm-pool-sbtc-usdcx-v-1-bps-10",
  dlmm_2: "dlmm-pool-sbtc-usdcx-v-1-bps-1",
  dlmm_6: "dlmm-pool-stx-sbtc-v-1-bps-15",
};

// Safety limits
const MAX_EXECUTE_SBTC_SATS = 500_000;   // 0.005 BTC max per execute
const MIN_STX_GAS_USTX = 100_000n;       // 0.1 STX minimum for gas
const MIN_SBTC_RESERVE_SATS = 10_000n;   // 0.0001 BTC always kept in wallet
const STALE_PRICE_THRESHOLD_PCT = 2.0;   // >2% oracle vs pool divergence = stale
const RANGE_DRIFT_WARN_BINS = 3;         // warn if position within 3 bins of edge
const MAX_TVL_IMPACT_PCT = 5.0;          // block if deploy amount > 5% of pool TVL
const MIN_POOL_TVL_USD = 10_000;         // skip pools below $10K TVL entirely
const EXECUTE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between executes
const MAX_SANE_APY = 500;                // reject APY above this as suspicious
const DCA_INTERVALS = 5;                 // split into 5 chunks when DCA mode triggers
const ORACLE_DIVERGENCE_DCA_PCT = 1.0;   // >1% oracle divergence = use DCA entry (below 2% stale block)

const STATE_FILE = join(homedir(), ".sbtc-capital-allocator-state.json");
const NULL_SENDER = "SP000000000000000000002Q6VF78";

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface BitflowPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr: number;
  apr24h: number;
  tokens: {
    tokenX: { symbol: string; priceUsd: number; decimals: number };
    tokenY: { symbol: string; priceUsd: number; decimals: number };
  };
}

interface BitflowPoolsResponse {
  data: BitflowPool[];
}

interface BinsResponse {
  active_bin_id: number;
}

interface PositionBin {
  bin_id: number;
  user_liquidity: string | number;
}

interface PositionResponse {
  data: PositionBin[];
}

interface PythPriceData {
  parsed: Array<{
    price: {
      price: string;
      expo: number;
      conf: string;
      publish_time: number;
    };
  }>;
}

interface HiroBalances {
  stx?: { balance: string };
  fungible_tokens?: Record<string, { balance: string }>;
}

interface ProtocolYield {
  protocol: string;
  pool: string;
  apy_pct: number;
  tvl_usd: number;
  volume_24h_usd: number;
  risk_score: number;       // 1 (low) – 5 (high)
  risk_label: string;
  fees_24h_usd: number;
  source: string;
  fee_spike: boolean;       // true if 1-day fees > 3x the 7-day daily average
}

interface OracleCheck {
  pyth_btc_usd: number;
  pyth_publish_age_s: number;
  pool_implied_btc_usd: number;
  divergence_pct: number;
  stale: boolean;
  verdict: string;
}

interface RangeDrift {
  pool_id: string;
  active_bin: number;
  position_bins: number[];
  nearest_edge_distance: number;
  total_bins_held: number;
  drift_risk: "safe" | "warning" | "critical";
}

interface WhaleSignal {
  token: string;
  direction: string;
  usd_value: number;
  timestamp: string;
  relevance: string;
}

interface Recommendation {
  target_protocol: string;
  target_pool: string;
  target_apy_pct: number;
  current_protocol: string | null;
  current_apy_pct: number | null;
  apy_improvement_pct: number | null;
  risk_score: number;
  oracle_safe: boolean;
  whale_pressure: string;
  action: "move" | "stay" | "wait";
  execution_mode: "lump_sum" | "dca";
  dca_intervals: number | null;
  dca_reason: string | null;
  reason: string;
}

interface AllocatorState {
  last_execute_at: string | null;
  last_recommendation: string | null;
  executions_today: number;
  last_date: string;
}

// ── Output helpers ───────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function success(action: string, data: Record<string, unknown>): void {
  out({ status: "success", action, data, error: null });
}

function blocked(code: string, message: string, next: string): void {
  out({ status: "blocked", action: next, data: {}, error: { code, message, next } });
}

function fail(code: string, message: string, next: string): void {
  out({ status: "error", action: next, data: {}, error: { code, message, next } });
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/sbtc-capital-allocator" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}


// ── Balance helpers ──────────────────────────────────────────────────────────

async function getBalances(wallet: string): Promise<{ sbtc_sats: bigint; stx_ustx: bigint }> {
  const data = await fetchJson<HiroBalances>(`${HIRO_API}/extended/v1/address/${wallet}/balances`);
  const ft = data.fungible_tokens ?? {};
  const sbtcRaw = ft[SBTC_FT_KEY]?.balance ?? "0";
  const stxRaw = data.stx?.balance ?? "0";
  return {
    sbtc_sats: BigInt(sbtcRaw),
    stx_ustx: BigInt(stxRaw),
  };
}

function splitContractId(id: string): { address: string; name: string } {
  const [address, name] = id.split(".");
  return { address: address!, name: name! };
}

async function getZestPosition(wallet: string): Promise<{ supplied_sats: bigint }> {
  const { address: poolAddr, name: poolName } = splitContractId(ZEST_POOL_BORROW);
  const { address: sbtcAddr, name: sbtcName } = splitContractId(SBTC_TOKEN);

  try {
    const result = await fetchCallReadOnlyFunction({
      network: STACKS_MAINNET,
      contractAddress: poolAddr,
      contractName: poolName,
      functionName: "get-user-reserve-data",
      functionArgs: [
        principalCV(wallet),
        contractPrincipalCV(sbtcAddr, sbtcName),
      ],
      senderAddress: wallet,
    });

    const json = cvToJSON(result);
    if (json.success && json.value) {
      const val = json.value.value || json.value;
      const supplied = BigInt(val["current-atoken-balance"]?.value || "0");
      return { supplied_sats: supplied };
    }
    return { supplied_sats: 0n };
  } catch {
    return { supplied_sats: 0n };
  }
}

// ── Pyth oracle helpers ──────────────────────────────────────────────────────

async function getPythPrice(feedId: string): Promise<{ price_usd: number; publish_time: number; conf: number }> {
  const data = await fetchJson<PythPriceData>(
    `${PYTH_HERMES_API}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`
  );
  const entry = data.parsed?.[0];
  if (!entry) throw new Error(`No Pyth data for feed ${feedId}`);
  const price = parseFloat(entry.price.price) * Math.pow(10, entry.price.expo);
  const conf = parseFloat(entry.price.conf) * Math.pow(10, entry.price.expo);
  return { price_usd: price, publish_time: entry.price.publish_time, conf };
}

// ── Bitflow pool helpers ─────────────────────────────────────────────────────

async function getAllPools(): Promise<BitflowPool[]> {
  const data = await fetchJson<BitflowPoolsResponse>(`${BITFLOW_APP_API}/pools`);
  return data.data ?? [];
}

async function getActiveBin(poolId: string): Promise<number> {
  const data = await fetchJson<BinsResponse>(`${BITFLOW_QUOTES_API}/bins/${poolId}`);
  return data.active_bin_id;
}

async function getPositionBins(wallet: string, poolId: string): Promise<PositionBin[]> {
  const data = await fetchJson<PositionResponse>(
    `${BITFLOW_APP_API}/users/${wallet}/positions/${poolId}/bins`
  );
  return (data.data ?? []).filter(b => {
    const liq = typeof b.user_liquidity === "number"
      ? b.user_liquidity
      : parseFloat(String(b.user_liquidity ?? "0"));
    return liq > 0;
  });
}

// ── Whale tracking via mempool ───────────────────────────────────────────────

// Contracts that indicate whale repositioning when seen in mempool
const WHALE_CONTRACTS = [
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1",
  ZEST_POOL_BORROW,
  SBTC_TOKEN,
] as const;

const WHALE_FUNCTIONS: Record<string, string> = {
  "withdraw-liquidity-multi": "sell",
  "add-liquidity-multi": "buy",
  "move-relative-liquidity-multi": "reposition",
  "supply": "buy",
  "withdraw": "sell",
  "borrow": "sell",
  "repay": "buy",
  "transfer": "transfer",
};

interface MempoolTx {
  tx_type: string;
  sender_address: string;
  contract_call?: {
    contract_id: string;
    function_name: string;
  };
  token_transfer?: {
    recipient_address: string;
    amount: string;
  };
}

interface MempoolResponse {
  total: number;
  results: MempoolTx[];
}

async function getWhaleSignals(limit: number = 50): Promise<WhaleSignal[]> {
  // Scan Stacks mempool for large sBTC-related pending transactions
  // This catches repositioning BEFORE it settles on-chain
  try {
    const data = await fetchJson<MempoolResponse>(
      `${HIRO_API}/extended/v1/tx/mempool?limit=${limit}`
    );

    const signals: WhaleSignal[] = [];
    for (const tx of data.results ?? []) {
      if (tx.tx_type === "contract_call" && tx.contract_call) {
        const contractId = tx.contract_call.contract_id;
        const fn = tx.contract_call.function_name;

        // Check if this is a whale-relevant contract
        const isRelevant = WHALE_CONTRACTS.some(c => contractId.startsWith(c.split(".")[0]!) && contractId.includes(c.split(".")[1]!));
        if (!isRelevant) continue;

        const direction = WHALE_FUNCTIONS[fn] ?? "unknown";
        const isBtcRelated = contractId.includes("sbtc") || contractId.includes("dlmm") || contractId.includes("pool-borrow");

        signals.push({
          token: contractId.includes("dlmm") ? "HODLMM-LP" : contractId.includes("pool-borrow") ? "Zest" : "sBTC",
          direction,
          usd_value: 0, // mempool doesn't expose value — the signal is the action itself
          timestamp: new Date().toISOString(),
          relevance: isBtcRelated ? "direct" : "indirect",
        });
      }
    }
    return signals;
  } catch {
    return [];
  }
}

// ── APY computation ──────────────────────────────────────────────────────────

function computeHodlmmApy(pool: BitflowPool): number {
  // 7-day smoothed: (feesUsd7d / 7) / tvlUsd * 365
  // More reliable than 1-day because feesUsd1d were earned against an unknown
  // intra-day TVL, not today's snapshot.
  if (pool.tvlUsd <= 0) return 0;
  const dailyAvgFees7d = pool.feesUsd7d / 7;
  const apy = (dailyAvgFees7d / pool.tvlUsd) * 365 * 100;
  return sanitiseApy(apy, `HODLMM ${pool.poolId}`);
}

function detectFeeSpike(pool: BitflowPool): boolean {
  // 1-day fees > 3x the 7-day daily average = spike
  const dailyAvg7d = pool.feesUsd7d / 7;
  if (dailyAvg7d <= 0) return false;
  return pool.feesUsd1d > dailyAvg7d * 3;
}

function computeHodlmmApyFromApi(pool: BitflowPool): number {
  // Both signals use the same time window for a real cross-validation:
  //   1. Our computed: 7-day smoothed from feesUsd7d / tvlUsd
  //   2. API full-period apr: Bitflow's own `apr` (longer-term, not the 24h spike)
  // If they agree within 30%, trust our computed value.
  // If they diverge >30%, something is off — use the lower as conservative.
  const computed = computeHodlmmApy(pool);
  const apiApr = sanitiseApy(pool.apr, `HODLMM-API ${pool.poolId}`);

  if (computed <= 0) return apiApr;
  if (apiApr <= 0) return computed;

  const ratio = Math.abs(computed - apiApr) / Math.max(computed, apiApr);
  if (ratio > 0.3) {
    // >30% divergence between our 7d calc and Bitflow's full-period rate
    // Something is off — take the conservative (lower) value
    return Math.min(computed, apiApr);
  }
  return computed;
}

async function getZestApyFromChain(): Promise<number> {
  // Read current-liquidity-rate from Zest pool-borrow-v2-3
  // Annualized rate in 1e6 precision (e.g. 163457 = 0.16% APY)
  const { address: poolAddr, name: poolName } = splitContractId(ZEST_POOL_BORROW);
  const { address: sbtcAddr, name: sbtcName } = splitContractId(SBTC_TOKEN);

  try {
    const result = await fetchCallReadOnlyFunction({
      network: STACKS_MAINNET,
      contractAddress: poolAddr,
      contractName: poolName,
      functionName: "get-reserve-state",
      functionArgs: [
        contractPrincipalCV(sbtcAddr, sbtcName),
      ],
      senderAddress: NULL_SENDER,
    });

    const json = cvToJSON(result);
    if (json.success && json.value) {
      const val = json.value.value || json.value;
      // current-liquidity-rate is annualized, 1e8 precision
      // e.g. 163457 = 0.16% APY (borrow_rate * utilization)
      const rateRaw = BigInt(val["current-liquidity-rate"]?.value || "0");
      const apyPct = Number(rateRaw) / 1e6;
      return sanitiseApy(apyPct, "Zest sBTC");
    }
    return 0;
  } catch {
    return 0;
  }
}

function sanitiseApy(raw: number, label: string): number {
  if (!isFinite(raw) || raw < 0) return 0;
  if (raw > MAX_SANE_APY) throw new Error(`${label} APY ${raw.toFixed(2)}% exceeds sanity cap ${MAX_SANE_APY}%`);
  return parseFloat(raw.toFixed(2));
}

// ── Risk scoring ─────────────────────────────────────────────────────────────

function hodlmmRiskScore(pool: BitflowPool): number {
  // Higher risk: impermanent loss, active management needed
  // Lower TVL = higher risk
  if (pool.tvlUsd < 50_000) return 5;
  if (pool.tvlUsd < 200_000) return 4;
  return 3;
}

function zestRiskScore(): number {
  // Lending: lower risk than LP, but smart contract risk exists
  return 2;
}

// ── State management ─────────────────────────────────────────────────────────

function loadState(): AllocatorState {
  const today = new Date().toISOString().slice(0, 10);
  const defaults: AllocatorState = {
    last_execute_at: null,
    last_recommendation: null,
    executions_today: 0,
    last_date: today,
  };
  if (!existsSync(STATE_FILE)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as AllocatorState;
    // Reset daily counter if date changed
    if (raw.last_date !== today) {
      raw.executions_today = 0;
      raw.last_date = today;
    }
    return raw;
  } catch {
    return defaults;
  }
}

function saveState(state: AllocatorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(wallet: string): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Wallet balance
  try {
    const bal = await getBalances(wallet);
    const sbtcHuman = Number(bal.sbtc_sats) / 1e8;
    const stxHuman = Number(bal.stx_ustx) / 1e6;
    checks.push({
      name: "wallet",
      ok: bal.stx_ustx >= MIN_STX_GAS_USTX,
      detail: `sBTC: ${sbtcHuman.toFixed(8)}, STX: ${stxHuman.toFixed(6)}${bal.stx_ustx < MIN_STX_GAS_USTX ? " — insufficient gas" : ""}`,
    });
  } catch (e) {
    checks.push({ name: "wallet", ok: false, detail: `Failed: ${(e as Error).message}` });
  }

  // 2. Bitflow API
  try {
    const pools = await getAllPools();
    const sbtcPools = pools.filter(p => HODLMM_SBTC_POOLS.includes(p.poolId as typeof HODLMM_SBTC_POOLS[number]));
    checks.push({ name: "bitflow_api", ok: sbtcPools.length > 0, detail: `${sbtcPools.length} sBTC HODLMM pools found` });
  } catch (e) {
    checks.push({ name: "bitflow_api", ok: false, detail: `Failed: ${(e as Error).message}` });
  }

  // 3. Zest on-chain
  try {
    const pos = await getZestPosition(wallet);
    checks.push({
      name: "zest_onchain",
      ok: true,
      detail: `Supplied (zsBTC): ${Number(pos.supplied_sats) / 1e8} sBTC`,
    });
  } catch (e) {
    checks.push({ name: "zest_onchain", ok: false, detail: `Failed: ${(e as Error).message}` });
  }

  // 4. Pyth oracle
  try {
    const btc = await getPythPrice(PYTH_BTC_FEED);
    const ageS = Math.floor(Date.now() / 1000) - btc.publish_time;
    checks.push({
      name: "pyth_oracle",
      ok: ageS < 120,
      detail: `BTC: $${btc.price_usd.toFixed(2)}, age: ${ageS}s${ageS >= 120 ? " — STALE" : ""}`,
    });
  } catch (e) {
    checks.push({ name: "pyth_oracle", ok: false, detail: `Failed: ${(e as Error).message}` });
  }

  // 5. Mempool whale scan
  try {
    const whales = await getWhaleSignals(5);
    checks.push({ name: "mempool_whale_scan", ok: true, detail: `${whales.length} whale signals in mempool` });
  } catch (e) {
    checks.push({ name: "mempool_whale_scan", ok: false, detail: `Failed: ${(e as Error).message}` });
  }

  const allOk = checks.every(c => c.ok);
  success("doctor", {
    ready: allOk,
    checks,
    wallet,
    network: "mainnet",
  });
}

async function cmdScan(wallet: string): Promise<void> {
  const yields: ProtocolYield[] = [];

  // 1. HODLMM pools — real APY from fees/TVL
  try {
    const pools = await getAllPools();
    for (const pool of pools) {
      if (!HODLMM_SBTC_POOLS.includes(pool.poolId as typeof HODLMM_SBTC_POOLS[number])) continue;
      if (pool.tvlUsd < MIN_POOL_TVL_USD) continue; // skip micro-pools

      const apy = computeHodlmmApyFromApi(pool);
      yields.push({
        protocol: "hodlmm",
        pool: pool.poolId,
        apy_pct: apy,
        tvl_usd: pool.tvlUsd,
        volume_24h_usd: pool.volumeUsd1d,
        fees_24h_usd: pool.feesUsd1d,
        risk_score: hodlmmRiskScore(pool),
        risk_label: pool.tvlUsd < 50_000 ? "high" : pool.tvlUsd < 200_000 ? "medium" : "moderate",
        source: "bitflow_api_live",
        fee_spike: detectFeeSpike(pool),
      });
    }
  } catch (e) {
    fail("bitflow_error", `Failed to fetch HODLMM pools: ${(e as Error).message}`, "check bitflow API");
    return;
  }

  // 2. Zest lending — on-chain rate
  try {
    const zestApy = await getZestApyFromChain();
    yields.push({
      protocol: "zest",
      pool: "sbtc-lending",
      apy_pct: zestApy,
      tvl_usd: 0, // Would need separate TVL query
      volume_24h_usd: 0,
      fees_24h_usd: 0,
      risk_score: zestRiskScore(),
      risk_label: "low",
      source: "onchain_read",
      fee_spike: false,
    });
  } catch (e) {
    fail("zest_error", `Failed to read Zest rate: ${(e as Error).message}`, "check Hiro API");
    return;
  }

  // Sort by APY descending
  yields.sort((a, b) => b.apy_pct - a.apy_pct);

  // Current wallet position
  let currentPosition: Record<string, unknown> = {};
  try {
    const bal = await getBalances(wallet);
    const zestPos = await getZestPosition(wallet);
    currentPosition = {
      wallet_sbtc_sats: Number(bal.sbtc_sats),
      wallet_sbtc_btc: Number(bal.sbtc_sats) / 1e8,
      zest_supplied_sats: Number(zestPos.supplied_sats),
      zest_supplied_btc: Number(zestPos.supplied_sats) / 1e8,
    };
  } catch { /* non-fatal */ }

  success("scan", {
    yields,
    best: yields[0] ? {
      protocol: yields[0].protocol,
      pool: yields[0].pool,
      apy_pct: yields[0].apy_pct,
    } : null,
    current_position: currentPosition,
    scanned_at: new Date().toISOString(),
  });
}

async function cmdMonitor(wallet: string): Promise<void> {
  // 1. Oracle price check — Pyth vs HODLMM pool implied price
  let oracle: OracleCheck | null = null;
  try {
    const pythBtc = await getPythPrice(PYTH_BTC_FEED);
    const ageS = Math.floor(Date.now() / 1000) - pythBtc.publish_time;

    // Get pool implied price from dlmm_1 (sBTC/USDCx)
    let poolImpliedPrice = 0;
    try {
      const pools = await getAllPools();
      const dlmm1 = pools.find(p => p.poolId === "dlmm_1");
      if (dlmm1 && dlmm1.tokens?.tokenX?.priceUsd) {
        poolImpliedPrice = dlmm1.tokens.tokenX.priceUsd;
      }
    } catch { /* use 0 = unknown */ }

    const divergence = poolImpliedPrice > 0
      ? Math.abs(pythBtc.price_usd - poolImpliedPrice) / pythBtc.price_usd * 100
      : 0;

    oracle = {
      pyth_btc_usd: parseFloat(pythBtc.price_usd.toFixed(2)),
      pyth_publish_age_s: ageS,
      pool_implied_btc_usd: parseFloat(poolImpliedPrice.toFixed(2)),
      divergence_pct: parseFloat(divergence.toFixed(3)),
      stale: divergence > STALE_PRICE_THRESHOLD_PCT || ageS > 120,
      verdict: divergence > STALE_PRICE_THRESHOLD_PCT
        ? `STALE — ${divergence.toFixed(2)}% divergence exceeds ${STALE_PRICE_THRESHOLD_PCT}% threshold`
        : ageS > 120
          ? `STALE — Pyth data is ${ageS}s old`
          : "FRESH — prices aligned",
    };
  } catch (e) {
    oracle = {
      pyth_btc_usd: 0,
      pyth_publish_age_s: -1,
      pool_implied_btc_usd: 0,
      divergence_pct: 0,
      stale: true,
      verdict: `UNAVAILABLE — ${(e as Error).message}`,
    };
  }

  // 2. Range drift — check LP position proximity to edge
  const rangeDrifts: RangeDrift[] = [];
  for (const poolId of HODLMM_SBTC_POOLS) {
    try {
      const [activeBin, positionBins] = await Promise.all([
        getActiveBin(poolId),
        getPositionBins(wallet, poolId),
      ]);

      if (positionBins.length === 0) continue;

      const binIds = positionBins.map(b => b.bin_id);
      const minBin = Math.min(...binIds);
      const maxBin = Math.max(...binIds);
      const nearestEdge = Math.min(
        Math.abs(activeBin - minBin),
        Math.abs(activeBin - maxBin),
      );

      let driftRisk: RangeDrift["drift_risk"] = "safe";
      if (activeBin < minBin || activeBin > maxBin) driftRisk = "critical";
      else if (nearestEdge <= RANGE_DRIFT_WARN_BINS) driftRisk = "warning";

      rangeDrifts.push({
        pool_id: poolId,
        active_bin: activeBin,
        position_bins: binIds,
        nearest_edge_distance: nearestEdge,
        total_bins_held: binIds.length,
        drift_risk: driftRisk,
      });
    } catch { /* pool not available or no position */ }
  }

  // 3. Whale signals — recent large sBTC/STX trades
  const whaleSignals = await getWhaleSignals(20);
  const sbtcWhales = whaleSignals.filter(w => w.relevance === "direct");
  const netWhaleDirection = sbtcWhales.length > 0
    ? sbtcWhales.filter(w => w.direction === "buy").length > sbtcWhales.filter(w => w.direction === "sell").length
      ? "net_buying"
      : "net_selling"
    : "neutral";

  success("monitor", {
    oracle,
    range_drift: rangeDrifts,
    whale_signals: {
      total: whaleSignals.length,
      sbtc_relevant: sbtcWhales.length,
      net_direction: netWhaleDirection,
      recent: sbtcWhales.slice(0, 5),
    },
    monitored_at: new Date().toISOString(),
    safe_to_execute: oracle ? !oracle.stale : false,
  });
}

async function cmdRecommend(wallet: string): Promise<void> {
  // Gather all data in parallel
  const [scanResult, oracleResult, whaleResult] = await Promise.all([
    (async () => {
      const yields: ProtocolYield[] = [];
      const pools = await getAllPools();
      for (const pool of pools) {
        if (!HODLMM_SBTC_POOLS.includes(pool.poolId as typeof HODLMM_SBTC_POOLS[number])) continue;
        if (pool.tvlUsd < MIN_POOL_TVL_USD) continue;
        yields.push({
          protocol: "hodlmm",
          pool: pool.poolId,
          apy_pct: computeHodlmmApyFromApi(pool),
          tvl_usd: pool.tvlUsd,
          volume_24h_usd: pool.volumeUsd1d,
          fees_24h_usd: pool.feesUsd1d,
          risk_score: hodlmmRiskScore(pool),
          risk_label: pool.tvlUsd < 50_000 ? "high" : "moderate",
          source: "bitflow_api_live",
          fee_spike: detectFeeSpike(pool),
        });
      }
      const zestApy = await getZestApyFromChain();
      yields.push({
        protocol: "zest",
        pool: "sbtc-lending",
        apy_pct: zestApy,
        tvl_usd: 0,
        volume_24h_usd: 0,
        fees_24h_usd: 0,
        risk_score: zestRiskScore(),
        risk_label: "low",
        source: "onchain_read",
        fee_spike: false,
      });
      return yields;
    })(),
    (async () => {
      try {
        const pyth = await getPythPrice(PYTH_BTC_FEED);
        const ageS = Math.floor(Date.now() / 1000) - pyth.publish_time;
        const pools = await getAllPools();
        const dlmm1 = pools.find(p => p.poolId === "dlmm_1");
        const poolPrice = dlmm1?.tokens?.tokenX?.priceUsd ?? 0;
        const div = poolPrice > 0 ? Math.abs(pyth.price_usd - poolPrice) / pyth.price_usd * 100 : 0;
        return { stale: div > STALE_PRICE_THRESHOLD_PCT || ageS > 120, divergence: div };
      } catch {
        return { stale: true, divergence: -1 };
      }
    })(),
    getWhaleSignals(20),
  ]);

  // Risk-adjusted APY: apy / risk_score
  const ranked = scanResult
    .map(y => ({ ...y, risk_adjusted_apy: y.apy_pct / y.risk_score }))
    .sort((a, b) => b.risk_adjusted_apy - a.risk_adjusted_apy);

  const best = ranked[0];
  if (!best) {
    fail("no_yields", "No yield data available", "run scan to check API connectivity");
    return;
  }

  // Determine current allocation
  let currentProtocol: string | null = null;
  let currentApy: number | null = null;
  try {
    const zestPos = await getZestPosition(wallet);
    if (zestPos.supplied_sats > 0n) {
      currentProtocol = "zest";
      currentApy = ranked.find(r => r.protocol === "zest")?.apy_pct ?? null;
    }
  } catch { /* no current position */ }

  // Check HODLMM positions
  for (const poolId of HODLMM_SBTC_POOLS) {
    try {
      const bins = await getPositionBins(wallet, poolId);
      if (bins.length > 0) {
        currentProtocol = "hodlmm";
        currentApy = ranked.find(r => r.pool === poolId)?.apy_pct ?? null;
        break;
      }
    } catch { /* skip */ }
  }

  // Whale pressure
  const sbtcWhales = whaleResult.filter(w => w.relevance === "direct");
  const whalePressure = sbtcWhales.length === 0 ? "neutral"
    : sbtcWhales.filter(w => w.direction === "sell").length > sbtcWhales.filter(w => w.direction === "buy").length
      ? "sell_pressure" : "buy_pressure";

  // Decision: WHERE to deploy
  let action: Recommendation["action"] = "stay";
  let reason = "";

  if (oracleResult.stale) {
    action = "wait";
    reason = `Oracle price is stale (${oracleResult.divergence.toFixed(2)}% divergence) — unsafe to commit capital`;
  } else if (currentProtocol && currentApy !== null) {
    const improvement = best.apy_pct - currentApy;
    if (best.protocol === currentProtocol && best.pool === (currentProtocol === "hodlmm" ? best.pool : "sbtc-lending")) {
      action = "stay";
      reason = `Already in the highest risk-adjusted yield (${best.protocol}/${best.pool} at ${best.apy_pct}%)`;
    } else if (improvement > 2.0) {
      action = "move";
      reason = `${best.protocol}/${best.pool} offers ${improvement.toFixed(2)}% higher APY than current ${currentProtocol} (${best.apy_pct}% vs ${currentApy}%)`;
    } else {
      action = "stay";
      reason = `APY improvement (${improvement.toFixed(2)}%) below 2% threshold — gas cost not justified`;
    }
  } else {
    action = "move";
    reason = `No current position — deploy to ${best.protocol}/${best.pool} at ${best.apy_pct}% APY`;
  }

  // Fee spike = do not move — execute would block anyway
  if (best.fee_spike && action === "move") {
    action = "wait";
    reason = `${best.protocol}/${best.pool} is in a fee spike (1-day fees > 3x 7-day avg) — yield is unsustainable, wait for normalization`;
  }

  // Warn on sell pressure
  if (whalePressure === "sell_pressure" && action === "move" && best.protocol === "hodlmm") {
    reason += `. NOTE: whale sell pressure detected on sBTC — HODLMM LP may face impermanent loss`;
  }

  // Decision: HOW to deploy (lump_sum vs dca)
  // DCA triggers when risk signals suggest gradual entry is safer
  let executionMode: "lump_sum" | "dca" = "lump_sum";
  let dcaIntervals: number | null = null;
  let dcaReason: string | null = null;

  if (action === "move") {
    const riskSignals: string[] = [];

    // Whale pressure = unpredictable market moves
    if (whalePressure !== "neutral") {
      riskSignals.push(`whale ${whalePressure}`);
    }

    // Oracle divergence between 1-2% = price drifting but not stale
    if (oracleResult.divergence > ORACLE_DIVERGENCE_DCA_PCT && !oracleResult.stale) {
      riskSignals.push(`oracle divergence ${oracleResult.divergence.toFixed(2)}%`);
    }

    // Fee spike on any pool = volatile fee environment
    if (ranked.some(y => y.fee_spike)) {
      riskSignals.push("fee spike detected in ecosystem");
    }

    // Target is HODLMM with moderate+ risk = IL exposure
    if (best.protocol === "hodlmm" && best.risk_score >= 4) {
      riskSignals.push(`high risk pool (score ${best.risk_score}/5)`);
    }

    if (riskSignals.length > 0) {
      executionMode = "dca";
      dcaIntervals = DCA_INTERVALS;
      dcaReason = `Risk signals detected: ${riskSignals.join(", ")}. Splitting deployment into ${DCA_INTERVALS} intervals to reduce entry timing risk.`;
    }
  }

  const recommendation: Recommendation = {
    target_protocol: best.protocol,
    target_pool: best.pool,
    target_apy_pct: best.apy_pct,
    current_protocol: currentProtocol,
    current_apy_pct: currentApy,
    apy_improvement_pct: currentApy !== null ? parseFloat((best.apy_pct - currentApy).toFixed(2)) : null,
    risk_score: best.risk_score,
    oracle_safe: !oracleResult.stale,
    whale_pressure: whalePressure,
    action,
    execution_mode: executionMode,
    dca_intervals: dcaIntervals ?? 0,
    dca_reason: dcaReason ?? "No risk signals — deploying immediately",
    reason,
  };

  const state = loadState();
  state.last_recommendation = new Date().toISOString();
  saveState(state);

  success("recommend", {
    recommendation,
    all_yields: ranked.map(y => ({
      protocol: y.protocol,
      pool: y.pool,
      apy_pct: y.apy_pct,
      risk_adjusted_apy: y.risk_adjusted_apy,
      risk_score: y.risk_score,
    })),
    recommended_at: new Date().toISOString(),
  });
}

async function cmdExecute(wallet: string, confirm: boolean, amount?: string): Promise<void> {
  // Gate: --confirm required
  if (!confirm) {
    // Dry run — preview what would happen, including execution mode
    const state = loadState();

    // Compute risk signals for preview — same checks as confirmed execute
    const previewRiskSignals: string[] = [];
    try {
      const pyth = await getPythPrice(PYTH_BTC_FEED);
      const pools = await getAllPools();
      const dlmm1 = pools.find(p => p.poolId === "dlmm_1");
      const poolPrice = dlmm1?.tokens?.tokenX?.priceUsd ?? 0;
      if (poolPrice > 0) {
        const div = Math.abs(pyth.price_usd - poolPrice) / pyth.price_usd * 100;
        if (div > ORACLE_DIVERGENCE_DCA_PCT) previewRiskSignals.push(`oracle divergence ${div.toFixed(2)}%`);
      }

      // Check pool risk scores
      const sbtcPools = pools.filter(p => HODLMM_SBTC_POOLS.includes(p.poolId as typeof HODLMM_SBTC_POOLS[number]) && p.tvlUsd >= MIN_POOL_TVL_USD);
      const bestPool = sbtcPools.sort((a, b) => computeHodlmmApyFromApi(b) - computeHodlmmApyFromApi(a))[0];
      if (bestPool && hodlmmRiskScore(bestPool) >= 4) {
        previewRiskSignals.push(`high risk pool (score ${hodlmmRiskScore(bestPool)}/5)`);
      }

      // Check fee spikes
      if (sbtcPools.some(p => detectFeeSpike(p))) {
        previewRiskSignals.push("fee spike in ecosystem");
      }
    } catch { /* non-fatal for preview */ }

    success("execute_preview", {
      dry_run: true,
      message: "Add --confirm to execute. This is a preview only.",
      execution_mode: previewRiskSignals.length > 0 ? "dca" : "lump_sum",
      dca_risk_signals: previewRiskSignals.length > 0 ? previewRiskSignals : [],
      dca_risk_checked: true,
      last_execute_at: state.last_execute_at,
      executions_today: state.executions_today,
      max_per_execute_sats: MAX_EXECUTE_SBTC_SATS,
      wallet,
    });
    return;
  }

  // Check cooldown
  const state = loadState();
  if (state.last_execute_at) {
    const elapsed = Date.now() - new Date(state.last_execute_at).getTime();
    if (elapsed < EXECUTE_COOLDOWN_MS) {
      const waitMin = Math.ceil((EXECUTE_COOLDOWN_MS - elapsed) / 60_000);
      blocked("cooldown", `Execute cooldown: ${waitMin} minutes remaining`, "wait and retry");
      return;
    }
  }

  // Check gas
  const bal = await getBalances(wallet);
  if (bal.stx_ustx < MIN_STX_GAS_USTX) {
    blocked("insufficient_gas", `STX balance ${Number(bal.stx_ustx) / 1e6} below minimum ${Number(MIN_STX_GAS_USTX) / 1e6}`, "fund wallet with STX");
    return;
  }

  // Check oracle freshness before any write
  let oracleSafe = false;
  try {
    const pyth = await getPythPrice(PYTH_BTC_FEED);
    const ageS = Math.floor(Date.now() / 1000) - pyth.publish_time;
    const pools = await getAllPools();
    const dlmm1 = pools.find(p => p.poolId === "dlmm_1");
    const poolPrice = dlmm1?.tokens?.tokenX?.priceUsd ?? 0;
    const div = poolPrice > 0 ? Math.abs(pyth.price_usd - poolPrice) / pyth.price_usd * 100 : 0;
    oracleSafe = div <= STALE_PRICE_THRESHOLD_PCT && ageS < 120;
  } catch { /* oracle unavailable = not safe */ }

  if (!oracleSafe) {
    blocked("oracle_stale", "Oracle price is stale or unavailable — refusing to execute", "run monitor to check oracle status");
    return;
  }

  // Determine amount
  const availableSats = bal.sbtc_sats - MIN_SBTC_RESERVE_SATS;
  if (availableSats <= 0n) {
    blocked("insufficient_sbtc", `sBTC balance too low (${Number(bal.sbtc_sats)} sats, reserve: ${Number(MIN_SBTC_RESERVE_SATS)})`, "fund wallet with sBTC");
    return;
  }

  let executeSats: bigint;
  if (amount) {
    executeSats = BigInt(Math.floor(parseFloat(amount) * 1e8));
    if (executeSats > availableSats) {
      blocked("amount_exceeds_balance", `Requested ${amount} BTC but only ${Number(availableSats) / 1e8} available`, "reduce amount");
      return;
    }
  } else {
    executeSats = availableSats > BigInt(MAX_EXECUTE_SBTC_SATS) ? BigInt(MAX_EXECUTE_SBTC_SATS) : availableSats;
  }

  if (executeSats > BigInt(MAX_EXECUTE_SBTC_SATS)) {
    blocked("amount_cap", `Amount ${Number(executeSats)} sats exceeds per-execute cap of ${MAX_EXECUTE_SBTC_SATS} sats`, "reduce amount or split into multiple executes");
    return;
  }

  // Get recommendation to know where to route
  // Inline the recommendation logic
  const pools = await getAllPools();
  const yields: Array<ProtocolYield & { risk_adjusted_apy: number }> = [];

  for (const pool of pools) {
    if (!HODLMM_SBTC_POOLS.includes(pool.poolId as typeof HODLMM_SBTC_POOLS[number])) continue;
    if (pool.tvlUsd < MIN_POOL_TVL_USD) continue;
    const apy = computeHodlmmApyFromApi(pool);
    yields.push({
      protocol: "hodlmm",
      pool: pool.poolId,
      apy_pct: apy,
      tvl_usd: pool.tvlUsd,
      volume_24h_usd: pool.volumeUsd1d,
      fees_24h_usd: pool.feesUsd1d,
      risk_score: hodlmmRiskScore(pool),
      risk_label: "moderate",
      source: "bitflow_api_live",
      fee_spike: detectFeeSpike(pool),
      risk_adjusted_apy: apy / hodlmmRiskScore(pool),
    });
  }

  const zestApy = await getZestApyFromChain();
  yields.push({
    protocol: "zest",
    pool: "sbtc-lending",
    apy_pct: zestApy,
    tvl_usd: 0,
    volume_24h_usd: 0,
    fees_24h_usd: 0,
    risk_score: zestRiskScore(),
    risk_label: "low",
    source: "onchain_read",
    fee_spike: false,
    risk_adjusted_apy: zestApy / zestRiskScore(),
  });

  yields.sort((a, b) => b.risk_adjusted_apy - a.risk_adjusted_apy);
  const target = yields[0];

  if (!target) {
    fail("no_target", "No yield target found", "run scan");
    return;
  }

  // Block execution into a fee spike — yield is likely unsustainable
  if (target.fee_spike) {
    blocked("fee_spike", `${target.protocol}/${target.pool} is in a fee spike (1-day fees > 3x 7-day avg) — refusing to chase unsustainable yield`, "wait for spike to normalize or run recommend to check alternatives");
    return;
  }

  // Block if deploy amount would be too large relative to pool TVL
  if (target.protocol === "hodlmm" && target.tvl_usd > 0) {
    // Estimate deploy value in USD using Pyth BTC price
    let btcPriceUsd = 0;
    try {
      const pyth = await getPythPrice(PYTH_BTC_FEED);
      btcPriceUsd = pyth.price_usd;
    } catch { /* already verified oracle above */ }

    if (btcPriceUsd > 0) {
      const deployUsd = (Number(executeSats) / 1e8) * btcPriceUsd;
      const impactPct = (deployUsd / target.tvl_usd) * 100;
      if (impactPct > MAX_TVL_IMPACT_PCT) {
        blocked("tvl_impact", `Deploy amount ($${deployUsd.toFixed(0)}) is ${impactPct.toFixed(1)}% of pool TVL ($${target.tvl_usd.toFixed(0)}) — exceeds ${MAX_TVL_IMPACT_PCT}% slippage safety limit`, "reduce amount or choose a deeper pool");
        return;
      }
    }
  }

  // Determine execution mode from risk signals (same logic as recommend)
  let executionMode: "lump_sum" | "dca" = "lump_sum";
  let dcaIntervals: number | null = null;
  const riskSignals: string[] = [];

  // Check oracle divergence
  let oracleDivergence = 0;
  try {
    const pyth = await getPythPrice(PYTH_BTC_FEED);
    const pools = await getAllPools();
    const dlmm1 = pools.find(p => p.poolId === "dlmm_1");
    const poolPrice = dlmm1?.tokens?.tokenX?.priceUsd ?? 0;
    if (poolPrice > 0) {
      oracleDivergence = Math.abs(pyth.price_usd - poolPrice) / pyth.price_usd * 100;
    }
  } catch { /* already checked oracle above */ }

  if (oracleDivergence > ORACLE_DIVERGENCE_DCA_PCT) {
    riskSignals.push(`oracle divergence ${oracleDivergence.toFixed(2)}%`);
  }
  if (target.protocol === "hodlmm" && target.risk_score >= 4) {
    riskSignals.push(`high risk pool (score ${target.risk_score}/5)`);
  }
  // Fee spike anywhere in ecosystem
  if (yields.some(y => y.fee_spike)) {
    riskSignals.push("fee spike in ecosystem");
  }

  if (riskSignals.length > 0) {
    executionMode = "dca";
    dcaIntervals = DCA_INTERVALS;
  }

  // Calculate per-interval amount for DCA
  const perIntervalSats = executionMode === "dca"
    ? Math.floor(Number(executeSats) / DCA_INTERVALS)
    : Number(executeSats);

  // Emit MCP commands for the agent to execute
  const mcp_commands: Array<{
    step: number;
    tool: string;
    description: string;
    params: Record<string, unknown>;
    auto_execute: boolean;
  }> = [];

  const deployDesc = executionMode === "dca"
    ? `${perIntervalSats} sats (interval 1/${DCA_INTERVALS}, total ${Number(executeSats)} sats)`
    : `${Number(executeSats)} sats (${(Number(executeSats) / 1e8).toFixed(8)} sBTC)`;

  if (target.protocol === "zest") {
    mcp_commands.push({
      step: 1,
      tool: "zest_supply",
      description: `Supply ${deployDesc} to Zest lending`,
      params: {
        asset: "sbtc",
        amount: perIntervalSats,
      },
      auto_execute: false,
    });
  } else if (target.protocol === "hodlmm") {
    // Compute actual add-liquidity params from live active bin
    // Pool token contracts from knowledge-base.md
    const POOL_TOKENS: Record<string, { x: string; y: string }> = {
      dlmm_1: { x: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", y: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx" },
      dlmm_2: { x: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", y: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx" },
      dlmm_6: { x: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx", y: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token" },
    };

    const poolContract = HODLMM_POOL_CONTRACTS[target.pool];
    const tokens = POOL_TOKENS[target.pool];

    if (!poolContract || !tokens) {
      fail("unknown_pool", `No contract mapping for pool ${target.pool}`, "check knowledge-base.md");
      return;
    }

    // Get active bin to compute offset
    let activeBin = 0;
    try {
      activeBin = await getActiveBin(target.pool);
    } catch (e) {
      fail("bin_error", `Cannot get active bin: ${(e as Error).message}`, "check Bitflow bins API");
      return;
    }

    // Add liquidity at offset 0 (active bin) — single position, simplest entry
    // Safety: min-dlp ≥ 95%, max fees ≤ 5% per knowledge-base.md
    const amount = BigInt(perIntervalSats);
    const minDlp = amount * 95n / 100n;
    const maxFee = amount * 5n / 100n;

    // For sBTC/USDCx pools: deposit sBTC as x-amount at the active bin
    const isXsBtc = target.pool !== "dlmm_6"; // dlmm_6 is STX/sBTC, sBTC is Y
    const xAmount = isXsBtc ? perIntervalSats : 0;
    const yAmount = isXsBtc ? 0 : perIntervalSats;

    mcp_commands.push({
      step: 1,
      tool: "call_contract",
      description: `Add ${deployDesc} to HODLMM pool ${target.pool} at active bin ${activeBin}`,
      params: {
        contractAddress: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD",
        contractName: "dlmm-liquidity-router-v-1-1",
        functionName: "add-relative-liquidity-multi",
        functionArgs: [
          {
            type: "list",
            value: [{
              type: "tuple",
              value: {
                "active-bin-id-offset": { type: "int", value: 0 },
                "x-amount": { type: "uint", value: xAmount },
                "y-amount": { type: "uint", value: yAmount },
                "min-dlp": { type: "uint", value: Number(minDlp) },
                "max-x-liquidity-fee": { type: "uint", value: Number(maxFee) },
                "max-y-liquidity-fee": { type: "uint", value: Number(maxFee) },
                "pool-trait": { type: "principal", value: `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.${poolContract}` },
                "x-token-trait": { type: "principal", value: tokens.x },
                "y-token-trait": { type: "principal", value: tokens.y },
              },
            }],
          },
        ],
        postConditionMode: "allow",
      },
      auto_execute: false,
    });
  }

  // Update state
  state.last_execute_at = new Date().toISOString();
  state.executions_today += 1;
  saveState(state);

  // Build the decision rationale that execute independently verified
  const decision_audit = {
    target_protocol: target.protocol,
    target_pool: target.pool,
    target_apy_pct: target.apy_pct,
    target_risk_adjusted_apy: target.risk_adjusted_apy,
    fee_spike: target.fee_spike,
    oracle_verified: true,
    all_yields: yields.map(y => ({
      protocol: y.protocol,
      pool: y.pool,
      apy_pct: y.apy_pct,
      risk_adjusted_apy: y.risk_adjusted_apy,
      fee_spike: y.fee_spike,
    })),
    last_recommendation_at: state.last_recommendation,
    verified_at: new Date().toISOString(),
  };

  success("execute", {
    target_protocol: target.protocol,
    target_pool: target.pool,
    target_apy_pct: target.apy_pct,
    amount_sats: Number(executeSats),
    amount_btc: Number(executeSats) / 1e8,
    execution_mode: executionMode,
    dca_intervals: dcaIntervals,
    dca_per_interval_sats: executionMode === "dca" ? perIntervalSats : null,
    dca_risk_signals: riskSignals,
    mcp_commands,
    decision_audit,
    cooldown_until: new Date(Date.now() + EXECUTE_COOLDOWN_MS).toISOString(),
    note: executionMode === "dca"
      ? `DCA mode: deploy ${perIntervalSats} sats now (interval 1/${DCA_INTERVALS}). Re-run execute for each subsequent interval. Agent must call mcp_commands[0] to complete this interval.`
      : "Agent must call the MCP tool in mcp_commands[0] to complete execution. auto_execute is false — human approval required.",
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("sbtc-capital-allocator")
  .description("Multi-protocol sBTC yield router — compares HODLMM, Zest, and DCA in real-time");

program
  .command("install-packs")
  .description("Install required npm packages")
  .action(async () => {
    const { execSync } = await import("child_process");
    try {
      execSync("bun add @stacks/transactions @stacks/network commander", { stdio: "inherit" });
      success("install-packs", { installed: ["@stacks/transactions", "@stacks/network", "commander"] });
    } catch (e) {
      fail("install_error", (e as Error).message, "run manually: bun add @stacks/transactions @stacks/network commander");
    }
  });

program
  .command("doctor")
  .description("Pre-flight checks: wallet, APIs, oracles")
  .requiredOption("--wallet <address>", "STX wallet address")
  .action(async (opts: { wallet: string }) => {
    try {
      await cmdDoctor(opts.wallet);
    } catch (e) {
      fail("doctor_error", (e as Error).message, "check network connectivity");
    }
  });

program
  .command("scan")
  .description("Live APY scan across HODLMM, Zest, and DCA")
  .requiredOption("--wallet <address>", "STX wallet address")
  .action(async (opts: { wallet: string }) => {
    try {
      await cmdScan(opts.wallet);
    } catch (e) {
      fail("scan_error", (e as Error).message, "run doctor to check dependencies");
    }
  });

program
  .command("monitor")
  .description("Oracle price gate, LP range drift, whale tracking")
  .requiredOption("--wallet <address>", "STX wallet address")
  .action(async (opts: { wallet: string }) => {
    try {
      await cmdMonitor(opts.wallet);
    } catch (e) {
      fail("monitor_error", (e as Error).message, "run doctor to check dependencies");
    }
  });

program
  .command("recommend")
  .description("Decision function — optimal yield route")
  .requiredOption("--wallet <address>", "STX wallet address")
  .action(async (opts: { wallet: string }) => {
    try {
      await cmdRecommend(opts.wallet);
    } catch (e) {
      fail("recommend_error", (e as Error).message, "run scan to verify data sources");
    }
  });

program
  .command("execute")
  .description("Move capital to highest-yield protocol (requires --confirm)")
  .requiredOption("--wallet <address>", "STX wallet address")
  .option("--confirm", "Execute for real (without this, dry-run only)", false)
  .option("--amount <btc>", "Amount in BTC to deploy (default: available balance up to cap)")
  .action(async (opts: { wallet: string; confirm: boolean; amount?: string }) => {
    try {
      await cmdExecute(opts.wallet, opts.confirm, opts.amount);
    } catch (e) {
      fail("execute_error", (e as Error).message, "run recommend first");
    }
  });

if (import.meta.main) {
  program.parse();
}
