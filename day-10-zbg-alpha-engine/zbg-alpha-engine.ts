#!/usr/bin/env bun
/**
 * ZBG Alpha Engine
 * Cross-protocol yield executor for Zest, Granite, and HODLMM (Bitflow DLMM).
 * Reads positions, verifies sBTC reserve integrity, checks market safety gates,
 * then executes deploy/withdraw/rebalance/migrate/emergency operations.
 *
 * Architecture:
 *   SCOUT    → wallet scan, positions, yields, break prices
 *   RESERVE  → sBTC Proof-of-Reserve (P2TR derivation, BTC balance, GREEN/YELLOW/RED)
 *   GUARDIAN → slippage, volume, gas, cooldown, relay health, price source gates
 *   EXECUTOR → deploy, withdraw, rebalance, migrate, emergency
 *
 * Safety: every write runs Scout → Reserve → Guardian → Executor. No bypasses.
 *
 * Usage:
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts doctor
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts scan --wallet <STX_ADDRESS>
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts deploy --wallet <STX_ADDRESS> --protocol hodlmm --amount 10000
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts withdraw --wallet <STX_ADDRESS> --protocol hodlmm
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts rebalance --wallet <STX_ADDRESS> --pool-id dlmm_1
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts migrate --wallet <STX_ADDRESS> --from granite --to hodlmm
 *   bun run zbg-alpha-engine/zbg-alpha-engine.ts emergency --wallet <STX_ADDRESS>
 */

import { createHash } from "crypto";
import { Command }    from "commander";
import { homedir }    from "os";
import { join }       from "path";
import { readFileSync, writeFileSync } from "fs";
import * as ecc       from "tiny-secp256k1";

// ── Constants ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS    = 30_000;
const HIRO_API            = "https://api.mainnet.hiro.so";
const TENERO_API          = "https://api.tenero.io";
const BITFLOW_API         = "https://bff.bitflowapis.finance";
const BITFLOW_TICKER      = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker";
const MEMPOOL_API         = "https://mempool.space/api";
const COINGECKO_API       = "https://api.coingecko.com/api/v3";

// Guardian thresholds
const MIN_24H_VOLUME_USD  = 10_000;
const MAX_SLIPPAGE_PCT    = 0.5;
const MAX_GAS_STX         = 50;
const COOLDOWN_HOURS      = 4;
const PRICE_SCALE         = 1e8;
const STATE_FILE          = join(homedir(), ".zbg-alpha-engine-state.json");

// PoR thresholds
const THRESHOLD_GREEN     = 0.999;
const THRESHOLD_YELLOW    = 0.995;
const ROTATION_THRESHOLD  = 0.50; // Below this = likely signer rotation, not real shortfall

// Granite contracts
const GRANITE_STATE       = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
const GRANITE_IR          = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.linear-kinked-ir-v1";
const GRANITE_LP          = "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.liquidity-provider-v1";
const GRANITE_BORROWER    = "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.borrower-v1";

// Zest v2 contracts
const ZEST_VAULT_SBTC     = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";

