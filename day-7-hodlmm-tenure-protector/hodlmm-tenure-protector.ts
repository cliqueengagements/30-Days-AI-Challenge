#!/usr/bin/env bun
/**
 * hodlmm-tenure-protector — Nakamoto tenure-aware risk monitor for HODLMM LPs.
 *
 * Monitors Bitcoin L1 block timing to detect "stale tenure" windows where
 * HODLMM LPs are exposed to toxic arbitrage flow. During tenure changes,
 * L2 prices can lag L1 reality — informed traders exploit this gap.
 *
 * This skill is the LP's circuit breaker: GREEN when safe, RED when exposed.
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────────────

const HIRO_BASE = "https://api.mainnet.hiro.so";
const BITFLOW_POOLS = "https://bff.bitflowapis.finance/api/app/v1/pools";
const BITFLOW_USER_POSITIONS = "https://bff.bitflowapis.finance/api/app/v1/users";
const BITFLOW_BIN_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1/bins";
const USER_AGENT = "bff-skills/hodlmm-tenure-protector";

// Tenure risk thresholds (seconds since last Bitcoin block)
const TENURE_GREEN_MAX_S = 600;     // 0–10 min: normal, safe
const TENURE_YELLOW_MAX_S = 900;    // 10–15 min: elevated, caution
const TENURE_RED_MAX_S = 1200;      // 15–20 min: high risk, widen bins
                                     // >20 min:   critical, consider exit

// HODLMM safety gates
const MIN_TVL_USD = 10_000;          // skip pools below this TVL
const MAX_SANE_APR = 500;            // reject implausible APR values
const STALE_TENURE_SPREAD_MULT = 2;  // recommend 2x bin width during RED
const CRITICAL_SPREAD_MULT = 3;      // recommend 3x bin width during CRITICAL

// Historical analysis window
const BURN_BLOCKS_HISTORY = 10;      // last 10 BTC blocks for timing stats

// Fetch timeout
const FETCH_TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────────────────

interface NodeInfo {
  tenure_height?: number;
  stacks_tip_height?: number;
  burn_block_height?: number;
  is_fully_synced?: boolean;
}

interface StacksBlock {
  height: number;
  tenure_height: number;
  block_time: number;
  block_time_iso: string;
  burn_block_height: number;
  burn_block_time: number;
  burn_block_time_iso: string;
  tx_count: number;
}

interface BlocksResponse {
  results: StacksBlock[];
}

interface BurnBlock {
  burn_block_height: number;
  burn_block_time: number;
  burn_block_time_iso: string;
  burn_block_time_unix?: number;
  stacks_blocks: string[];
}

interface BurnBlocksResponse {
  results: BurnBlock[];
}

interface PoolToken {
  symbol: string;
  contract: string;
  decimals: number;
  priceUsd: number;
}

interface PoolCompositionToken {
  liquidity: number;
  liquidityUsd: number;
  percentage: number;
  symbol?: string;
}

interface HodlmmPool {
  poolId: string;
  pool_id?: string;
  tvlUsd: number | string;
  apr: number | string;
  apr24h?: number | string;
  binStep: number | string;
  baseFee: number | string;
  dynamicFee: number | string;
  volumeUsd1d: number | string;
  volumeUsd7d?: number | string;
  tokens?: { tokenX: PoolToken; tokenY: PoolToken };
  poolComposition?: { tokenX: PoolCompositionToken; tokenY: PoolCompositionToken };
  poolStatus?: string;
  type?: string;
  poolType?: string;
}

interface PoolsApiResponse {
  data?: HodlmmPool[];
  results?: HodlmmPool[];
  pools?: HodlmmPool[];
}

// ── Position-level types (--wallet) ───────────────────────────────────────────

interface UserBin {
  binId: number | string;
  binStep?: number | string;
  priceX?: number | string;
  priceY?: number | string;
  liquidityX?: number | string;
  liquidityY?: number | string;
  liquidity?: number | string;
  isActive?: boolean;
}

interface UserBinsResponse {
  bins?: UserBin[];
  data?: UserBin[];
  results?: UserBin[];
}

// ── Bin quote types (price validation) ────────────────────────────────────────

interface BinQuote {
  binId: number | string;
  priceX?: number | string;
  priceY?: number | string;
  price?: number | string;
  isActive?: boolean;
  activeId?: number | string;
}

interface BinQuotesResponse {
  bins?: BinQuote[];
  data?: BinQuote[];
  results?: BinQuote[];
  activeBinId?: number | string;
  activePrice?: number | string;
}

interface PositionOverlap {
  pool_id: string;
  wallet: string;
  total_bins: number;
  active_bins: number;
  bins_in_active_range: number;
  overlap_ratio: number;
  position_exposure: "NONE" | "PARTIAL" | "FULL";
}

interface BinPriceDeviation {
  pool_id: string;
  active_bin_id: number | null;
  active_bin_price: number | null;
  price_deviation_pct: number | null;
  price_source: "bin_quotes" | "unavailable";
}

interface TenureStatus {
  burn_block_height: number;
  burn_block_time_iso: string;
  burn_block_time_unix: number;
  tenure_age_s: number;
  tenure_height: number;
  stacks_tip_height: number;
  stacks_blocks_in_tenure: number;
  risk_level: "GREEN" | "YELLOW" | "RED" | "CRITICAL";
  risk_description: string;
}

interface BlockTiming {
  burn_height: number;
  burn_time_iso: string;
  gap_s: number | null;
  stacks_blocks: number;
}

interface TimingStats {
  blocks: BlockTiming[];
  avg_gap_s: number;
  min_gap_s: number;
  max_gap_s: number;
  stddev_s: number;
  predicted_next_block_s: number;
}

interface PoolRisk {
  pool_id: string;
  pair: string;
  tvl_usd: number;
  apr: number;
  bin_step: number;
  base_fee: number;
  volume_24h_usd: number;
  current_spread_bps: number;
  recommended_spread_bps: number;
  spread_action: "HOLD" | "WIDEN" | "WIDEN_URGENT" | "EXIT_RISK";
  toxic_flow_exposure: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  rationale: string;
  position_overlap?: PositionOverlap;
  bin_price_deviation?: BinPriceDeviation;
}

interface ProtectorResult {
  status: "ok" | "degraded" | "error";
  decision: "SAFE" | "CAUTION" | "WIDEN" | "SHELTER";
  action: string;
  tenure: TenureStatus;
  timing: TimingStats;
  pools: PoolRisk[];
  sources_used: string[];
  sources_failed: string[];
  timestamp: string;
  error: string | null;
}

interface DoctorResult {
  status: "ok" | "degraded" | "error";
  checks: Record<string, "ok" | "fail">;
  message: string;
}

// ── Fetch helper ───────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1500));
      const retry = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
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

// ── Data fetchers ──────────────────────────────────────────────────────────────

async function fetchNodeInfo(): Promise<NodeInfo> {
  return fetchJson<NodeInfo>(`${HIRO_BASE}/v2/info`);
}

async function fetchLatestBlocks(limit = 5): Promise<BlocksResponse> {
  return fetchJson<BlocksResponse>(`${HIRO_BASE}/extended/v2/blocks?limit=${limit}`);
}

async function fetchBurnBlocks(limit = BURN_BLOCKS_HISTORY): Promise<BurnBlocksResponse> {
  return fetchJson<BurnBlocksResponse>(`${HIRO_BASE}/extended/v2/burn-blocks?limit=${limit}`);
}

async function fetchPools(): Promise<HodlmmPool[]> {
  const data = await fetchJson<HodlmmPool[] | PoolsApiResponse>(BITFLOW_POOLS);
  if (Array.isArray(data)) return data;
  if ((data as PoolsApiResponse).data) return (data as PoolsApiResponse).data!;
  if ((data as PoolsApiResponse).results) return (data as PoolsApiResponse).results!;
  if ((data as PoolsApiResponse).pools) return (data as PoolsApiResponse).pools!;
  return [];
}

async function fetchStxFees(): Promise<number> {
  return fetchJson<number>(`${HIRO_BASE}/v2/fees/transfer`);
}

async function fetchUserBins(wallet: string, poolId: string): Promise<UserBin[]> {
  const url = `${BITFLOW_USER_POSITIONS}/${wallet}/positions/${poolId}/bins`;
  const data = await fetchJson<UserBin[] | UserBinsResponse>(url);
  if (Array.isArray(data)) return data;
  const resp = data as UserBinsResponse;
  return resp.bins ?? resp.data ?? resp.results ?? [];
}

async function fetchBinQuotes(poolId: string): Promise<BinQuotesResponse> {
  const url = `${BITFLOW_BIN_QUOTES}/${poolId}`;
  return fetchJson<BinQuotesResponse>(url);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toNum(val: number | string | undefined, fallback: number): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

// ── Core logic ─────────────────────────────────────────────────────────────────

function classifyRisk(tenureAgeS: number): TenureStatus["risk_level"] {
  if (tenureAgeS <= TENURE_GREEN_MAX_S) return "GREEN";
  if (tenureAgeS <= TENURE_YELLOW_MAX_S) return "YELLOW";
  if (tenureAgeS <= TENURE_RED_MAX_S) return "RED";
  return "CRITICAL";
}

function riskDescription(level: TenureStatus["risk_level"], ageS: number): string {
  const ageMin = (ageS / 60).toFixed(1);
  switch (level) {
    case "GREEN":
      return `Tenure fresh (${ageMin}m). Bitcoin block recent — L2 prices aligned with L1. Normal bin spreads safe.`;
    case "YELLOW":
      return `Tenure aging (${ageMin}m). Approaching typical BTC block interval. Monitor for drift — no action yet.`;
    case "RED":
      return `Tenure stale (${ageMin}m). L2 prices may lag L1 reality. Arbitrageurs have informational edge. Widen bin spreads to reduce toxic flow exposure.`;
    case "CRITICAL":
      return `Tenure critically stale (${ageMin}m). High probability of tenure change imminent. Maximum toxic flow risk — widen to outer bins or pause new deployments.`;
  }
}

function computeTenureStatus(nodeInfo: NodeInfo, latestBlock: StacksBlock, burnBlockData: BurnBlocksResponse | null): TenureStatus {
  const burnTime = latestBlock.burn_block_time;
  const burnTimeIso = latestBlock.burn_block_time_iso;
  const nowUnix = Math.floor(Date.now() / 1000);
  const tenureAgeS = nowUnix - burnTime;

  let stacksBlocksInTenure = 0;
  if (burnBlockData?.results?.[0]?.stacks_blocks) {
    stacksBlocksInTenure = burnBlockData.results[0].stacks_blocks.length;
  }

  const riskLevel = classifyRisk(tenureAgeS);

  return {
    burn_block_height: latestBlock.burn_block_height,
    burn_block_time_iso: burnTimeIso,
    burn_block_time_unix: burnTime,
    tenure_age_s: tenureAgeS,
    tenure_height: nodeInfo.tenure_height ?? latestBlock.tenure_height,
    stacks_tip_height: nodeInfo.stacks_tip_height ?? latestBlock.height,
    stacks_blocks_in_tenure: stacksBlocksInTenure,
    risk_level: riskLevel,
    risk_description: riskDescription(riskLevel, tenureAgeS),
  };
}

function computeTimingStats(burnBlocks: BurnBlock[]): TimingStats {
  const blocks: BlockTiming[] = [];
  const gaps: number[] = [];

  for (let i = 0; i < burnBlocks.length; i++) {
    const bb = burnBlocks[i];
    const burnTime = bb.burn_block_time ?? bb.burn_block_time_unix ?? 0;
    const burnTimeIso = bb.burn_block_time_iso ?? new Date(burnTime * 1000).toISOString();
    const stacksBlocks = bb.stacks_blocks?.length ?? 0;
    let gapS: number | null = null;

    if (i < burnBlocks.length - 1) {
      const prevBb = burnBlocks[i + 1];
      const prevTime = prevBb.burn_block_time ?? prevBb.burn_block_time_unix ?? 0;
      gapS = burnTime - prevTime;
      if (gapS > 0) gaps.push(gapS);
    }

    blocks.push({
      burn_height: bb.burn_block_height,
      burn_time_iso: burnTimeIso,
      gap_s: gapS,
      stacks_blocks: stacksBlocks,
    });
  }

  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 600;
  const minGap = gaps.length > 0 ? Math.min(...gaps) : 0;
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;
  const variance = gaps.length > 0
    ? gaps.reduce((sum, g) => sum + (g - avgGap) ** 2, 0) / gaps.length
    : 0;
  const stddev = Math.sqrt(variance);

  return {
    blocks,
    avg_gap_s: Math.round(avgGap),
    min_gap_s: minGap,
    max_gap_s: maxGap,
    stddev_s: Math.round(stddev),
    predicted_next_block_s: Math.round(avgGap),
  };
}

// ── Position-level analysis ───────────────────────────────────────────────────

function analyzePositionOverlap(
  userBins: UserBin[],
  binQuotes: BinQuotesResponse | null,
  poolId: string,
  wallet: string,
): PositionOverlap {
  const totalBins = userBins.length;

  // Determine active bin ID from quotes response
  let activeBinId: number | null = null;
  if (binQuotes?.activeBinId !== undefined) {
    activeBinId = Number(binQuotes.activeBinId);
  } else {
    // Try to find active bin from the quotes list
    const quoteBins = binQuotes?.bins ?? binQuotes?.data ?? binQuotes?.results ?? [];
    const activeBin = quoteBins.find(b => b.isActive);
    if (activeBin) activeBinId = Number(activeBin.binId);
  }

  // Count user bins that are active or near the active bin
  // A bin is "in range" if it is within +-5 bins of the active bin
  const ACTIVE_RANGE_HALF_WIDTH = 5;
  let activeBins = 0;
  let binsInActiveRange = 0;

  for (const bin of userBins) {
    const binId = Number(bin.binId);
    if (bin.isActive) activeBins++;
    if (activeBinId !== null && Math.abs(binId - activeBinId) <= ACTIVE_RANGE_HALF_WIDTH) {
      binsInActiveRange++;
    }
  }

  const overlapRatio = totalBins > 0 ? binsInActiveRange / totalBins : 0;
  let positionExposure: PositionOverlap["position_exposure"] = "NONE";
  if (overlapRatio > 0.5) positionExposure = "FULL";
  else if (overlapRatio > 0) positionExposure = "PARTIAL";

  return {
    pool_id: poolId,
    wallet,
    total_bins: totalBins,
    active_bins: activeBins,
    bins_in_active_range: binsInActiveRange,
    overlap_ratio: Math.round(overlapRatio * 1000) / 1000,
    position_exposure: positionExposure,
  };
}

function analyzeBinPriceDeviation(binQuotes: BinQuotesResponse | null, poolId: string): BinPriceDeviation {
  if (!binQuotes) {
    return { pool_id: poolId, active_bin_id: null, active_bin_price: null, price_deviation_pct: null, price_source: "unavailable" };
  }

  const quoteBins = binQuotes.bins ?? binQuotes.data ?? binQuotes.results ?? [];

  // Find active bin
  let activeBinId: number | null = null;
  let activeBinPrice: number | null = null;

  if (binQuotes.activeBinId !== undefined) {
    activeBinId = Number(binQuotes.activeBinId);
  }
  if (binQuotes.activePrice !== undefined) {
    activeBinPrice = Number(binQuotes.activePrice);
  }

  if (activeBinId === null || activeBinPrice === null) {
    for (const bin of quoteBins) {
      if (bin.isActive) {
        activeBinId = Number(bin.binId);
        activeBinPrice = Number(bin.price ?? bin.priceX ?? 0);
        break;
      }
    }
  }

  // Compute deviation: compare active bin price to the average of neighboring bins
  // A large deviation suggests price is lagging or leading
  let deviationPct: number | null = null;
  if (activeBinId !== null && activeBinPrice !== null && activeBinPrice > 0) {
    const neighbors = quoteBins
      .filter(b => {
        const id = Number(b.binId);
        return Math.abs(id - activeBinId!) <= 3 && id !== activeBinId;
      })
      .map(b => Number(b.price ?? b.priceX ?? 0))
      .filter(p => p > 0);

    if (neighbors.length > 0) {
      const avgNeighbor = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
      deviationPct = Math.round(Math.abs(activeBinPrice - avgNeighbor) / avgNeighbor * 10000) / 100;
    }
  }

  return {
    pool_id: poolId,
    active_bin_id: activeBinId,
    active_bin_price: activeBinPrice,
    price_deviation_pct: deviationPct,
    price_source: "bin_quotes",
  };
}

function assessPoolRisk(pool: HodlmmPool, tenure: TenureStatus, positionOverlap?: PositionOverlap, binPriceDeviation?: BinPriceDeviation): PoolRisk | null {
  const tvl = toNum(pool.tvlUsd, 0);
  const apr = toNum(pool.apr, 0);
  const binStep = toNum(pool.binStep, 10);
  const baseFee = toNum(pool.baseFee, 0.003);
  const vol24h = toNum(pool.volumeUsd1d, 0);
  const poolId = pool.poolId ?? pool.pool_id ?? "unknown";

  // Skip tiny or implausible pools
  if (tvl < MIN_TVL_USD) return null;
  if (apr > MAX_SANE_APR) return null;

  const tokenX = pool.tokens?.tokenX?.symbol ?? pool.poolComposition?.tokenX?.symbol ?? "?";
  const tokenY = pool.tokens?.tokenY?.symbol ?? pool.poolComposition?.tokenY?.symbol ?? "?";
  const pair = `${tokenX}/${tokenY}`;

  const currentSpreadBps = binStep;
  let recommendedSpreadBps = currentSpreadBps;
  let spreadAction: PoolRisk["spread_action"] = "HOLD";
  let toxicExposure: PoolRisk["toxic_flow_exposure"] = "LOW";
  let rationale = "";

  // Higher volume pools are more attractive targets for toxic flow
  const isHighVolume = vol24h > 50_000;
  const isMediumVolume = vol24h > 10_000;

  switch (tenure.risk_level) {
    case "GREEN":
      spreadAction = "HOLD";
      toxicExposure = "LOW";
      rationale = isHighVolume
        ? "Tenure fresh — normal spreads safe. High volume but low arb risk during fresh tenure."
        : "Tenure fresh — normal spreads safe.";
      break;

    case "YELLOW":
      if (isHighVolume) {
        toxicExposure = "MODERATE";
        rationale = "Tenure aging with high volume — arbitrageurs may begin positioning. Monitor closely.";
      } else {
        toxicExposure = "LOW";
        rationale = "Tenure aging but low volume reduces arb incentive. Hold current spreads.";
      }
      spreadAction = "HOLD";
      break;

    case "RED":
      recommendedSpreadBps = currentSpreadBps * STALE_TENURE_SPREAD_MULT;
      if (isHighVolume) {
        spreadAction = "WIDEN_URGENT";
        toxicExposure = "HIGH";
        rationale = `Stale tenure + high volume ($${vol24h.toFixed(0)}/24h) = prime arb target. Widen bins to ${recommendedSpreadBps} bps immediately.`;
      } else if (isMediumVolume) {
        spreadAction = "WIDEN";
        toxicExposure = "MODERATE";
        rationale = `Stale tenure with moderate volume. Widen bins to ${recommendedSpreadBps} bps as precaution.`;
      } else {
        spreadAction = "HOLD";
        toxicExposure = "LOW";
        rationale = "Stale tenure but thin volume — arb cost exceeds profit. Spreads can hold.";
      }
      break;

    case "CRITICAL":
      recommendedSpreadBps = currentSpreadBps * CRITICAL_SPREAD_MULT;
      if (isHighVolume || isMediumVolume) {
        spreadAction = "EXIT_RISK";
        toxicExposure = "CRITICAL";
        rationale = `Critically stale tenure (${(tenure.tenure_age_s / 60).toFixed(0)}m) — tenure change imminent. High toxic flow probability. Move to outer bins (${recommendedSpreadBps} bps) or pause deployments.`;
      } else {
        spreadAction = "WIDEN";
        toxicExposure = "HIGH";
        rationale = `Critically stale tenure but thin volume. Widen to ${recommendedSpreadBps} bps as defensive measure.`;
      }
      break;
  }

  // ── Position-level downgrade: if wallet bins don't overlap active range, reduce risk ──
  if (positionOverlap && positionOverlap.position_exposure === "NONE") {
    // LP's bins are entirely in outer range — no toxic flow exposure regardless of tenure
    toxicExposure = "LOW";
    spreadAction = "HOLD";
    rationale += " [Position override: wallet bins are outside active trading range — zero toxic flow exposure.]";
  } else if (positionOverlap && positionOverlap.position_exposure === "PARTIAL") {
    // Partial overlap — reduce severity by one level
    if (toxicExposure === "CRITICAL") toxicExposure = "HIGH";
    else if (toxicExposure === "HIGH") toxicExposure = "MODERATE";
    if (spreadAction === "EXIT_RISK") spreadAction = "WIDEN_URGENT";
    else if (spreadAction === "WIDEN_URGENT") spreadAction = "WIDEN";
    rationale += ` [Position override: only ${positionOverlap.bins_in_active_range}/${positionOverlap.total_bins} bins overlap active range — reduced exposure.]`;
  }

  // ── Bin price deviation: if deviation is measurable, adjust toxic flow assessment ──
  if (binPriceDeviation && binPriceDeviation.price_deviation_pct !== null) {
    const devPct = binPriceDeviation.price_deviation_pct;
    if (devPct > 2.0 && tenure.risk_level !== "GREEN") {
      // Significant price deviation during stale tenure — confirms toxic flow risk
      if (toxicExposure === "LOW") toxicExposure = "MODERATE";
      else if (toxicExposure === "MODERATE") toxicExposure = "HIGH";
      rationale += ` [Bin price deviation ${devPct.toFixed(2)}% detected — confirms L2/L1 price lag.]`;
    } else if (devPct < 0.5 && tenure.risk_level !== "GREEN") {
      // Minimal deviation despite stale tenure — prices are tracking well
      rationale += ` [Bin price deviation only ${devPct.toFixed(2)}% — L2 prices tracking L1 despite tenure age.]`;
    }
  }

  return {
    pool_id: poolId,
    pair,
    tvl_usd: tvl,
    apr,
    bin_step: binStep,
    base_fee: baseFee,
    volume_24h_usd: vol24h,
    current_spread_bps: currentSpreadBps,
    recommended_spread_bps: recommendedSpreadBps,
    spread_action: spreadAction,
    toxic_flow_exposure: toxicExposure,
    rationale,
    position_overlap: positionOverlap,
    bin_price_deviation: binPriceDeviation,
  };
}

function overallDecision(tenure: TenureStatus, pools: PoolRisk[]): { decision: ProtectorResult["decision"]; action: string } {
  const hasExitRisk = pools.some(p => p.spread_action === "EXIT_RISK");
  const hasWidenUrgent = pools.some(p => p.spread_action === "WIDEN_URGENT");
  const hasWiden = pools.some(p => p.spread_action === "WIDEN");
  const hasModerate = pools.some(p => p.toxic_flow_exposure === "MODERATE");

  if (hasExitRisk) {
    return {
      decision: "SHELTER",
      action: `CRITICAL: Tenure stale ${(tenure.tenure_age_s / 60).toFixed(0)}m — move HODLMM liquidity to outer bins or pause. Tenure change imminent, toxic flow risk maximum.`,
    };
  }

  if (hasWidenUrgent) {
    return {
      decision: "WIDEN",
      action: `WARNING: Stale tenure (${(tenure.tenure_age_s / 60).toFixed(0)}m) with active volume. Widen bin spreads on high-volume pools to reduce arb exposure.`,
    };
  }

  if (hasWiden) {
    return {
      decision: "CAUTION",
      action: `Tenure aging (${(tenure.tenure_age_s / 60).toFixed(0)}m). Consider widening spreads on exposed pools. New Bitcoin block expected within ${Math.max(0, Math.round((600 - tenure.tenure_age_s) / 60))}m.`,
    };
  }

  // Tenure is YELLOW/RED but no pool needs widening yet — still flag caution
  if (tenure.risk_level === "YELLOW" && hasModerate) {
    return {
      decision: "CAUTION",
      action: `Tenure aging (${(tenure.tenure_age_s / 60).toFixed(0)}m). High-volume pools showing moderate toxic flow exposure. Monitor — no spread change yet.`,
    };
  }

  if (tenure.risk_level === "RED" || tenure.risk_level === "CRITICAL") {
    return {
      decision: "CAUTION",
      action: `Tenure stale (${(tenure.tenure_age_s / 60).toFixed(0)}m) but pool volume too thin for profitable arb. Monitor closely — risk escalates if volume spikes.`,
    };
  }

  return {
    decision: "SAFE",
    action: `Tenure fresh (${(tenure.tenure_age_s / 60).toFixed(0)}m). All HODLMM positions safe at current spreads. No action required.`,
  };
}

// ── Error helper ───────────────────────────────────────────────────────────────

function failSafeResult(sourcesUsed: string[], sourcesFailed: string[], errorMsg: string): ProtectorResult {
  return {
    status: "error",
    decision: "SHELTER",
    action: "Data sources unavailable — assume maximum risk. Do not deploy new liquidity.",
    tenure: {
      burn_block_height: 0, burn_block_time_iso: "", burn_block_time_unix: 0,
      tenure_age_s: 9999, tenure_height: 0, stacks_tip_height: 0,
      stacks_blocks_in_tenure: 0, risk_level: "CRITICAL",
      risk_description: "Unable to determine tenure status — defaulting to maximum risk.",
    },
    timing: { blocks: [], avg_gap_s: 0, min_gap_s: 0, max_gap_s: 0, stddev_s: 0, predicted_next_block_s: 0 },
    pools: [],
    sources_used: sourcesUsed,
    sources_failed: sourcesFailed,
    timestamp: new Date().toISOString(),
    error: errorMsg,
  };
}

// ── Filter pools ───────────────────────────────────────────────────────────────

function filterDlmmPools(pools: HodlmmPool[], poolFilter?: string): HodlmmPool[] {
  let filtered = pools.filter(p => {
    const id = p.poolId ?? p.pool_id ?? "";
    const tvl = toNum(p.tvlUsd, 0);
    return id.startsWith("dlmm_") && tvl >= MIN_TVL_USD;
  });

  if (poolFilter) {
    filtered = filtered.filter(p =>
      (p.poolId ?? p.pool_id ?? "").toLowerCase() === poolFilter.toLowerCase()
    );
  }

  return filtered;
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  const checks: Record<string, "ok" | "fail"> = {};
  const sources = [
    { name: "hiro_node_info", url: `${HIRO_BASE}/v2/info` },
    { name: "hiro_blocks", url: `${HIRO_BASE}/extended/v2/blocks?limit=1` },
    { name: "hiro_burn_blocks", url: `${HIRO_BASE}/extended/v2/burn-blocks?limit=1` },
    { name: "bitflow_pools", url: BITFLOW_POOLS },
    { name: "hiro_fees", url: `${HIRO_BASE}/v2/fees/transfer` },
  ];

  for (const src of sources) {
    try {
      await fetchJson(src.url);
      checks[src.name] = "ok";
    } catch {
      checks[src.name] = "fail";
    }
  }

  const allOk = Object.values(checks).every(v => v === "ok");
  const noneOk = Object.values(checks).every(v => v === "fail");

  const result: DoctorResult = {
    status: noneOk ? "error" : allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All 5 data sources reachable. Tenure protector ready."
      : noneOk
        ? "All data sources unreachable. Check network connectivity."
        : `Some sources degraded: ${Object.entries(checks).filter(([, v]) => v === "fail").map(([k]) => k).join(", ")}`,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(allOk ? 0 : noneOk ? 3 : 1);
}

async function runProtector(opts: { pool?: string; verbose?: boolean; wallet?: string }): Promise<void> {
  const sourcesUsed: string[] = [];
  const sourcesFailed: string[] = [];

  // Fetch all data sources in parallel
  let nodeInfo: NodeInfo | null;
  let blocksData: BlocksResponse | null;
  let burnData: BurnBlocksResponse | null;
  let pools: HodlmmPool[];
  let _feesData: number | null;

  try {
    [nodeInfo, blocksData, burnData, pools, _feesData] = await Promise.all([
      fetchNodeInfo().then(d => { sourcesUsed.push("hiro-node-info"); return d; })
        .catch(() => { sourcesFailed.push("hiro-node-info"); return null; }),
      fetchLatestBlocks(1).then(d => { sourcesUsed.push("hiro-blocks"); return d; })
        .catch(() => { sourcesFailed.push("hiro-blocks"); return null; }),
      fetchBurnBlocks().then(d => { sourcesUsed.push("hiro-burn-blocks"); return d; })
        .catch(() => { sourcesFailed.push("hiro-burn-blocks"); return null; }),
      fetchPools().then(d => { sourcesUsed.push("bitflow-hodlmm"); return d; })
        .catch(() => { sourcesFailed.push("bitflow-hodlmm"); return [] as HodlmmPool[]; }),
      fetchStxFees().then(d => { sourcesUsed.push("hiro-fees"); return d; })
        .catch(() => { sourcesFailed.push("hiro-fees"); return null; }),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const result = failSafeResult(sourcesUsed, sourcesFailed, msg);
    console.log(JSON.stringify(result, null, 2));
    process.exit(3);
    return;
  }

  // Must have blocks data for tenure calculation
  if (!blocksData?.results?.[0] && !nodeInfo) {
    const result = failSafeResult(sourcesUsed, sourcesFailed, "No block data available");
    console.log(JSON.stringify(result, null, 2));
    process.exit(3);
    return;
  }

  const latestBlock = blocksData!.results[0];

  // Compute tenure status
  const tenure = computeTenureStatus(nodeInfo ?? {} as NodeInfo, latestBlock, burnData);

  // Compute timing stats from burn block history
  const burnBlocks = burnData?.results ?? [];
  const timing = computeTimingStats(burnBlocks);

  // Assess each HODLMM pool — with optional position-level and bin price analysis
  const dlmmPools = filterDlmmPools(pools, opts.pool);

  // Pre-fetch bin quotes for all pools in parallel (graceful degradation on failure)
  const binQuotesMap = new Map<string, BinQuotesResponse | null>();
  const binQuotePromises = dlmmPools.map(async (pool) => {
    const poolId = pool.poolId ?? pool.pool_id ?? "unknown";
    try {
      const quotes = await fetchBinQuotes(poolId);
      binQuotesMap.set(poolId, quotes);
      if (!sourcesUsed.includes("bitflow-bin-quotes")) sourcesUsed.push("bitflow-bin-quotes");
    } catch {
      binQuotesMap.set(poolId, null);
      if (!sourcesFailed.includes("bitflow-bin-quotes")) sourcesFailed.push("bitflow-bin-quotes");
    }
  });
  await Promise.all(binQuotePromises);

  // If --wallet provided, fetch user positions for each pool in parallel
  const positionMap = new Map<string, PositionOverlap | undefined>();
  if (opts.wallet) {
    const posPromises = dlmmPools.map(async (pool) => {
      const poolId = pool.poolId ?? pool.pool_id ?? "unknown";
      try {
        const userBins = await fetchUserBins(opts.wallet!, poolId);
        if (userBins.length > 0) {
          const overlap = analyzePositionOverlap(userBins, binQuotesMap.get(poolId) ?? null, poolId, opts.wallet!);
          positionMap.set(poolId, overlap);
          if (!sourcesUsed.includes("bitflow-user-positions")) sourcesUsed.push("bitflow-user-positions");
        }
      } catch {
        if (!sourcesFailed.includes("bitflow-user-positions")) sourcesFailed.push("bitflow-user-positions");
      }
    });
    await Promise.all(posPromises);
  }

  const poolRisks: PoolRisk[] = [];
  for (const pool of dlmmPools) {
    const poolId = pool.poolId ?? pool.pool_id ?? "unknown";
    const posOverlap = positionMap.get(poolId);
    const binQuotes = binQuotesMap.get(poolId) ?? null;
    const binDeviation = analyzeBinPriceDeviation(binQuotes, poolId);
    const risk = assessPoolRisk(pool, tenure, posOverlap, binDeviation);
    if (risk) poolRisks.push(risk);
  }

  // Sort: highest risk first
  const riskOrder: Record<PoolRisk["toxic_flow_exposure"], number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };
  poolRisks.sort((a, b) => riskOrder[a.toxic_flow_exposure] - riskOrder[b.toxic_flow_exposure]);

  // Overall decision
  const { decision, action } = overallDecision(tenure, poolRisks);

  const result: ProtectorResult = {
    status: sourcesFailed.length === 0 ? "ok" : "degraded",
    decision,
    action,
    tenure,
    timing: opts.verbose ? timing : {
      ...timing,
      blocks: timing.blocks.slice(0, 5),
    },
    pools: poolRisks,
    sources_used: sourcesUsed,
    sources_failed: sourcesFailed,
    timestamp: new Date().toISOString(),
    error: null,
  };

  console.log(JSON.stringify(result, null, 2));

  // Exit code based on risk
  if (decision === "SHELTER") process.exit(2);
  if (decision === "WIDEN") process.exit(1);
  process.exit(0);
}

// ── Exportable core function ───────────────────────────────────────────────────

export async function assessTenureRisk(pool?: string, wallet?: string): Promise<ProtectorResult> {
  const sourcesUsed: string[] = [];
  const sourcesFailed: string[] = [];

  const [nodeInfo, blocksData, burnData, pools] = await Promise.all([
    fetchNodeInfo().then(d => { sourcesUsed.push("hiro-node-info"); return d; })
      .catch(() => { sourcesFailed.push("hiro-node-info"); return null; }),
    fetchLatestBlocks(1).then(d => { sourcesUsed.push("hiro-blocks"); return d; })
      .catch(() => { sourcesFailed.push("hiro-blocks"); return null; }),
    fetchBurnBlocks().then(d => { sourcesUsed.push("hiro-burn-blocks"); return d; })
      .catch(() => { sourcesFailed.push("hiro-burn-blocks"); return null; }),
    fetchPools().then(d => { sourcesUsed.push("bitflow-hodlmm"); return d; })
      .catch(() => { sourcesFailed.push("bitflow-hodlmm"); return [] as HodlmmPool[]; }),
  ]);

  if (!blocksData?.results?.[0]) {
    return failSafeResult(sourcesUsed, sourcesFailed, "No block data");
  }

  const tenure = computeTenureStatus(nodeInfo ?? {} as NodeInfo, blocksData.results[0], burnData);
  const timing = computeTimingStats(burnData?.results ?? []);

  const dlmmPools = filterDlmmPools(pools, pool);

  // Fetch bin quotes for all pools
  const binQuotesMap = new Map<string, BinQuotesResponse | null>();
  await Promise.all(dlmmPools.map(async (p) => {
    const pid = p.poolId ?? p.pool_id ?? "unknown";
    try {
      binQuotesMap.set(pid, await fetchBinQuotes(pid));
      if (!sourcesUsed.includes("bitflow-bin-quotes")) sourcesUsed.push("bitflow-bin-quotes");
    } catch {
      binQuotesMap.set(pid, null);
      if (!sourcesFailed.includes("bitflow-bin-quotes")) sourcesFailed.push("bitflow-bin-quotes");
    }
  }));

  // Fetch user positions if wallet provided
  const positionMap = new Map<string, PositionOverlap | undefined>();
  if (wallet) {
    await Promise.all(dlmmPools.map(async (p) => {
      const pid = p.poolId ?? p.pool_id ?? "unknown";
      try {
        const userBins = await fetchUserBins(wallet, pid);
        if (userBins.length > 0) {
          positionMap.set(pid, analyzePositionOverlap(userBins, binQuotesMap.get(pid) ?? null, pid, wallet));
          if (!sourcesUsed.includes("bitflow-user-positions")) sourcesUsed.push("bitflow-user-positions");
        }
      } catch {
        if (!sourcesFailed.includes("bitflow-user-positions")) sourcesFailed.push("bitflow-user-positions");
      }
    }));
  }

  const poolRisks = dlmmPools.map(p => {
    const pid = p.poolId ?? p.pool_id ?? "unknown";
    const binDev = analyzeBinPriceDeviation(binQuotesMap.get(pid) ?? null, pid);
    return assessPoolRisk(p, tenure, positionMap.get(pid), binDev);
  }).filter(Boolean) as PoolRisk[];

  const { decision, action } = overallDecision(tenure, poolRisks);

  return {
    status: sourcesFailed.length === 0 ? "ok" : "degraded",
    decision, action, tenure, timing, pools: poolRisks,
    sources_used: sourcesUsed, sources_failed: sourcesFailed,
    timestamp: new Date().toISOString(), error: null,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-tenure-protector")
  .description("Nakamoto tenure-aware risk monitor for HODLMM concentrated liquidity positions")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify all data sources are reachable")
  .action(runDoctor);

program
  .command("install-packs")
  .description("No additional packs required")
  .action(() => {
    console.log(JSON.stringify({ status: "ok", message: "No additional packs required. Uses native fetch for all API calls." }));
  });

program
  .command("run")
  .description("Assess current tenure risk for HODLMM positions")
  .option("--pool <id>", "Filter to specific HODLMM pool (e.g., dlmm_1)")
  .option("--wallet <address>", "STX address for position-level risk (checks if your bins overlap active range)")
  .option("--verbose", "Include full burn block history in output")
  .action(runProtector);

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(JSON.stringify({ error: msg }));
    process.exit(3);
  });
}
