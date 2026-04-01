#!/usr/bin/env bun
/**
 * sBTC Proof of Reserve
 * Proof-of-Reserve auditor for sBTC/BTC peg integrity.
 *
 * Golden Chain:
 *   1. Fetch aggregate-pubkey from sbtc-registry (Stacks mainnet)
 *   2. Derive the P2TR signer address via BIP-341 taproot key tweak
 *   3. Query confirmed BTC balance at that address (mempool.space)
 *   4. Query total circulating sBTC supply (sbtc-token contract)
 *   5. Output reserve_ratio, hodlmm_signal, and a 0-100 peg health score
 *
 * Importable:
 *   import { runAudit } from "../sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts"
 *   const { hodlmm_signal, reserve_ratio } = await runAudit()
 *
 * CLI:
 *   bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts doctor
 *   bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run
 *   bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run --threshold 90
 *
 * Mainnet only. Read-only. No transactions.
 */

import { createHash } from "crypto";
import { Command }    from "commander";
import * as ecc       from "tiny-secp256k1";

// ── Mainnet API endpoints ───────────────────────────────────────────────────
const HIRO_API       = "https://api.mainnet.hiro.so";
const BITFLOW_TICKER = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker";
const MEMPOOL_API    = "https://mempool.space/api";
const COINGECKO_API  = "https://api.coingecko.com/api/v3";

// sBTC contracts — Stacks mainnet
const SBTC_CONTRACT      = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const SBTC_REGISTRY      = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_REGISTRY_NAME = "sbtc-registry";
const SBTC_DECIMALS      = 8;

// ── HODLMM signal thresholds (reserve_ratio = btc_reserve / sbtc_circulating)
const THRESHOLD_GREEN  = 0.999; // ≥ GREEN  — safe for HODLMM entry
const THRESHOLD_YELLOW = 0.995; // ≥ YELLOW — hold, do not add liquidity; < GREEN

// ── Types ───────────────────────────────────────────────────────────────────
export type HodlmmSignal = "GREEN" | "YELLOW" | "RED" | "DATA_UNAVAILABLE";

export interface ReserveBreakdown {
  price_deviation_pct:  number;
  reserve_ratio:        number;   // btc_reserve / sbtc_circulating (≥ 1.0 = healthy)
  mempool_congestion:   string;   // low | medium | high
  fee_sat_vb:           number;
  stacks_block_height:  number;
  btc_block_height:     number;
  sbtc_circulating:     number;   // sBTC in BTC terms
  btc_reserve:          number;   // confirmed BTC at signer P2TR wallet
  signer_address:       string;   // derived P2TR address (bc1p...)
  btc_price_usd:        number;
  sbtc_price_usd:       number;
  peg_source:           string;
}

export interface AuditResult {
  status:         "ok" | "warning" | "critical" | "error";
  score:          number;                          // 0-100
  risk_level:     "low" | "medium" | "high" | "unknown";
  hodlmm_signal:  HodlmmSignal;
  reserve_ratio:  number | null;                   // btc_reserve / sbtc_circulating
  breakdown:      ReserveBreakdown | null;
  recommendation: string;
  alert:          boolean;
  error?:         string;
}

// ── Bech32m helpers (P2TR address derivation — no external lib) ─────────────
const BECH32M_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST   = 0x2bc830a3;

function _bech32mPolymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function _bech32mHrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function _convertBits(data: Uint8Array, fromBits: number, toBits: number): number[] {
  let acc = 0, bits = 0;
  const result: number[] = [];
  const maxV = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxV);
    }
  }
  if (bits > 0) result.push((acc << (toBits - bits)) & maxV);
  return result;
}

/** BIP-341 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data) */
function _tapTaggedHash(tag: string, data: Uint8Array): Buffer {
  const tagHash = createHash("sha256").update(tag).digest();
  return createHash("sha256").update(tagHash).update(tagHash).update(data).digest();
}

/**
 * Derive the mainnet P2TR (bc1p...) address from a 32-byte x-only internal pubkey.
 * Applies BIP-341 key tweak: output_key = lift_x(internal_key) + H_tapTweak(internal_key)·G
 */