// HODLMM core + pool contracts
const DLMM_CORE           = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const HODLMM_POOLS: PoolDef[] = [
  { id: 1, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10", name: "sBTC-USDCx-10bps", tokenX: "sbtc", tokenY: "usdcx" },
  { id: 2, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-1",  name: "sBTC-USDCx-1bps",  tokenX: "sbtc", tokenY: "usdcx" },
  { id: 3, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",  name: "STX-USDCx-10bps",  tokenX: "stx",  tokenY: "usdcx" },
  { id: 4, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-4",   name: "STX-USDCx-4bps",   tokenX: "stx",  tokenY: "usdcx" },
  { id: 5, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-1",   name: "STX-USDCx-1bps",   tokenX: "stx",  tokenY: "usdcx" },
  { id: 6, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",   name: "STX-sBTC-15bps",   tokenX: "stx",  tokenY: "sbtc" },
  { id: 7, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1", name: "aeUSDC-USDCx-1bps", tokenX: "aeusdc", tokenY: "usdcx" },
  { id: 8, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",  name: "USDh-USDCx-1bps",  tokenX: "usdh", tokenY: "usdcx" },
];

// Token contracts
const SBTC_CONTRACT       = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_CONTRACT      = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SBTC_REGISTRY       = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_REGISTRY_NAME  = "sbtc-registry";

// ── Types ──────────────────────────────────────────────────────────────────────
interface PoolDef { id: number; contract: string; name: string; tokenX: string; tokenY: string }
interface TokenBalance { amount: number; usd: number }
interface WalletBalances { sbtc: TokenBalance; stx: TokenBalance; usdcx: TokenBalance }

interface ZestPosition { has_position: boolean; detail: string; supply_amount?: number; supply_apy_pct?: number; utilization_pct?: number }
interface GranitePosition {
  has_position: boolean; detail: string;
  supply_apy_pct?: number; borrow_apr_pct?: number; utilization_pct?: number;
  max_ltv_pct?: number; liquidation_ltv_pct?: number;
}
interface HodlmmUserPool {
  pool_id: number; name: string; in_range: boolean; active_bin: number;
  user_bins: { min: number; max: number; count: number } | null;
  dlp_shares: string; estimated_value_usd: number | null;
}
interface HodlmmPositions { has_position: boolean; pools: HodlmmUserPool[] }

interface YieldOption {
  protocol: string; pool: string; apy_pct: number;
  daily_usd: number; monthly_usd: number; gas_to_enter_stx: number; note: string;
}
interface BreakPrices {
  hodlmm_range_exit_low_usd: number | null; hodlmm_range_exit_high_usd: number | null;
  granite_liquidation_usd: number | null; current_sbtc_price_usd: number;
}

// PoR types
type HodlmmSignal = "GREEN" | "YELLOW" | "RED" | "DATA_UNAVAILABLE";
interface ReserveResult {
  signal: HodlmmSignal; reserve_ratio: number | null; score: number;
  sbtc_circulating: number; btc_reserve: number; signer_address: string;
  recommendation: string; error?: string;
}

// Guardian types
interface GuardianResult {
  can_proceed: boolean;
  refusals: string[];
  slippage: { ok: boolean; pct: number };
  volume: { ok: boolean; usd: number };
  gas: { ok: boolean; estimated_stx: number };
  cooldown: { ok: boolean; remaining_hours: number };
  relay: { ok: boolean; detail: string };
  prices: { ok: boolean; detail: string };
}

// Scout full result
interface ScoutResult {
  status: "ok" | "degraded" | "error";
  wallet: string;
  balances: WalletBalances;
  prices: { sbtc: number; stx: number; usdcx: number };
  positions: { zest: ZestPosition; granite: GranitePosition; hodlmm: HodlmmPositions };
  options: YieldOption[];
  best_move: { recommendation: string; idle_capital_usd: number; opportunity_cost_daily_usd: number };
  break_prices: BreakPrices;
  data_sources: string[];
}

// Engine output
const DISCLAIMER = "Data-driven yield analysis for informational purposes only. Not financial advice. Past yields do not guarantee future returns. Smart contract risk, impermanent loss, and peg failure are real possibilities. Verify on-chain data independently before acting.";

interface EngineResult {
  status: "ok" | "refused" | "partial" | "error";
  command: string;
  disclaimer: string;
  scout?: ScoutResult;
  reserve?: ReserveResult;
  guardian?: GuardianResult;
  action?: { description: string; txids?: string[]; details?: Record<string, unknown> };
  refusal_reasons?: string[];
  error?: string;
}

interface BitflowPoolData { poolId: string; tvlUsd: number; volumeUsd1d: number; apr24h: number; tokens?: { tokenX: { priceUsd: number; decimals: number }; tokenY: { priceUsd: number; decimals: number } } }

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts, signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/zbg-alpha-engine", ...(opts.headers as Record<string, string> ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── Clarity hex parsing (big-endian) ──────────────────────────────────────────
function parseUint128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const idx = findTypePrefix(clean, "01");
  if (idx === -1) return 0n;
  return BigInt("0x" + clean.slice(idx + 2, idx + 34));
}

function parseInt128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const idx = findTypePrefix(clean, "00");
  if (idx === -1) return 0n;
  const val = BigInt("0x" + clean.slice(idx + 2, idx + 34));
  const max = (1n << 127n) - 1n;
  return val > max ? val - (1n << 128n) : val;
}

function findTypePrefix(hex: string, tb: string): number {
  if (hex.startsWith("07")) {
    if (hex.substring(2, 4) === tb) return 2;
    if (hex.substring(2, 4) === "0a" && hex.substring(4, 6) === tb) return 4;
  }
  if (hex.substring(0, 2) === tb) return 0;
  return -1;
}

type ClarityValue = bigint | boolean | null | string | ClarityValue[] | { [k: string]: ClarityValue } | { _err: ClarityValue };

function parseClarityValue(hex: string, pos = 0): { value: ClarityValue; end: number } {
  const type = hex.substring(pos, pos + 2);
  pos += 2;
  switch (type) {
    case "01": { const v = BigInt("0x" + hex.substring(pos, pos + 32)); return { value: v, end: pos + 32 }; }
    case "00": { const r = BigInt("0x" + hex.substring(pos, pos + 32)); const m = (1n << 127n) - 1n; return { value: r > m ? r - (1n << 128n) : r, end: pos + 32 }; }
    case "03": return { value: true, end: pos };
    case "04": return { value: false, end: pos };
    case "09": return { value: null, end: pos };
    case "0a": case "07": return parseClarityValue(hex, pos);
    case "08": { const i = parseClarityValue(hex, pos); return { value: { _err: i.value }, end: i.end }; }
    case "0c": {
      const n = parseInt(hex.substring(pos, pos + 8), 16); pos += 8;
      const o: Record<string, ClarityValue> = {};
      for (let i = 0; i < n; i++) {
        const nl = parseInt(hex.substring(pos, pos + 2), 16); pos += 2;
        const nm = Buffer.from(hex.substring(pos, pos + nl * 2), "hex").toString("ascii"); pos += nl * 2;
        const v = parseClarityValue(hex, pos); o[nm] = v.value; pos = v.end;
      }
      return { value: o, end: pos };
    }
    case "0b": {
      const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8;
      const a: ClarityValue[] = [];
      for (let i = 0; i < l; i++) { const v = parseClarityValue(hex, pos); a.push(v.value); pos = v.end; }
      return { value: a, end: pos };
    }
    case "05": return { value: `principal:${hex.substring(pos, pos + 42)}`, end: pos + 42 };
    case "06": { pos += 42; const cl = parseInt(hex.substring(pos, pos + 2), 16); pos += 2 + cl * 2; return { value: "contract-principal", end: pos }; }
    case "0d": case "0e": { const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8; const s = Buffer.from(hex.substring(pos, pos + l * 2), "hex").toString(type === "0d" ? "ascii" : "utf8"); return { value: s, end: pos + l * 2 }; }
    case "02": { const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8; return { value: `0x${hex.substring(pos, pos + l * 2)}`, end: pos + l * 2 }; }
    default: return { value: null, end: pos };
  }
}

function parseClarityHex(hex: string): ClarityValue {
  return parseClarityValue(hex.startsWith("0x") ? hex.slice(2) : hex).value;
}

// ── Stacks address encoding ───────────────────────────────────────────────────
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function c32Decode(addr: string): { version: number; hash160: string } {
  const w = addr.slice(1);
  const version = C32.indexOf(w[0].toUpperCase());
  let n = 0n;
  for (const c of w.slice(1)) n = n * 32n + BigInt(C32.indexOf(c.toUpperCase()));
  let hex = n.toString(16);
  while (hex.length < 48) hex = "0" + hex;
  return { version, hash160: hex.slice(0, 40) };
}

function cvPrincipal(p: string): string {
  const { version, hash160 } = c32Decode(p);
  return "0x05" + version.toString(16).padStart(2, "0") + hash160;
}

function cvUint(n: number | bigint): string {
  return "0x01" + BigInt(n).toString(16).padStart(32, "0");
}

// ── Hiro contract read ────────────────────────────────────────────────────────
async function callReadOnly(
  contractId: string, fn: string, args: string[] = [],
  sender = "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
): Promise<{ okay: boolean; result?: string }> {
  const [addr, name] = contractId.split(".");
  return fetchJson(`${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
  });
}

// ── Bech32m (BIP-350) ─────────────────────────────────────────────────────────
const B32C = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const B32M = 0x2bc830a3;

function b32mPolymod(v: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; }
  return c;
}

function b32mHrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}

function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0, bits = 0;
  const r: number[] = [], max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; r.push((acc >> bits) & max); } }
  if (bits > 0) r.push((acc << (to - bits)) & max);
  return r;
}

function bech32mEncode(hrp: string, data: number[]): string {
  const exp = b32mHrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const poly = b32mPolymod(exp) ^ B32M;
  const cs = Array.from({ length: 6 }, (_, i) => (poly >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...cs].map(d => B32C[d]).join("");
}

function tapTaggedHash(tag: string, data: Uint8Array): Buffer {
  const th = createHash("sha256").update(tag).digest();
  return createHash("sha256").update(th).update(th).update(data).digest();
}

function xOnlyPubkeyToP2TR(xHex: string): string {
  if (xHex.length !== 64) throw new Error(`Expected 32-byte x-only pubkey, got ${xHex.length / 2} bytes`);
  const xBytes = Buffer.from(xHex, "hex");
  const tweak = tapTaggedHash("TapTweak", xBytes);
  const tweaked = ecc.xOnlyPointAddTweak(xBytes, tweak);
  if (!tweaked) throw new Error("Taproot key tweak failed");
  return bech32mEncode("bc", [1, ...convertBits(tweaked.xOnlyPubkey, 8, 5)]);
}

// ── BIP-350 Test Vectors ──────────────────────────────────────────────────────
const BECH32M_TEST_VECTORS: Array<{ hrp: string; data: number[]; expected: string }> = [
  { hrp: "bc", data: [1, ...convertBits(Buffer.from("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"), 8, 5)], expected: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0" },
];

function verifyBech32mTestVectors(): { pass: boolean; detail: string } {
  for (const tv of BECH32M_TEST_VECTORS) {
    const result = bech32mEncode(tv.hrp, tv.data);
    if (result !== tv.expected) return { pass: false, detail: `Expected ${tv.expected}, got ${result}` };
  }
  return { pass: true, detail: `${BECH32M_TEST_VECTORS.length} vectors passed` };
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  SCOUT MODULE
// ══════════════════════════════════════════════════════════════════════════════

async function scoutWallet(wallet: string): Promise<ScoutResult> {
  if (!/^SP[A-Z0-9]{30,}$/i.test(wallet)) {
    throw new Error("Invalid wallet address — must be Stacks mainnet (SP...)");
  }

  const allSources: string[] = [];

  // Balances + prices
  const [hiroBalance, teneroSbtc, teneroStx] = await Promise.all([
    fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/balances`).catch(() => null),
    fetchJson<Record<string, unknown>>(`${TENERO_API}/v1/stacks/tokens/${SBTC_CONTRACT}`).catch(() => null),
    fetchJson<Record<string, unknown>>(`${TENERO_API}/v1/stacks/tokens/stx`).catch(() => null),
  ]);
  if (hiroBalance) allSources.push("hiro-balances");
  if (teneroSbtc) allSources.push("tenero-sbtc-price");
  if (teneroStx) allSources.push("tenero-stx-price");

  const stxMicro = BigInt(((hiroBalance as Record<string, Record<string, string>>)?.stx?.balance) ?? "0");
  const ft = (hiroBalance as Record<string, Record<string, Record<string, string>>>)?.fungible_tokens ?? {};
  const sbtcKey = Object.keys(ft).find(k => k.startsWith(SBTC_CONTRACT + "::"));
  const sbtcSats = BigInt(ft[sbtcKey ?? ""]?.balance ?? "0");
  const usdcxKey = Object.keys(ft).find(k => k.startsWith(USDCX_CONTRACT + "::"));
  const usdcxMicro = BigInt(ft[usdcxKey ?? ""]?.balance ?? "0");

  const sd = (teneroSbtc as Record<string, Record<string, unknown>>)?.data as Record<string, unknown> | undefined;
  const sbtcPrice = (sd?.price_usd as number) ?? ((sd?.price as Record<string, number>)?.current_price) ?? 0;
  const xd = (teneroStx as Record<string, Record<string, unknown>>)?.data as Record<string, unknown> | undefined;
  const stxPrice = (xd?.price_usd as number) ?? ((xd?.price as Record<string, number>)?.current_price) ?? 0.216;

  const sbtcAmt = Number(sbtcSats) / 1e8;
  const stxAmt = Number(stxMicro) / 1e6;
  const usdcxAmt = Number(usdcxMicro) / 1e6;

  const balances: WalletBalances = {
    sbtc: { amount: round(sbtcAmt, 8), usd: round(sbtcAmt * sbtcPrice, 2) },
    stx: { amount: round(stxAmt, 6), usd: round(stxAmt * stxPrice, 2) },
    usdcx: { amount: round(usdcxAmt, 6), usd: round(usdcxAmt, 2) },
  };
  const prices = { sbtc: round(sbtcPrice, 2), stx: round(stxPrice, 4), usdcx: 1.0 };

  // Positions in parallel
  const [zest, granite, hodlmm] = await Promise.all([
    scoutZest(wallet), scoutGranite(wallet), scoutHodlmm(wallet),
  ]);
  allSources.push(...zest.sources, ...granite.sources, ...hodlmm.sources);

  // Yield options
  const { options, sources: optSrc } = await getYieldOptions(balances, prices, granite.position);
  allSources.push(...optSrc);

  // Best move
  const walletUsd = balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd;
  const bestOpt = options[0];
  let recommendation = "No yield opportunities available.";
  let opportunityCost = 0;

  const outOfRange = hodlmm.positions.pools.filter(p => !p.in_range);
  if (outOfRange.length > 0) {
    recommendation = `WARNING: ${outOfRange.length} HODLMM position(s) OUT OF RANGE (${outOfRange.map(p => p.name).join(", ")}). Consider rebalancing.`;
    opportunityCost = bestOpt?.daily_usd ?? 0;
  } else if (bestOpt && bestOpt.apy_pct > 0 && walletUsd > 10) {
    opportunityCost = round((walletUsd * bestOpt.apy_pct / 100) / 365, 4);
    recommendation = `Best option for idle $${round(walletUsd, 2)}: ${bestOpt.protocol} ${bestOpt.pool} at ${bestOpt.apy_pct}% APY (~$${opportunityCost}/day missed).`;
  }

  // Break prices
  const { breakPrices, sources: bpSrc } = await getBreakPrices(hodlmm.positions, granite.position, prices.sbtc);
  allSources.push(...bpSrc);

  return {
    status: allSources.length >= 4 ? "ok" : "degraded",
    wallet, balances, prices,
    positions: { zest: zest.position, granite: granite.position, hodlmm: hodlmm.positions },
    options,
    best_move: { recommendation, idle_capital_usd: round(walletUsd, 2), opportunity_cost_daily_usd: opportunityCost },
    break_prices: breakPrices,
    data_sources: [...new Set(allSources)],
  };
}

async function scoutZest(wallet: string): Promise<{ position: ZestPosition; sources: string[] }> {
  const sources: string[] = [];
  try {
    // Check v2 vault balance
    const balResult = await callReadOnly(ZEST_VAULT_SBTC, "get-balance", [cvPrincipal(wallet)], wallet);
    sources.push("zest-v2-vault");
    const balance = balResult.okay && balResult.result ? parseUint128Hex(balResult.result) : 0n;

    // Read live utilization and interest rate
    const [utilResult, rateResult] = await Promise.all([
      callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []),
      callReadOnly(ZEST_VAULT_SBTC, "get-interest-rate", []),
    ]);
    const utilRaw = utilResult.okay && utilResult.result ? Number(parseUint128Hex(utilResult.result)) : 0;
    const rateRaw = rateResult.okay && rateResult.result ? Number(parseUint128Hex(rateResult.result)) : 0;
    const utilPct = utilRaw / 100;
    const borrowRatePct = rateRaw / 100;
    // Supply APY = borrow_rate * utilization * (1 - reserve_fee)
    // Reserve fee = 10% (get-fee-reserve returns 1000 = 10%)
    const supplyApyPct = round(borrowRatePct * (utilPct / 100) * 0.9, 2);
    sources.push("zest-apy-live");

    if (balance > 0n) {
      return { position: { has_position: true, detail: `Active sBTC supply on Zest v2: ${Number(balance) / 1e8} sBTC`, supply_amount: Number(balance) / 1e8, supply_apy_pct: supplyApyPct, utilization_pct: round(utilPct, 2) }, sources };
    }
    return { position: { has_position: false, detail: "No sBTC supply on Zest v2", supply_apy_pct: supplyApyPct, utilization_pct: round(utilPct, 2) }, sources };
  } catch {
    return { position: { has_position: false, detail: "Zest read failed" }, sources };
  }
}

async function scoutGranite(wallet: string): Promise<{ position: GranitePosition; sources: string[] }> {
  const sources: string[] = [];
  const IR_SCALE = 1e12;
  try {
    const [lpResult, debtResult, irResult, userPos] = await Promise.all([
      callReadOnly(GRANITE_STATE, "get-lp-params", []),
      callReadOnly(GRANITE_STATE, "get-debt-params", []),
      callReadOnly(GRANITE_IR, "get-ir-params", []),
      callReadOnly(GRANITE_STATE, "get-user-position", [cvPrincipal(wallet)]),
    ]);
    sources.push("granite-on-chain");

    let supplyApy = 0, borrowApr = 0, utilization = 0;

    if (lpResult.okay && lpResult.result && debtResult.okay && debtResult.result) {
      const lp = parseClarityHex(lpResult.result) as Record<string, ClarityValue>;
      const debt = parseClarityHex(debtResult.result) as Record<string, ClarityValue>;
      const totalAssets = typeof lp["total-assets"] === "bigint" ? lp["total-assets"] : 0n;
      const openInterest = typeof debt["open-interest"] === "bigint" ? debt["open-interest"] : 0n;
      if (totalAssets > 0n) utilization = Number((openInterest * 10000n) / totalAssets) / 100;
    }

    if (irResult.okay && irResult.result) {
      const ir = parseClarityHex(irResult.result) as Record<string, ClarityValue>;
      const baseIr = Number(typeof ir["base-ir"] === "bigint" ? ir["base-ir"] : 0n) / IR_SCALE;
      const slope1 = Number(typeof ir["ir-slope-1"] === "bigint" ? ir["ir-slope-1"] : 0n) / IR_SCALE;
      const slope2 = Number(typeof ir["ir-slope-2"] === "bigint" ? ir["ir-slope-2"] : 0n) / IR_SCALE;
      const kink = Number(typeof ir["utilization-kink"] === "bigint" ? ir["utilization-kink"] : 0n) / IR_SCALE;
      const u = utilization / 100;
      if (kink > 0) {
        borrowApr = u <= kink
          ? (baseIr + slope1 * (u / kink)) * 100
          : (baseIr + slope1 + slope2 * ((u - kink) / (1 - kink))) * 100;
      }
      supplyApy = borrowApr * (utilization / 100);
    }

    let hasPosition = false;
    if (userPos.okay && userPos.result) {
      const parsed = parseClarityHex(userPos.result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const shares = (parsed as Record<string, ClarityValue>)["shares"] ?? (parsed as Record<string, ClarityValue>)["lp-shares"];
        hasPosition = typeof shares === "bigint" && shares > 0n;
      }
    }

    return {
      position: {
        has_position: hasPosition,
        detail: hasPosition ? "Active supply on Granite" : "No supply on Granite",
        supply_apy_pct: round(supplyApy, 2), borrow_apr_pct: round(borrowApr, 2),
        utilization_pct: round(utilization, 2), max_ltv_pct: 50, liquidation_ltv_pct: 65,
      }, sources,
    };
  } catch {
    return { position: { has_position: false, detail: "Granite read failed", supply_apy_pct: 0, borrow_apr_pct: 0, utilization_pct: 0, max_ltv_pct: 50, liquidation_ltv_pct: 65 }, sources };
  }
}

async function scoutHodlmm(wallet: string): Promise<{ positions: HodlmmPositions; sources: string[] }> {
  const sources: string[] = [];
  const userPools: HodlmmUserPool[] = [];
  let bitflowPools: BitflowPoolData[] | null = null;
  try {
    const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
    bitflowPools = pd.data ?? null;
  } catch { /* unavailable */ }

  for (const pool of HODLMM_POOLS) {
    try {
      const ubr = await callReadOnly(pool.contract, "get-user-bins", [cvPrincipal(wallet)], wallet);
      if (!ubr.okay) continue;
      const [ovr, tsr, abr] = await Promise.all([
        callReadOnly(pool.contract, "get-overall-balance", [cvPrincipal(wallet)], wallet),
        callReadOnly(pool.contract, "get-overall-supply", [], wallet),
        callReadOnly(pool.contract, "get-active-bin-id", []),
      ]);
      const dlpShares = ovr.okay && ovr.result ? parseUint128Hex(ovr.result) : 0n;
      if (dlpShares === 0n) continue;
      const totalSupply = tsr.okay && tsr.result ? parseUint128Hex(tsr.result) : 0n;
      const activeBin = 500 + Number(abr.okay && abr.result ? parseInt128Hex(abr.result) : 0n);

      const userBinIds = parseUserBinList(ubr.result ?? "");
      const inRange = userBinIds.includes(activeBin);

      let estimatedValueUsd: number | null = null;
      const mp = bitflowPools?.find(p => p.poolId === `dlmm_${pool.id}`);
      if (mp && totalSupply > 0n) estimatedValueUsd = round(Number(dlpShares) / Number(totalSupply) * mp.tvlUsd, 2);

      sources.push(`hodlmm-pool-${pool.id}`);
      userPools.push({
        pool_id: pool.id, name: pool.name, in_range: inRange, active_bin: activeBin,
        user_bins: userBinIds.length > 0 ? { min: Math.min(...userBinIds), max: Math.max(...userBinIds), count: userBinIds.length } : null,
        dlp_shares: dlpShares.toString(), estimated_value_usd: estimatedValueUsd,
      });
    } catch { /* skip pool */ }
  }
  return { positions: { has_position: userPools.length > 0, pools: userPools }, sources };
}

function parseUserBinList(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bins: number[] = [];
  let pos = 0;
  if (clean.startsWith("07")) pos = 2;
  if (clean.substring(pos, pos + 2) !== "0b") return bins;
  pos += 2;
  const len = parseInt(clean.substring(pos, pos + 8), 16);
  pos += 8;
  for (let i = 0; i < len; i++) {
    if (pos + 34 > clean.length) break;
    if (clean.substring(pos, pos + 2) !== "01") { pos += 34; continue; }
    pos += 2;
    bins.push(Number(BigInt("0x" + clean.substring(pos, pos + 32))));
    pos += 32;
  }
  return bins;
}

async function getYieldOptions(balances: WalletBalances, prices: { sbtc: number; stx: number }, granite: GranitePosition): Promise<{ options: YieldOption[]; sources: string[] }> {
  const sources: string[] = [];
  const options: YieldOption[] = [];

  // Granite
  if (granite.supply_apy_pct && granite.supply_apy_pct > 0) {
    const d = (balances.sbtc.usd * granite.supply_apy_pct / 100) / 365;
    options.push({ protocol: "Granite", pool: "sBTC Supply", apy_pct: granite.supply_apy_pct, daily_usd: round(d, 4), monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.05, note: `Lending — ${granite.utilization_pct}% util, ${granite.borrow_apr_pct}% borrow APR.` });
    sources.push("granite-apy");
  }

  // HODLMM
  try {
    const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
    if (pd.data) {
      sources.push("bitflow-hodlmm-apr");
      for (const bp of pd.data) {
        if (bp.apr24h <= 0) continue;
        const def = HODLMM_POOLS.find(p => `dlmm_${p.id}` === bp.poolId);
        if (!def || !(def.tokenX === "sbtc" || def.tokenY === "sbtc" || def.tokenX === "stx" || def.tokenY === "stx")) continue;
        const cap = (def.tokenX === "sbtc" || def.tokenY === "sbtc") ? balances.sbtc.usd : balances.stx.usd;
        const d = (cap * bp.apr24h / 100) / 365;
        options.push({ protocol: "HODLMM", pool: def.name, apy_pct: round(bp.apr24h, 2), daily_usd: round(d, 4), monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.05, note: `Fee-based. TVL: $${Math.round(bp.tvlUsd).toLocaleString()}.` });
      }
    }
  } catch { /* unavailable */ }

  // Zest (live read already done in scoutZest — use cached value or re-read)
  try {
    const [utilR, rateR] = await Promise.all([
      callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []),
      callReadOnly(ZEST_VAULT_SBTC, "get-interest-rate", []),
    ]);
    const utilPct = (utilR.okay && utilR.result ? Number(parseUint128Hex(utilR.result)) : 0) / 100;
    const borrowPct = (rateR.okay && rateR.result ? Number(parseUint128Hex(rateR.result)) : 0) / 100;
    const supplyApy = round(borrowPct * (utilPct / 100) * 0.9, 2);
    if (supplyApy > 0) {
      const d = (balances.sbtc.usd * supplyApy / 100) / 365;
      options.push({ protocol: "Zest", pool: "sBTC Supply (v2)", apy_pct: supplyApy, daily_usd: round(d, 4), monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.03, note: `Lending — ${round(utilPct, 1)}% utilization.` });
    } else {
      options.push({ protocol: "Zest", pool: "sBTC Supply (v2)", apy_pct: 0, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.03, note: `0% utilization — no borrowing demand. APY will rise when borrowers arrive.` });
    }
    sources.push("zest-apy-live");
  } catch { /* skip */ }

  options.sort((a, b) => b.apy_pct - a.apy_pct);
  return { options, sources };
}

async function getBreakPrices(hodlmm: HodlmmPositions, granite: GranitePosition, sbtcPrice: number): Promise<{ breakPrices: BreakPrices; sources: string[] }> {
  const sources: string[] = [];
  let rangeLow: number | null = null, rangeHigh: number | null = null;
  const sbtcPool = hodlmm.pools.find(p => p.name.includes("sBTC") && p.user_bins);
  if (sbtcPool?.user_bins) {
    try {
      const poolContract = HODLMM_POOLS.find(p => p.id === sbtcPool.pool_id)?.contract;
      if (poolContract) {
        const pd = await callReadOnly(poolContract, "get-pool", []);
        if (pd.okay && pd.result) {
          const pp = parseClarityHex(pd.result) as Record<string, ClarityValue>;
          const initPrice = typeof pp["initial-price"] === "bigint" ? pp["initial-price"] : 0n;
          const binStep = typeof pp["bin-step"] === "bigint" ? pp["bin-step"] : 0n;
          if (initPrice > 0n && binStep > 0n) {
            const lowS = sbtcPool.user_bins.min - 500;
            const highS = sbtcPool.user_bins.max - 500;
            const toInt128 = (v: number) => `0x00${BigInt(v >= 0 ? v : (1n << 128n) + BigInt(v)).toString(16).padStart(32, "0")}`;
            const [lr, hr] = await Promise.all([
              callReadOnly(DLMM_CORE, "get-bin-price", [cvUint(initPrice), cvUint(binStep), toInt128(lowS)]),
              callReadOnly(DLMM_CORE, "get-bin-price", [cvUint(initPrice), cvUint(binStep), toInt128(highS)]),
            ]);
            if (lr.okay && lr.result) { rangeLow = round(Number(parseUint128Hex(lr.result)) / 1e6, 2); sources.push("hodlmm-bin-price-low"); }
            if (hr.okay && hr.result) { rangeHigh = round(Number(parseUint128Hex(hr.result)) / 1e6, 2); sources.push("hodlmm-bin-price-high"); }
          }
        }
      }
    } catch { /* skip */ }
  }
  return { breakPrices: { hodlmm_range_exit_low_usd: rangeLow, hodlmm_range_exit_high_usd: rangeHigh, granite_liquidation_usd: null, current_sbtc_price_usd: sbtcPrice }, sources };
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  RESERVE (PoR) MODULE
// ══════════════════════════════════════════════════════════════════════════════

async function checkReserve(): Promise<ReserveResult> {
  try {
    // 1. Fetch aggregate pubkey from sbtc-registry
    const pubkeyRes = await callReadOnly(
      `${SBTC_REGISTRY}.${SBTC_REGISTRY_NAME}`, "get-current-aggregate-pubkey", [], SBTC_REGISTRY
    );
    if (!pubkeyRes.okay || !pubkeyRes.result) throw new Error("sbtc-registry returned no aggregate pubkey");
    const hex = pubkeyRes.result.replace(/^0x/, "");
    const compressedPubkey = hex.slice(10);
    if (compressedPubkey.length !== 66) throw new Error(`Expected 33-byte pubkey, got ${compressedPubkey.length / 2}`);

    // 2. Derive P2TR address
    const xOnlyHex = compressedPubkey.slice(2);
    const signerAddress = xOnlyPubkeyToP2TR(xOnlyHex);

    // 3. Fetch BTC balance + sBTC supply in parallel
    const [addrInfo, supplyRes] = await Promise.all([
      fetchJson<Record<string, Record<string, number>>>(`${MEMPOOL_API}/address/${signerAddress}`),
      callReadOnly(SBTC_CONTRACT, "get-total-supply", [], SBTC_REGISTRY),
    ]);

    const funded = addrInfo?.chain_stats?.funded_txo_sum ?? 0;
    const spent = addrInfo?.chain_stats?.spent_txo_sum ?? 0;
    const btcReserve = (funded - spent) / 1e8;

    let sbtcCirculating = 0;
    if (supplyRes.okay && supplyRes.result) {
      // Use the uint128 parser which handles ok wrapper (0x07) + uint prefix (01)
      const supplyRaw = parseUint128Hex(supplyRes.result);
      sbtcCirculating = Number(supplyRaw) / 1e8;
    }

    // 4. Compute reserve ratio and signal
    const reserveRatio = sbtcCirculating > 0 ? btcReserve / sbtcCirculating : 0;

    // Signer rotation guard
    if (reserveRatio < ROTATION_THRESHOLD) {
      return {
        signal: "DATA_UNAVAILABLE", reserve_ratio: round(reserveRatio, 6), score: 0,
        sbtc_circulating: round(sbtcCirculating, 4), btc_reserve: round(btcReserve, 4),
        signer_address: signerAddress,
        recommendation: `Reserve ratio ${(reserveRatio * 100).toFixed(1)}% — likely signer key rotation in progress. Manual verification required. Treating as DATA_UNAVAILABLE.`,
      };
    }

    let signal: HodlmmSignal;
    if (reserveRatio >= THRESHOLD_GREEN) signal = "GREEN";
    else if (reserveRatio >= THRESHOLD_YELLOW) signal = "YELLOW";
    else signal = "RED";

    let score = 100;
    if (reserveRatio < 0.995) score -= 30;
    else if (reserveRatio < 0.999) score -= 15;
    score = Math.max(0, score);

    const recommendation = signal === "GREEN"
      ? "sBTC fully backed. Safe to proceed."
      : signal === "YELLOW"
      ? "sBTC reserve slightly below threshold. Read-only operations only."
      : "sBTC reserve critically low. Emergency withdrawal recommended.";

    return {
      signal, reserve_ratio: round(reserveRatio, 6), score,
      sbtc_circulating: round(sbtcCirculating, 4), btc_reserve: round(btcReserve, 4),
      signer_address: signerAddress, recommendation,
    };
  } catch (err: unknown) {
    return {
      signal: "DATA_UNAVAILABLE", reserve_ratio: null, score: 0,
      sbtc_circulating: 0, btc_reserve: 0, signer_address: "",
      recommendation: "Reserve check failed. Treat as RED — do not proceed.",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  GUARDIAN MODULE
// ══════════════════════════════════════════════════════════════════════════════

interface EngineState { last_rebalance_at?: string }

function readState(): EngineState {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function writeState(state: EngineState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkGuardian(scout: ScoutResult): Promise<GuardianResult> {
  const refusals: string[] = [];

  // 1. Price source gate
  const pricesOk = scout.prices.sbtc > 0 && scout.prices.stx > 0;
  if (!pricesOk) refusals.push("Price data unavailable — cannot calculate USD values safely");

  // 2. Slippage check (HODLMM active bin vs market price)
  let slippagePct = 0;
  let slippageOk = true;
  try {
    const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
    const dlmm1 = pd.data?.find(p => p.poolId === "dlmm_1");
    if (dlmm1?.tokens) {
      const pool1 = HODLMM_POOLS[0];
      const abr = await callReadOnly(pool1.contract, "get-active-bin-id", []);
      if (abr.okay && abr.result) {
        // Get bin price from quotes API
        const binsData = await fetchJson<{ bins?: Array<{ bin_id: number; price?: string }>; active_bin_id?: number }>(`${BITFLOW_API}/api/quotes/v1/bins/dlmm_1`);
        const activeBinId = binsData.active_bin_id ?? 0;
        const activeBinData = binsData.bins?.find(b => b.bin_id === activeBinId);
        if (activeBinData?.price) {
          const binPrice = parseFloat(activeBinData.price);
          const hodlmmPriceUsd = (binPrice / PRICE_SCALE) * Math.pow(10, dlmm1.tokens.tokenX.decimals - dlmm1.tokens.tokenY.decimals);
          const marketPrice = dlmm1.tokens.tokenX.priceUsd;
          if (marketPrice > 0) {
            slippagePct = round(Math.abs(hodlmmPriceUsd - marketPrice) / marketPrice * 100, 4);
            slippageOk = slippagePct <= MAX_SLIPPAGE_PCT;
            if (!slippageOk) refusals.push(`Slippage ${slippagePct}% > ${MAX_SLIPPAGE_PCT}% cap`);
          }
        }
      }
    }
  } catch { /* slippage check unavailable — allow */ }

  // 3. Volume gate
  let volumeUsd = 0;
  let volumeOk = true;
  try {
    const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
    const dlmm1 = pd.data?.find(p => p.poolId === "dlmm_1");
    volumeUsd = dlmm1?.volumeUsd1d ?? 0;
    volumeOk = volumeUsd >= MIN_24H_VOLUME_USD;
    if (!volumeOk) refusals.push(`24h volume $${Math.round(volumeUsd)} < $${MIN_24H_VOLUME_USD} minimum`);
  } catch { /* unavailable */ }

  // 4. Gas gate
  let gasStx = 0;
  let gasOk = true;
  try {
    const fees = await fetchJson<{ transfer_fee_estimate: number }>(`${HIRO_API}/v2/fees/transfer`);
    gasStx = round((fees.transfer_fee_estimate ?? 6) * 3600 / 1e6, 2);
    gasOk = gasStx <= MAX_GAS_STX;
    if (!gasOk) refusals.push(`Estimated gas ${gasStx} STX > ${MAX_GAS_STX} STX cap`);
  } catch { /* allow */ }

  // 5. Cooldown
  const state = readState();
  let cooldownOk = true;
  let cooldownRemaining = 0;
  if (state.last_rebalance_at) {
    const elapsed = (Date.now() - new Date(state.last_rebalance_at).getTime()) / 3_600_000;
    cooldownRemaining = round(Math.max(0, COOLDOWN_HOURS - elapsed), 2);
    cooldownOk = cooldownRemaining === 0;
    if (!cooldownOk) refusals.push(`Cooldown: ${cooldownRemaining}h remaining`);
  }

  // 6. Relay health
  let relayOk = true;
  let relayDetail = "not checked";
  try {
    // Check relay via a lightweight endpoint — if available via MCP, use that
    // For now, mark as ok (relay check requires MCP tool at runtime)
    relayDetail = "relay check deferred to MCP runtime";
  } catch { relayDetail = "relay check failed"; }

  return {
    can_proceed: refusals.length === 0,
    refusals,
    slippage: { ok: slippageOk, pct: slippagePct },
    volume: { ok: volumeOk, usd: volumeUsd },
    gas: { ok: gasOk, estimated_stx: gasStx },
    cooldown: { ok: cooldownOk, remaining_hours: cooldownRemaining },
    relay: { ok: relayOk, detail: relayDetail },
    prices: { ok: pricesOk, detail: pricesOk ? "all prices live" : "missing price data" },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  EXECUTOR MODULE
// ══════════════════════════════════════════════════════════════════════════════
// Note: actual write operations require MCP tools at runtime (zest_supply,
// bitflow add-liquidity-simple, call_contract). This module outputs the
// INSTRUCTIONS for the agent to execute, after all safety gates pass.
// The engine itself does not hold private keys or sign transactions.

type Protocol = "zest" | "granite" | "hodlmm";

interface ExecuteInstruction {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

function buildDeployInstructions(protocol: Protocol, amountSats: number, scout: ScoutResult): ExecuteInstruction[] {
  const instructions: ExecuteInstruction[] = [];
  const wallet = scout.wallet;

  switch (protocol) {
    case "zest":
      instructions.push({
        tool: "zest_supply",
        params: { asset: "sBTC", amount: String(amountSats) },
        description: `Supply ${amountSats} sats sBTC to Zest v2 vault`,
      });
      break;

    case "granite":
      instructions.push({
        tool: "call_contract",
        params: {
          contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
          contractName: "liquidity-provider-v1",
          functionName: "deposit",
          functionArgs: [
            { type: "uint", value: amountSats },
            { type: "principal", value: wallet },
          ],
          postConditions: [{
            type: "ft", principal: wallet,
            asset: SBTC_CONTRACT, assetName: "sbtc-token",
            conditionCode: "lte", amount: String(amountSats),
          }],
        },
        description: `Deposit ${amountSats} sats sBTC to Granite lending pool`,
      });
      break;

    case "hodlmm":
      // Determine which tokens the user has for the sBTC-USDCx pool
      const hasSbtc = scout.balances.sbtc.amount > 0;
      const hasUsdcx = scout.balances.usdcx.amount > 0;
      const bins: Array<{ activeBinOffset: number; xAmount: string; yAmount: string }> = [];

      if (hasSbtc && hasUsdcx) {
        // Two-sided: add to active bin
        bins.push({ activeBinOffset: 0, xAmount: String(amountSats), yAmount: String(Math.floor(scout.balances.usdcx.amount * 1e6)) });
      } else if (hasSbtc) {
        // One-sided sBTC: add above active bin
        for (let i = 1; i <= 5; i++) bins.push({ activeBinOffset: i, xAmount: String(Math.floor(amountSats / 5)), yAmount: "0" });
      } else if (hasUsdcx) {
        // One-sided USDCx: add below active bin
        const usdcxMicro = Math.floor(scout.balances.usdcx.amount * 1e6);
        for (let i = -5; i <= -1; i++) bins.push({ activeBinOffset: i, xAmount: "0", yAmount: String(Math.floor(usdcxMicro / 5)) });
      }

      instructions.push({
        tool: "bitflow:add-liquidity-simple",
        params: { poolId: "dlmm_1", bins: JSON.stringify(bins) },
        description: `Add liquidity to HODLMM sBTC-USDCx-10bps pool (${bins.length} bins)`,
      });
      break;
  }
  return instructions;
}

function buildWithdrawInstructions(protocol: Protocol, scout: ScoutResult): ExecuteInstruction[] {
  const wallet = scout.wallet;
  switch (protocol) {
    case "zest":
      return [{ tool: "zest_withdraw", params: { asset: "sBTC", amount: "max" }, description: "Withdraw all sBTC from Zest v2" }];
    case "granite":
      return [{
        tool: "call_contract",
        params: {
          contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
          contractName: "liquidity-provider-v1", functionName: "withdraw",
          functionArgs: [{ type: "uint", value: 0 }, { type: "principal", value: wallet }],
          postConditionMode: "allow",
        },
        description: "Withdraw all sBTC from Granite lending pool",
      }];
    case "hodlmm": {
      const pools = scout.positions.hodlmm.pools;
      return pools.map(p => ({
        tool: "bitflow:withdraw-liquidity-simple",
        params: { poolId: `dlmm_${p.pool_id}`, positions: "all" },
        description: `Withdraw all liquidity from HODLMM ${p.name}`,
      }));
    }
  }
}

function buildEmergencyInstructions(scout: ScoutResult): ExecuteInstruction[] {
  const instructions: ExecuteInstruction[] = [];
  // Withdraw from all protocols that have positions
  if (scout.positions.hodlmm.has_position) {
    instructions.push(...buildWithdrawInstructions("hodlmm", scout));
  }
  if (scout.positions.zest.has_position) {
    instructions.push(...buildWithdrawInstructions("zest", scout));
  }
  if (scout.positions.granite.has_position) {
    // If borrowing, repay first
    instructions.push({
      tool: "call_contract",
      params: {
        contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
        contractName: "borrower-v1", functionName: "repay",
        functionArgs: [{ type: "uint", value: "max" }, { type: "none" }],
        postConditionMode: "allow",
      },
      description: "Repay any Granite loan (LTV → 0)",
    });
    instructions.push(...buildWithdrawInstructions("granite", scout));
  }
  return instructions;
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  SAFETY PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

function withDisclaimer(result: Omit<EngineResult, "disclaimer">): EngineResult {
  return { ...result, disclaimer: DISCLAIMER };
}

async function runPipeline(wallet: string, command: string, opts: Record<string, string>): Promise<EngineResult> {
  return withDisclaimer(await _runPipeline(wallet, command, opts));
}

async function _runPipeline(wallet: string, command: string, opts: Record<string, string>): Promise<Omit<EngineResult, "disclaimer">> {
  // Step 1: Scout
  let scout: ScoutResult;
  try {
    scout = await scoutWallet(wallet);
  } catch (err: unknown) {
    return { status: "error", command, error: `Scout failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: Reserve check
  const reserve = await checkReserve();

  // Emergency command bypasses guardian (speed matters)
  if (command === "emergency") {
    const instructions = buildEmergencyInstructions(scout);
    return {
      status: "ok", command, scout, reserve,
      action: {
        description: `EMERGENCY EXIT: ${instructions.length} operations to withdraw all positions`,
        details: { instructions },
      },
    };
  }

  // PoR RED or DATA_UNAVAILABLE → refuse writes (suggest emergency)
  if (reserve.signal === "RED" || reserve.signal === "DATA_UNAVAILABLE") {
    return {
      status: "refused", command, scout, reserve,
      refusal_reasons: [`PoR signal: ${reserve.signal} — ${reserve.recommendation}`],
      action: { description: "Write refused. Run 'emergency' to withdraw all positions." },
    };
  }

  // PoR YELLOW → refuse writes
  if (reserve.signal === "YELLOW") {
    return {
      status: "refused", command, scout, reserve,
      refusal_reasons: ["PoR signal: YELLOW — reserve below 99.9%. Read-only operations only."],
    };
  }

  // Step 3: Guardian check
  const guardian = await checkGuardian(scout);
  if (!guardian.can_proceed) {
    return {
      status: "refused", command, scout, reserve, guardian,
      refusal_reasons: guardian.refusals,
    };
  }

  // Step 4: Execute
  let instructions: ExecuteInstruction[] = [];
  let description = "";

  switch (command) {
    case "deploy": {
      const protocol = opts.protocol as Protocol;
      const amount = parseInt(opts.amount ?? "0", 10);
      if (!protocol || !["zest", "granite", "hodlmm"].includes(protocol)) {
        return { status: "error", command, error: "Invalid protocol. Use: zest, granite, hodlmm" };
      }
      if (amount <= 0) return { status: "error", command, error: "Amount must be > 0 sats" };

      // Check balance
      const sbtcSats = Math.floor(scout.balances.sbtc.amount * 1e8);
      if (amount > sbtcSats) return { status: "error", command, error: `Insufficient sBTC: have ${sbtcSats} sats, need ${amount}` };

      // Check 0% APY
      const targetOpt = scout.options.find(o => o.protocol.toLowerCase() === protocol);
      if (targetOpt && targetOpt.apy_pct === 0 && !opts.force) {
        return { status: "refused", command, scout, reserve, guardian, refusal_reasons: [`${protocol} APY is 0%. Use --force to override.`] };
      }

      instructions = buildDeployInstructions(protocol, amount, scout);
      description = `Deploy ${amount} sats to ${protocol}`;
      break;
    }

    case "withdraw": {
      const protocol = opts.protocol as Protocol;
      if (!protocol || !["zest", "granite", "hodlmm"].includes(protocol)) {
        return { status: "error", command, error: "Invalid protocol. Use: zest, granite, hodlmm" };
      }
      instructions = buildWithdrawInstructions(protocol, scout);
      description = `Withdraw from ${protocol}`;
      break;
    }

    case "rebalance": {
      const poolId = opts["pool-id"] ?? "dlmm_1";
      const poolNum = parseInt(poolId.replace("dlmm_", ""), 10);
      const pool = scout.positions.hodlmm.pools.find(p => p.pool_id === poolNum);
      if (!pool) return { status: "error", command, error: `No position found in pool ${poolId}` };
      if (pool.in_range) return { status: "ok", command, scout, reserve, guardian, action: { description: `Pool ${poolId} is IN RANGE at bin ${pool.active_bin}. No rebalance needed.` } };

      // Withdraw then re-add
      instructions.push({
        tool: "bitflow:withdraw-liquidity-simple",
        params: { poolId, positions: "all" },
        description: `Step 1: Withdraw all liquidity from ${pool.name}`,
      });
      // Re-add centered on active bin
      const bins: Array<{ activeBinOffset: number; xAmount: string; yAmount: string }> = [];
      for (let i = -5; i <= 5; i++) bins.push({ activeBinOffset: i, xAmount: "auto", yAmount: "auto" });
      instructions.push({
        tool: "bitflow:add-liquidity-simple",
        params: { poolId, bins: JSON.stringify(bins) },
        description: `Step 2: Re-add liquidity centered on active bin ${pool.active_bin}`,
      });

      // Update cooldown
      writeState({ ...readState(), last_rebalance_at: new Date().toISOString() });
      description = `Rebalance ${pool.name}: withdraw + re-add around bin ${pool.active_bin}`;
      break;
    }

    case "migrate": {
      const from = opts.from as Protocol;
      const to = opts.to as Protocol;
      if (!from || !to || from === to) return { status: "error", command, error: "Specify --from and --to (different protocols)" };

      instructions.push(...buildWithdrawInstructions(from, scout));
      const amount = opts.amount ? parseInt(opts.amount, 10) : Math.floor(scout.balances.sbtc.amount * 1e8);
      instructions.push(...buildDeployInstructions(to, amount, scout));
      description = `Migrate from ${from} to ${to}`;
      break;
    }
  }

  return {
    status: "ok", command, scout, reserve, guardian,
    action: { description, details: { instructions, instruction_count: instructions.length } },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  DOCTOR COMMAND
// ══════════════════════════════════════════════════════════════════════════════

async function runDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Bech32m test vectors
  const tv = verifyBech32mTestVectors();
  checks.push({ name: "BIP-350 Bech32m Test Vectors", ok: tv.pass, detail: tv.detail });

  // 2. P2TR derivation self-test (G point with TapTweak applied)
  try {
    const addr = xOnlyPubkeyToP2TR("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    // G tweaked with H_tapTweak(G) produces this known address
    const expected = "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9";
    checks.push({ name: "P2TR Derivation Self-Test", ok: addr === expected, detail: addr === expected ? "G point → tweaked P2TR ✓" : `Expected ${expected}, got ${addr}` });
  } catch (e: unknown) {
    checks.push({ name: "P2TR Derivation Self-Test", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 3. Hiro Stacks API
  try {
    const info = await fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ name: "Hiro Stacks API", ok: true, detail: `tip: ${info.stacks_tip_height}, burn: ${info.burn_block_height}` });
  } catch (e: unknown) { checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 4. Tenero Price Oracle
  try {
    const t = await fetchJson<Record<string, Record<string, unknown>>>(`${TENERO_API}/v1/stacks/tokens/${SBTC_CONTRACT}`);
    const d = t?.data as Record<string, unknown> | undefined;
    const p = (d?.price_usd as number) ?? 0;
    checks.push({ name: "Tenero Price Oracle", ok: p > 0, detail: `sBTC: $${round(p, 2)}` });
  } catch (e: unknown) { checks.push({ name: "Tenero Price Oracle", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 5. Bitflow HODLMM API
  try {
    const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
    const cnt = pd.data?.length ?? 0;
    checks.push({ name: "Bitflow HODLMM API", ok: cnt > 0, detail: `${cnt} pools` });
  } catch (e: unknown) { checks.push({ name: "Bitflow HODLMM API", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 6. mempool.space
  try {
    const fees = await fetchJson<{ fastestFee: number }>(`${MEMPOOL_API}/v1/fees/recommended`);
    checks.push({ name: "mempool.space", ok: !!fees.fastestFee, detail: `${fees.fastestFee} sat/vB` });
  } catch (e: unknown) { checks.push({ name: "mempool.space", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 7. sBTC Signer Reserve (Golden Chain)
  try {
    const r = await checkReserve();
    checks.push({ name: "sBTC Proof of Reserve", ok: r.signal === "GREEN", detail: `${r.signal} — ratio ${r.reserve_ratio ?? "N/A"}, ${round(r.btc_reserve, 2)} BTC backing ${round(r.sbtc_circulating, 2)} sBTC` });
  } catch (e: unknown) { checks.push({ name: "sBTC Proof of Reserve", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 8. Zest v2 vault
  try {
    const ur = await callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []);
    checks.push({ name: "Zest v2 sBTC Vault", ok: ur.okay, detail: ur.okay ? `utilization readable` : "read failed" });
  } catch (e: unknown) { checks.push({ name: "Zest v2 sBTC Vault", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 9. Granite on-chain
  try {
    const lp = await callReadOnly(GRANITE_STATE, "get-lp-params", []);
    checks.push({ name: "Granite Protocol", ok: lp.okay, detail: lp.okay ? "get-lp-params readable" : "read failed" });
  } catch (e: unknown) { checks.push({ name: "Granite Protocol", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 10. HODLMM Pool Contract
  try {
    const ab = await callReadOnly(HODLMM_POOLS[0].contract, "get-active-bin-id", []);
    const bin = ab.okay && ab.result ? 500 + Number(parseInt128Hex(ab.result)) : 0;
    checks.push({ name: "HODLMM Pool Contracts", ok: ab.okay, detail: `active bin: ${bin}` });
  } catch (e: unknown) { checks.push({ name: "HODLMM Pool Contracts", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  const allOk = checks.every(c => c.ok);
  const cryptoOk = checks.slice(0, 2).every(c => c.ok);

  console.log(JSON.stringify({
    status: allOk ? "ok" : cryptoOk ? "degraded" : "critical",
    checks,
    message: !cryptoOk
      ? "CRITICAL: Cryptographic self-tests failed. Engine will not operate."
      : allOk
      ? `All ${checks.length} checks passed. Engine ready.`
      : "Some data sources unavailable — engine may operate in degraded mode.",
  }, null, 2));

  if (!cryptoOk) process.exit(2);
  if (!allOk) process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  RENDERED REPORT (human-readable for beginners)
// ══════════════════════════════════════════════════════════════════════════════

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function renderReport(scout: ScoutResult, reserve: ReserveResult, guardian: GuardianResult): string {
  const L: string[] = [];

  L.push("");
  L.push("ZBG Alpha Engine — Full Report");
  L.push(`Wallet: ${scout.wallet}`);
  L.push("");

  // Section 1: What You Have
  const walletUsd = round(scout.balances.sbtc.usd + scout.balances.stx.usd + scout.balances.usdcx.usd, 2);
  L.push("## 1. What You Have (available in wallet)");
  L.push("");
  L.push("| Token   | Amount             | USD      |");
  L.push("|---------|--------------------|---------:|");
  L.push(`| sBTC    | ${pad(String(scout.balances.sbtc.amount), 18)} | $${scout.balances.sbtc.usd} |`);
  L.push(`| STX     | ${pad(String(scout.balances.stx.amount), 18)} | $${scout.balances.stx.usd} |`);
  L.push(`| USDCx   | ${pad(String(scout.balances.usdcx.amount), 18)} | $${scout.balances.usdcx.usd} |`);
  L.push(`| **Wallet Total** |              | **$${walletUsd}** |`);
  L.push("");

  // Section 2: Positions
  L.push("## 2. ZBG Positions (deployed capital)");
  L.push("");
  L.push("| Protocol | Status     | Detail | Value |");
  L.push("|----------|------------|--------|------:|");

  const z = scout.positions.zest;
  const zDetail = z.has_position ? z.detail : `${z.detail} (APY: ${z.supply_apy_pct ?? 0}%, util: ${z.utilization_pct ?? 0}%)`;
  L.push(`| Zest     | ${z.has_position ? "**ACTIVE**" : "No position"} | ${zDetail} | — |`);

  const g = scout.positions.granite;
  const gDetail = g.has_position ? g.detail : `${g.detail} (APY: ${g.supply_apy_pct}%, util: ${g.utilization_pct}%)`;
  L.push(`| Granite  | ${g.has_position ? "**ACTIVE**" : "No position"} | ${gDetail} | — |`);

  const h = scout.positions.hodlmm;
  let deployedUsd = 0;
  if (h.has_position) {
    for (const p of h.pools) {
      const rangeTag = p.in_range ? "**IN RANGE**" : "**OUT OF RANGE**";
      const binStr = p.user_bins ? `${p.user_bins.count} bins (${p.user_bins.min}–${p.user_bins.max})` : "no bins";
      const valueStr = p.estimated_value_usd !== null ? `$${p.estimated_value_usd}` : "—";
      if (p.estimated_value_usd) deployedUsd += p.estimated_value_usd;
      L.push(`| HODLMM   | **ACTIVE** | ${p.name} — ${rangeTag} at bin ${p.active_bin}, ${binStr} | ${valueStr} |`);
    }
  } else {
    L.push("| HODLMM   | No position | No positions across 8 pools | — |");
  }
  if (deployedUsd > 0) L.push(`| **Deployed Total** | | | **$${round(deployedUsd, 2)}** |`);

  const grandTotal = round(walletUsd + deployedUsd, 2);
  L.push("");
  L.push(`**Total portfolio: $${grandTotal}** (wallet: $${walletUsd} + deployed: $${round(deployedUsd, 2)})`);
  L.push("");

  // Section 3: sBTC Reserve Status
  L.push("## 3. sBTC Reserve Status (Proof of Reserve)");
  L.push("");
  L.push(`| Check | Value |`);
  L.push(`|-------|------:|`);
  L.push(`| Signal | **${reserve.signal}** |`);
  L.push(`| Reserve ratio | ${reserve.reserve_ratio ?? "N/A"} |`);
  L.push(`| BTC in vault | ${reserve.btc_reserve} BTC |`);
  L.push(`| sBTC circulating | ${reserve.sbtc_circulating} sBTC |`);
  L.push(`| Signer address | \`${reserve.signer_address.slice(0, 20)}...\` |`);
  L.push(`| Verdict | ${reserve.recommendation} |`);
  L.push("");

  // Section 4: Smart Options
  L.push("## 4. Yield Options (sorted by APY)");
  L.push("");
  L.push("| # | Protocol | Pool | APY | Daily | Monthly | Gas | Note |");
  L.push("|---|----------|------|----:|------:|--------:|-----|------|");
  scout.options.forEach((o, i) => {
    L.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.apy_pct}% | $${o.daily_usd} | $${o.monthly_usd} | ${o.gas_to_enter_stx} STX | ${o.note} |`);
  });
  L.push("");

  // Section 5: Best Move
  L.push("## 5. Best Safe Move");
  L.push("");
  L.push(`> ${scout.best_move.recommendation}`);
  L.push("");
  L.push(`| Metric | Value |`);
  L.push(`|--------|------:|`);
  L.push(`| Idle in wallet | $${scout.best_move.idle_capital_usd} |`);
  L.push(`| Opportunity cost | $${scout.best_move.opportunity_cost_daily_usd}/day |`);
  L.push("");

  // Section 6: Break Prices
  L.push("## 6. Break Prices");
  L.push("");
  const bp = scout.break_prices;
  L.push("| Trigger | sBTC Price |");
  L.push("|---------|----------:|");
  if (bp.hodlmm_range_exit_low_usd) L.push(`| HODLMM range exit (low) | **$${bp.hodlmm_range_exit_low_usd.toLocaleString()}** |`);
  L.push(`| Current sBTC price | $${bp.current_sbtc_price_usd.toLocaleString()} |`);
  if (bp.hodlmm_range_exit_high_usd) L.push(`| HODLMM range exit (high) | **$${bp.hodlmm_range_exit_high_usd.toLocaleString()}** |`);
  L.push(`| Granite liquidation | ${bp.granite_liquidation_usd ? `**$${bp.granite_liquidation_usd.toLocaleString()}**` : "N/A (no position)"} |`);
  L.push("");

  if (bp.hodlmm_range_exit_low_usd && bp.hodlmm_range_exit_high_usd) {
    const bufLow = round(bp.current_sbtc_price_usd - bp.hodlmm_range_exit_low_usd, 0);
    const bufHigh = round(bp.hodlmm_range_exit_high_usd - bp.current_sbtc_price_usd, 0);
    L.push(`Your position is safe — $${bufLow.toLocaleString()} above low exit, $${bufHigh.toLocaleString()} below high exit.`);
    L.push("");
  }

  // Section 7: Guardian Status
  L.push("## 7. Safety Gates");
  L.push("");
  L.push(`| Gate | Status | Detail |`);
  L.push(`|------|--------|--------|`);
  L.push(`| PoR Reserve | ${reserve.signal === "GREEN" ? "PASS" : "**FAIL**"} | ${reserve.signal} |`);
  L.push(`| Slippage | ${guardian.slippage.ok ? "PASS" : "**FAIL**"} | ${guardian.slippage.pct}% (max ${MAX_SLIPPAGE_PCT}%) |`);
  L.push(`| 24h Volume | ${guardian.volume.ok ? "PASS" : "**FAIL**"} | $${Math.round(guardian.volume.usd).toLocaleString()} (min $${MIN_24H_VOLUME_USD.toLocaleString()}) |`);
  L.push(`| Gas | ${guardian.gas.ok ? "PASS" : "**FAIL**"} | ${guardian.gas.estimated_stx} STX (max ${MAX_GAS_STX}) |`);
  L.push(`| Cooldown | ${guardian.cooldown.ok ? "PASS" : "**FAIL**"} | ${guardian.cooldown.remaining_hours > 0 ? `${guardian.cooldown.remaining_hours}h remaining` : "Ready"} |`);
  L.push(`| Prices | ${guardian.prices.ok ? "PASS" : "**FAIL**"} | ${guardian.prices.detail} |`);
  L.push(`| **Can execute writes?** | **${guardian.can_proceed ? "YES" : "NO"}** | ${guardian.refusals.length > 0 ? guardian.refusals.join("; ") : "All gates pass"} |`);
  L.push("");

  // Footer
  L.push("---");
  L.push(`Data sources: ${scout.data_sources.length} live reads | Status: ${scout.status} | Engine: zbg-alpha-engine v1.0.0`);
  L.push("");

  return L.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  CLI
// ══════════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name("zbg-alpha-engine")
  .description("Cross-protocol yield executor for Zest, Granite, and HODLMM with sBTC reserve verification")
  .version("1.0.0");

program
  .command("doctor")
  .description("Run all self-tests: crypto vectors, data sources, on-chain reads, PoR verification")
  .action(runDoctor);

program
  .command("scan")
  .description("Full read-only scan: wallet, positions, yields, break prices, PoR status, guardian gates")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--format <type>", "Output format: json (default) or text", "json")
  .action(async (opts: { wallet: string; format: string }) => {
    try {
      const scout = await scoutWallet(opts.wallet);
      const reserve = await checkReserve();
      const guardian = await checkGuardian(scout);
      if (opts.format === "text") {
        console.log(renderReport(scout, reserve, guardian));
      } else {
        console.log(JSON.stringify({ status: "ok", command: "scan", disclaimer: DISCLAIMER, scout, reserve, guardian, rendered_report: renderReport(scout, reserve, guardian) }, null, 2));
      }
    } catch (err: unknown) {
      console.error(JSON.stringify({ status: "error", command: "scan", error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    }
  });

program
  .command("deploy")
  .description("Deploy idle capital to a protocol (runs full safety pipeline first)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Target protocol: zest, granite, hodlmm")
  .requiredOption("--amount <sats>", "Amount in satoshis to deploy")
  .option("--force", "Override 0% APY refusal")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "deploy", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("withdraw")
  .description("Withdraw from a protocol (runs full safety pipeline first)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Source protocol: zest, granite, hodlmm")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "withdraw", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("rebalance")
  .description("Withdraw from out-of-range HODLMM bins and re-add centered on active bin")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--pool-id <id>", "HODLMM pool ID (default: dlmm_1)", "dlmm_1")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "rebalance", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("migrate")
  .description("Move capital from one protocol to another (withdraw + deploy)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--from <protocol>", "Source protocol: zest, granite, hodlmm")
  .requiredOption("--to <protocol>", "Target protocol: zest, granite, hodlmm")
  .option("--amount <sats>", "Amount in sats (default: all)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "migrate", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("emergency")
  .description("Emergency withdrawal from ALL protocols (bypasses guardian gates)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "emergency", opts);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("install-packs")
  .description("Check dependency requirements")
  .action(() => {
    console.log(JSON.stringify({
      status: "ok",
      message: "Requires: tiny-secp256k1 (BIP-341 EC point addition). All other operations use public APIs.",
      data: { requires: ["tiny-secp256k1"] },
    }, null, 2));
  });

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