function xOnlyPubkeyToP2TR(xOnlyHex: string): string {
  if (xOnlyHex.length !== 64) throw new Error(`Expected 32-byte x-only pubkey, got ${xOnlyHex.length / 2} bytes`);

  const xOnlyBytes = Buffer.from(xOnlyHex, "hex");
  const tweak      = _tapTaggedHash("TapTweak", xOnlyBytes);
  const tweaked    = ecc.xOnlyPointAddTweak(xOnlyBytes, tweak);
  if (!tweaked) throw new Error("Taproot key tweak failed — invalid internal pubkey");

  const hrp      = "bc";
  const data     = [1, ..._convertBits(tweaked.xOnlyPubkey, 8, 5)];
  const expanded = _bech32mHrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const poly     = _bech32mPolymod(expanded) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (poly >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map(d => BECH32M_CHARSET[d]).join("");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function fetchJson(url: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...opts,
    headers: { "User-Agent": "bff-skills/sbtc-proof-of-reserve", ...(opts.headers ?? {}) },
  });
  // Retry once on 429 with 1s backoff (CoinGecko rate limit in multi-agent scenarios)
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 1000));
    const retry = await fetch(url, {
      ...opts,
      headers: { "User-Agent": "bff-skills/sbtc-proof-of-reserve", ...(opts.headers ?? {}) },
    });
    if (!retry.ok) throw new Error(`HTTP ${retry.status} from ${url} (after retry)`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── Data fetch functions ─────────────────────────────────────────────────────
async function fetchSbtcSupply(): Promise<number> {
  const [addr, name] = SBTC_CONTRACT.split(".");
  const body = { sender: addr, arguments: [] };
  const res = await fetchJson(
    `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/get-total-supply`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  ) as { okay?: boolean; result?: string };
  if (res.okay && res.result) {
    const hex = res.result.replace(/^0x/, "");
    if (hex.startsWith("01")) {
      return Number(BigInt("0x" + hex.slice(2))) / 10 ** SBTC_DECIMALS;
    }
  }
  // Fallback: token metadata endpoint (BigInt intermediate for precision at scale)
  const meta = await fetchJson(`${HIRO_API}/metadata/v1/ft/${SBTC_CONTRACT}`) as { total_supply?: string };
  return Number(BigInt(meta?.total_supply ?? "0")) / 10 ** SBTC_DECIMALS;
}

/**
 * Derive the sBTC signer P2TR address from the sbtc-registry aggregate pubkey,
 * then query its confirmed BTC balance from mempool.space.
 */
async function fetchSignerReserve(): Promise<{ address: string; btc: number }> {
  const body = { sender: SBTC_REGISTRY, arguments: [] };
  const res = await fetchJson(
    `${HIRO_API}/v2/contracts/call-read/${SBTC_REGISTRY}/${SBTC_REGISTRY_NAME}/get-current-aggregate-pubkey`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  ) as { okay?: boolean; result?: string };
  if (!res.okay || !res.result) throw new Error("sbtc-registry returned no aggregate pubkey");

  // Clarity buffer: 0x + type byte "02" + 4-byte length "00000021" + 33-byte compressed pubkey
  const hex = res.result.replace(/^0x/, "");
  if (hex.length < 10 + 66) throw new Error(`Unexpected pubkey hex length: ${hex.length}`);
  const compressedPubkey = hex.slice(10);
  if (compressedPubkey.length !== 66) throw new Error(`Expected 33-byte pubkey, got ${compressedPubkey.length / 2} bytes`);

  const xOnlyHex     = compressedPubkey.slice(2); // strip 02/03 prefix
  const signerAddress = xOnlyPubkeyToP2TR(xOnlyHex);

  const addrInfo = await fetchJson(`${MEMPOOL_API}/address/${signerAddress}`) as {
    chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
  };
  const funded   = addrInfo?.chain_stats?.funded_txo_sum ?? 0;
  const spent    = addrInfo?.chain_stats?.spent_txo_sum  ?? 0;
  const btc      = (funded - spent) / 1e8;

  return { address: signerAddress, btc };
}

async function fetchSbtcMarketData(btcPriceUsd: number): Promise<{
  pegRatio:  number;
  pegSource: string;
  sbtcUsd:   number;
}> {
  interface TickerEntry {
    pool_id?: string;
    base_currency?: string;
    target_currency?: string;
    last_price?: string;
  }
  const tickers = await fetchJson(BITFLOW_TICKER) as TickerEntry[];

  // Prefer sBTC/pBTC pool — direct peg ratio, no USD conversion needed
  const pbtcPair = tickers.find(
    (t) => t.pool_id?.toLowerCase().includes("sbtc-pbtc") && parseFloat(t.last_price ?? "0") > 0
  );
  if (pbtcPair) {
    const ratio = parseFloat(pbtcPair.last_price ?? "0");
    return { pegRatio: ratio, pegSource: "sbtc/pbtc-pool", sbtcUsd: ratio * btcPriceUsd };
  }

  // Fallback: derive via sBTC/STX * STX/USD
  const stxPair = tickers.find(
    (t) =>
      t.base_currency?.toLowerCase().includes("sbtc") &&
      t.target_currency === "Stacks" &&
      parseFloat(t.last_price ?? "0") > 0
  );
  if (!stxPair) return { pegRatio: 1, pegSource: "unavailable", sbtcUsd: btcPriceUsd };

  const stxData = await fetchJson(`${COINGECKO_API}/simple/price?ids=blockstack&vs_currencies=usd`) as {
    blockstack?: { usd?: number };
  };
  const stxUsd  = stxData?.blockstack?.usd ?? 0;
  if (!stxUsd) return { pegRatio: 1, pegSource: "unavailable", sbtcUsd: btcPriceUsd };

  const sbtcUsd = parseFloat(stxPair.last_price) * stxUsd;
  const ratio   = btcPriceUsd > 0 ? sbtcUsd / btcPriceUsd : 1;
  return { pegRatio: ratio, pegSource: "sbtc/stx-derived", sbtcUsd };
}

async function fetchBtcPrice(): Promise<number> {
  const data = await fetchJson(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`) as {
    bitcoin?: { usd?: number };
  };
  return data?.bitcoin?.usd ?? 0;
}

async function fetchMempoolFees(): Promise<{ fastestFee: number; congestion: string }> {
  const fees    = await fetchJson(`${MEMPOOL_API}/v1/fees/recommended`) as { fastestFee?: number };
  const fastest = fees?.fastestFee ?? 0;
  return {
    fastestFee:  fastest,
    congestion: fastest <= 5 ? "low" : fastest <= 30 ? "medium" : "high",
  };
}

async function fetchBlockHeights(): Promise<{ stacks: number; btc: number }> {
  const info = await fetchJson(`${HIRO_API}/v2/info`) as { stacks_tip_height?: number; burn_block_height?: number };
  return { stacks: info?.stacks_tip_height ?? 0, btc: info?.burn_block_height ?? 0 };
}

// ── HODLMM signal derivation ─────────────────────────────────────────────────
function deriveHodlmmSignal(reserveRatio: number): HodlmmSignal {
  if (reserveRatio >= THRESHOLD_GREEN)  return "GREEN";
  if (reserveRatio >= THRESHOLD_YELLOW) return "YELLOW";
  return "RED";
}

// ── Score computation ────────────────────────────────────────────────────────
function computeScore(breakdown: ReserveBreakdown): {
  score:          number;
  status:         AuditResult["status"];
  risk_level:     AuditResult["risk_level"];
  recommendation: string;
} {
  let score = 100;
  const issues: string[] = [];

  // 1. Price deviation (max −50 pts)
  const dev = Math.abs(breakdown.price_deviation_pct);
  if (dev > 5) {
    score -= 50;
    issues.push(`severe peg deviation ${dev.toFixed(2)}% (>5%)`);
  } else if (dev > 2) {
    score -= 30;
    issues.push(`notable peg deviation ${dev.toFixed(2)}% (>2%)`);
  } else if (dev > 0.5) {
    score -= 10;
    issues.push(`minor peg deviation ${dev.toFixed(2)}%`);
  }

  // 2. Reserve ratio (max −30 pts) — reserve_ratio = btc_reserve / sbtc (≥ 1.0 = healthy)
  const rr = breakdown.reserve_ratio;
  if (rr < 1 / 1.05) {
    score -= 30;
    issues.push(`BTC reserve covers only ${(rr * 100).toFixed(2)}% of circulating sBTC`);
  } else if (rr < 1 / 1.002) {
    score -= 15;
    issues.push(`reserve ratio ${rr.toFixed(4)} — near undercollateralization threshold`);
  }

  // 3. Mempool congestion (max −20 pts)
  if (breakdown.mempool_congestion === "high") {
    score -= 20;
    issues.push(`high mempool congestion (${breakdown.fee_sat_vb} sat/vB) raises peg-out cost`);
  } else if (breakdown.mempool_congestion === "medium") {
    score -= 5;
  }

  score = Math.max(0, score);

  // Signal-floor clamp: status must never contradict hodlmm_signal.
  // Without this, RED signal + score 85 → status "ok", misleading consuming agents.
  const hodlmmSignal = deriveHodlmmSignal(breakdown.reserve_ratio);
  if (hodlmmSignal === "RED") score = Math.min(score, 0);
  else if (hodlmmSignal === "YELLOW") score = Math.min(score, 50);

  const risk_level: AuditResult["risk_level"] =
    score >= 80 ? "low" : score >= 50 ? "medium" : "high";
  const status: AuditResult["status"] =
    score >= 80 ? "ok" : score >= 50 ? "warning" : "critical";

  const recommendation =
    issues.length === 0
      ? "Peg is healthy. HODLMM entry is safe."
      : `Reserve health degraded — ${issues.join("; ")}.` +
        (status === "critical" ? " Exit HODLMM bins and pause operations." : " Monitor closely.");

  return { score, status, risk_level, recommendation };
}

// ── Core audit logic (exported for use by other skills) ──────────────────────

/**
 * Run the sBTC Proof-of-Reserve audit.
 *
 * @param threshold - Alert threshold (0-100). Scores below this set alert=true. Default: 80.
 * @returns AuditResult with hodlmm_signal, reserve_ratio, score, and full breakdown.
 *
 * @example
 * import { runAudit } from "../sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts"
 *
 * const audit = await runAudit()
 * if (audit.hodlmm_signal !== "GREEN") {
 *   console.log("sBTC reserve unsafe — skipping HODLMM operation")
 *   process.exit(1)
 * }
 */
export async function runAudit(threshold = 80): Promise<AuditResult> {
  try {
    // Fetch all independent data in parallel (btcPrice was sequential before)
    const [btcPrice, sbtcSupply, reserve, mempoolData, heights] = await Promise.all([
      fetchBtcPrice(),
      fetchSbtcSupply(),
      fetchSignerReserve(),
      fetchMempoolFees(),
      fetchBlockHeights(),
    ]);
    if (!btcPrice) throw new Error("BTC price unavailable — cannot compute peg deviation");
    // Market data depends on btcPrice, so fetched after parallel batch
    const marketData = await fetchSbtcMarketData(btcPrice);

    // reserve_ratio: btc_reserve / sbtc_circulating  (≥ 1.0 = fully backed, < 1.0 = under-collateralised)
    const reserveRatio   = sbtcSupply > 0 ? reserve.btc / sbtcSupply : 0;
    const hodlmmSignal   = deriveHodlmmSignal(reserveRatio);

    const priceDeviationPct = (marketData.pegRatio - 1) * 100;

    const breakdown: ReserveBreakdown = {
      price_deviation_pct: priceDeviationPct,
      reserve_ratio:       parseFloat(reserveRatio.toFixed(6)),
      mempool_congestion:  mempoolData.congestion,
      fee_sat_vb:          mempoolData.fastestFee,
      stacks_block_height: heights.stacks,
      btc_block_height:    heights.btc,
      sbtc_circulating:    sbtcSupply,
      btc_reserve:         reserve.btc,
      signer_address:      reserve.address,
      btc_price_usd:       btcPrice,
      sbtc_price_usd:      marketData.sbtcUsd,
      peg_source:          marketData.pegSource,
    };

    const { score, status, risk_level, recommendation } = computeScore(breakdown);

    return {
      status,
      score,
      risk_level,
      hodlmm_signal:  hodlmmSignal,
      reserve_ratio:  parseFloat(reserveRatio.toFixed(6)),
      breakdown,
      recommendation,
      alert: score < threshold,
    };
  } catch (err: unknown) {
    return {
      status:         "error",
      score:          0,
      risk_level:     "unknown",
      hodlmm_signal:  "DATA_UNAVAILABLE",
      reserve_ratio:  null,
      breakdown:      null,
      recommendation: "Oracle could not fetch reserve data. Treat as RED — do not proceed with HODLMM operations.",
      alert:          true,
      error:          err instanceof Error ? err.message : String(err),
    };
  }
}

// ── CLI commands ─────────────────────────────────────────────────────────────
async function runDoctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  try {
    const info = await fetchJson(`${HIRO_API}/v2/info`) as { stacks_tip_height?: number };
    checks.push({ name: "Hiro Stacks API", ok: true, detail: `block ${info.stacks_tip_height}` });
  } catch (e: unknown) {
    checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const reserve = await fetchSignerReserve();
    checks.push({
      name:   "sBTC Signer Reserve (Golden Chain)",
      ok:     reserve.btc > 0,
      detail: `${reserve.btc.toFixed(4)} BTC at ${reserve.address}`,
    });
  } catch (e: unknown) {
    checks.push({ name: "sBTC Signer Reserve (Golden Chain)", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const tickers = await fetchJson(BITFLOW_TICKER) as unknown[];
    checks.push({ name: "Bitflow Ticker API", ok: Array.isArray(tickers), detail: `${tickers.length} pairs` });
  } catch (e: unknown) {
    checks.push({ name: "Bitflow Ticker API", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const fees = await fetchJson(`${MEMPOOL_API}/v1/fees/recommended`) as { fastestFee?: number };
    checks.push({ name: "mempool.space", ok: !!fees.fastestFee, detail: `${fees.fastestFee} sat/vB` });
  } catch (e: unknown) {
    checks.push({ name: "mempool.space", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const btc = await fetchJson(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`) as {
      bitcoin?: { usd?: number };
    };
    checks.push({ name: "CoinGecko BTC Price", ok: !!btc.bitcoin?.usd, detail: `BTC $${btc.bitcoin?.usd}` });
  } catch (e: unknown) {
    checks.push({ name: "CoinGecko BTC Price", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  const allOk = checks.every((c) => c.ok);
  console.log(JSON.stringify({
    status:  allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All data sources reachable. Golden Chain verified. Ready to run."
      : "One or more data sources unavailable — oracle output may be incomplete.",
  }, null, 2));
}

// ── CLI wiring ───────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("sbtc-proof-of-reserve")
  .description("sBTC Proof-of-Reserve Oracle — HODLMM pre-flight security check")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify all data sources and Golden Chain derivation")
  .action(runDoctor);

program
  .command("install-packs")
  .description("No additional packs required")
  .action(() => {
    console.log(JSON.stringify({ status: "ok", message: "No packs required. Self-contained." }));
  });

program
  .command("run")
  .description("Run Proof-of-Reserve audit and output JSON with HODLMM signal")
  .option("--threshold <number>", "Alert threshold (0-100). Scores below this trigger alert=true", "80")
  .action(async (opts: { threshold: string }) => {
    const threshold = parseInt(opts.threshold, 10);
    const result    = await runAudit(isNaN(threshold) ? 80 : threshold);
    console.log(JSON.stringify(result, null, 2));

    if (result.status === "error")    process.exit(3);
    if (result.status === "critical") process.exit(2);
    if (result.status === "warning")  process.exit(1);
  });

// Only run CLI when this file is the entry point — not when imported as a module
if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err) }));
    process.exit(3);
  });
}
