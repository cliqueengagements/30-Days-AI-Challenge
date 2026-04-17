#!/usr/bin/env bun
/**
 * hodlmm-inventory-balancer — Restore a target HODLMM LP token-exposure ratio.
 *
 * Detects INVENTORY drift (token-ratio imbalance from one-sided swap flow), not
 * price drift. Executes a corrective Bitflow swap and a redeploy via
 * hodlmm-move-liquidity, gated by the shared 4h per-pool cooldown.
 *
 * Commands:
 *   install-packs — install @stacks/* deps
 *   doctor        — pre-flight: wallet, Bitflow APIs, cooldown state, state marker
 *   status        — read-only ratio + deviation per eligible pool
 *   recommend     — dry-run cycle plan (swap + redeploy plan)
 *   run           — execute cycle (requires --confirm=BALANCE)
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

// DLMM swap router — user-facing swap entrypoint with built-in min-out protection.
// Verified via contract read on 2026-04-17: swap-(x|y)-for-(y|x)-simple-multi takes
// (pool-trait, x-token-trait, y-token-trait, amount uint, min-out uint) and internally
// asserts received >= min-out (ERR_MINIMUM_RECEIVED) — contract-level slippage.
const DLMM_SWAP_ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const DLMM_SWAP_ROUTER_NAME = "dlmm-swap-router-v-1-1";

// Contract principals for tokens we support. STX wrapper implements SIP-010 but
// transfers move native STX under the hood → STX post-conditions, not FT.
const STX_WRAPPER_CONTRACT = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
// Asset names verified against on-chain `define-fungible-token` directives (2026-04-17).
// Override at runtime with TOKEN_ASSETS_OVERRIDE env var (JSON map {"contract": "asset-name"}).
const TOKEN_ASSET_NAMES: Record<string, string> = {
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token": "sbtc-token",
  "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx": "usdcx-token",
  "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc": "aeUSDC",
  "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1": "usdh",
};

const FETCH_TIMEOUT = 30_000;
const CENTER_BIN_ID = 500;
const PRICE_SCALE = 1e8;

// Reads state owned by hodlmm-move-liquidity (authoritative source for redeploy cooldown)
const MOVE_LIQUIDITY_STATE_FILE = path.join(os.homedir(), ".hodlmm-move-liquidity-state.json");
const MOVE_LIQUIDITY_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Our own state file — tracks incomplete cycles and meta-cooldown
const INVENTORY_STATE_FILE = path.join(os.homedir(), ".hodlmm-inventory-balancer-state.json");
const INVENTORY_META_COOLDOWN_MS = 60 * 60 * 1000; // 1h

const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

const DEFAULT_MIN_DRIFT_PCT = 5;
const DEFAULT_MAX_CORRECTION_SATS = 500_000;
const DEFAULT_MAX_QUOTE_STALENESS_SECONDS = 45;
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
const STX_GAS_FLOOR_USTX = 500_000n; // 0.5 STX reserved for gas
const MIN_SWAP_SATS = 1000n; // refuse tiny swaps

// Pool volume floor — refuse corrective swaps on pools whose bin-level reserves
// (across bins we'd touch) are too thin to absorb the swap without moving the
// price by more than the slippage budget. #493 safety contract: "Pool volume
// too thin to support corrective swap without moving the pool price."
// Conservative: require the active bin's reserve of the OUTPUT token to be at
// least THIN_POOL_MIN_RATIO × the expected output.
const THIN_POOL_MIN_RATIO = 3n; // active-bin reserve must be ≥ 3× expected output

// Post-broadcast verification sleep — lets the first Nakamoto block settle so
// ratio_after reflects the post-swap state. #493 step 6 requires re-reading
// and emitting before/after ratios.
const VERIFY_SLEEP_MS = 10_000;

// v1 scope: only Bitflow-tradeable HODLMM pools. JingSwap excluded.
const V1_ELIGIBLE_POOLS = new Set<string>([
  "dlmm_1", "dlmm_2", "dlmm_3", "dlmm_4", "dlmm_5", "dlmm_6", "dlmm_7", "dlmm_8",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
}

interface UserBin {
  bin_id: number;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface RatioSummary {
  pool_id: string;
  pair: string;
  active_bin: number;
  user_bins: number[];
  total_x_raw: string;
  total_y_raw: string;
  total_x_in_y: string; // Y-units — X valued at its bin price
  total_value_in_y: string;
  current_x_ratio: number; // 0..1 (fraction of value in X)
  current_y_ratio: number;
  target_x_ratio: number;
  target_y_ratio: number;
  deviation_abs: number; // |current_x - target_x|, 0..1
  quote_staleness_seconds: number;
  quote_fetched_at: string;
}

interface SwapPlan {
  direction: "X->Y" | "Y->X";
  token_in: string; // contract principal
  token_in_symbol: string;
  token_in_decimals: number;
  token_out: string;
  token_out_symbol: string;
  token_out_decimals: number;
  amount_in_raw: string;
  expected_amount_out_raw: string;
  minimum_amount_out_raw: string;
  slippage_bps: number;
  quote_source: string;
  quote_fetched_at: string;
}

interface InventoryState {
  // Per-pool state
  [poolId: string]: {
    last_cycle_at?: string;
    last_cycle_status?: "success" | "swap_done_redeploy_pending" | "aborted";
    last_swap_tx?: string;
    last_redeploy_tx?: string;
    swap_pending_details?: {
      swap_tx: string;
      swap_direction: "X->Y" | "Y->X";
      swap_amount_in_raw: string;
      swap_minimum_out_raw: string;
      target_ratio_x: number;
      captured_at: string;
    };
  };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(status: "success" | "error" | "blocked", action: string, data: unknown, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function err(action: string, message: string, data: unknown = null): never {
  out("error", action, data, message);
  process.exit(1);
}

function log(...args: unknown[]): void {
  process.stderr.write(`[inventory-balancer] ${args.join(" ")}\n`);
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }
  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as string);
  if (!fs.existsSync(WALLETS_FILE)) {
    throw new Error("No wallet found. Run: npx @aibtc/mcp-server@latest --install");
  }
  const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
  const activeWallet = (walletsJson.wallets ?? [])[0];
  if (!activeWallet?.id) throw new Error("No active wallet configured.");
  const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
  if (!fs.existsSync(keystorePath)) throw new Error(`Keystore not found at ${keystorePath}`);
  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
  const enc = keystore.encrypted;
  if (!enc?.ciphertext) {
    const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
    if (!legacyEnc) throw new Error("Keystore format unrecognized.");
    const { decryptMnemonic } = await import("@stacks/encryption" as string);
    const mnemonic = await decryptMnemonic(legacyEnc, password);
    const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
    const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
    return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
  }
  const { scryptSync, createDecipheriv } = await import("crypto");
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
    N: enc.scryptParams?.N ?? 16384,
    r: enc.scryptParams?.r ?? 8,
    p: enc.scryptParams?.p ?? 1,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8").trim();
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
  return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
}

// ─── Bitflow API reads ────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  // Bitflow App v1 response: camelCase with nested tokens.{tokenX,tokenY}.
  // No active_bin at this endpoint; we fetch it per-pool from the quotes bins endpoint.
  const raw = await fetchJson<{ data?: unknown[]; [k: string]: unknown }>(`${BITFLOW_APP}/pools?amm_type=dlmm`);
  const list = (raw.data ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  return list.map((p) => {
    const tokens = (p.tokens ?? {}) as Record<string, Record<string, unknown>>;
    const tx = tokens.tokenX ?? {};
    const ty = tokens.tokenY ?? {};
    return {
      pool_id: String(p.poolId ?? ""),
      pool_contract: String(p.poolContract ?? ""),
      token_x: String(tx.contract ?? ""),
      token_y: String(ty.contract ?? ""),
      token_x_symbol: String(tx.symbol ?? "?"),
      token_y_symbol: String(ty.symbol ?? "?"),
      token_x_decimals: Number(tx.decimals ?? 8),
      token_y_decimals: Number(ty.decimals ?? 6),
      active_bin: 0, // populated from /bins/<poolId>.active_bin_id
      bin_step: Number(p.binStep ?? 0),
    };
  });
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[]; fetched_at: string }> {
  const fetched_at = new Date().toISOString();
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  const activeBin = Number(raw.active_bin_id ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: activeBin, bins, fetched_at };
}

async function fetchUserPositions(poolId: string, wallet: string): Promise<UserBin[]> {
  // Best-effort across field-name variants — the App API returns user bins with
  // either snake_case or camelCase keys depending on endpoint version.
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
  ).catch(() => ({ bins: [] as unknown[] }));
  const bins = (raw.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => BigInt(String(b.user_liquidity ?? b.userLiquidity ?? b.liquidity ?? "0")) > 0n)
    .map((b) => ({
      bin_id: Number(b.bin_id ?? b.binId),
      liquidity: String(b.user_liquidity ?? b.userLiquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
      reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
      price: String(b.price ?? "0"),
    }));
}

async function fetchStxBalanceUstx(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, string>>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(data?.balance ?? "0");
}

async function fetchTokenBalanceRaw(wallet: string, asset: TokenAsset): Promise<bigint> {
  if (asset.kind === "stx") return fetchStxBalanceUstx(wallet);
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/balances`
  );
  const fts = (data.fungible_tokens ?? {}) as Record<string, { balance?: string }>;
  const key = `${asset.contract}::${asset.assetName}`;
  return BigInt(fts[key]?.balance ?? "0");
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/nonces`);
  const nextNonce = data.possible_next_nonce;
  if (nextNonce !== undefined && nextNonce !== null) return BigInt(Number(nextNonce));
  const lastExec = data.last_executed_tx_nonce;
  if (lastExec !== undefined && lastExec !== null) return BigInt(Number(lastExec) + 1);
  return 0n;
}

async function fetchPendingMempoolTxCount(wallet: string): Promise<number> {
  try {
    const data = await fetchJson<Record<string, unknown>>(
      `${HIRO_API}/extended/v1/address/${wallet}/mempool`
    );
    const results = data.results as unknown[] | undefined;
    return Array.isArray(results) ? results.length : 0;
  } catch {
    return 0;
  }
}

// ─── Move-liquidity cooldown ──────────────────────────────────────────────────

function readMoveLiquidityCooldownMs(poolId: string): number {
  if (!fs.existsSync(MOVE_LIQUIDITY_STATE_FILE)) return 0;
  try {
    const state = JSON.parse(fs.readFileSync(MOVE_LIQUIDITY_STATE_FILE, "utf-8")) as Record<
      string,
      { last_move_at?: string }
    >;
    const entry = state[poolId];
    if (!entry?.last_move_at) return 0;
    const elapsed = Date.now() - new Date(entry.last_move_at).getTime();
    return Math.max(0, MOVE_LIQUIDITY_COOLDOWN_MS - elapsed);
  } catch {
    return 0;
  }
}

// ─── Our state file ───────────────────────────────────────────────────────────

function loadInventoryState(): InventoryState {
  try {
    return JSON.parse(fs.readFileSync(INVENTORY_STATE_FILE, "utf-8")) as InventoryState;
  } catch {
    return {};
  }
}

function saveInventoryState(state: InventoryState): void {
  fs.writeFileSync(INVENTORY_STATE_FILE, JSON.stringify(state, null, 2));
}

function inventoryMetaCooldownMs(state: InventoryState, poolId: string): number {
  const entry = state[poolId];
  if (!entry?.last_cycle_at) return 0;
  const elapsed = Date.now() - new Date(entry.last_cycle_at).getTime();
  return Math.max(0, INVENTORY_META_COOLDOWN_MS - elapsed);
}

// ─── Ratio computer ───────────────────────────────────────────────────────────
//
// Arc's invariant: bins STRICTLY below active hold only Y; bins STRICTLY above
// hold only X; active bin holds both. Ratios MUST be price-weighted — raw sums
// misrepresent exposure because X and Y are in different units and different
// bins contribute at different prices.
//
// We express everything in Y-units (no USD conversion needed):
//   bin_value_in_y = reserve_y + reserve_x * bin_price / PRICE_SCALE
//   total_value_in_y = Σ bin_value_in_y
//   total_x_in_y = Σ (reserve_x * bin_price / PRICE_SCALE)
//   current_x_ratio = total_x_in_y / total_value_in_y

function computeRatio(
  pool: PoolMeta,
  userBins: UserBin[],
  poolBins: BinData[],
  activeBin: number,
  targetXRatio: number,
  quoteFetchedAt: string
): RatioSummary {
  const poolBinMap = new Map(poolBins.map((b) => [b.bin_id, b]));

  let totalXRaw = 0n;
  let totalYRaw = 0n;
  // Bitflow bin `price` is an integer string already scaled so that:
  //   raw_y_per_raw_x = price / PRICE_SCALE
  // No separate token-decimal math — the scale bakes the x/y decimal delta in.
  //   x_value_in_raw_y = reserve_x * price / PRICE_SCALE
  let totalXValueY = 0n; // raw-Y units (rounded-down integer)
  let totalYValueY = 0n; // raw-Y units

  for (const ub of userBins) {
    let rx = BigInt(ub.reserve_x || "0");
    let ry = BigInt(ub.reserve_y || "0");
    const pb = poolBinMap.get(ub.bin_id);
    const priceStr = (ub.price && ub.price !== "0") ? ub.price : pb?.price ?? "0";
    if ((rx === 0n && ry === 0n) && pb) {
      const poolDlp = BigInt(pb.liquidity || "0");
      const userDlp = BigInt(ub.liquidity || "0");
      if (poolDlp > 0n && userDlp > 0n) {
        rx = (userDlp * BigInt(pb.reserve_x)) / poolDlp;
        ry = (userDlp * BigInt(pb.reserve_y)) / poolDlp;
      }
    }
    totalXRaw += rx;
    totalYRaw += ry;

    const priceRaw = BigInt(priceStr || "0");
    const xValueY = priceRaw === 0n ? 0n : (rx * priceRaw) / BigInt(PRICE_SCALE);
    totalXValueY += xValueY;
    totalYValueY += ry;
  }

  const totalValueY = totalXValueY + totalYValueY;
  const currentXRatio =
    totalValueY === 0n ? 0 : Number((totalXValueY * 1_000_000n) / totalValueY) / 1_000_000;
  const currentYRatio = 1 - currentXRatio;
  const deviationAbs = Math.abs(currentXRatio - targetXRatio);

  const quoteStalenessSeconds = Math.max(0, Math.floor((Date.now() - new Date(quoteFetchedAt).getTime()) / 1000));

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin: activeBin,
    user_bins: userBins.map((b) => b.bin_id).sort((a, b) => a - b),
    total_x_raw: totalXRaw.toString(),
    total_y_raw: totalYRaw.toString(),
    total_x_in_y: totalXValueY.toString(),
    total_value_in_y: totalValueY.toString(),
    current_x_ratio: Number(currentXRatio.toFixed(4)),
    current_y_ratio: Number(currentYRatio.toFixed(4)),
    target_x_ratio: Number(targetXRatio.toFixed(4)),
    target_y_ratio: Number((1 - targetXRatio).toFixed(4)),
    deviation_abs: Number(deviationAbs.toFixed(4)),
    quote_staleness_seconds: quoteStalenessSeconds,
    quote_fetched_at: quoteFetchedAt,
  };
}

// ─── Corrective-swap planner ──────────────────────────────────────────────────
//
// Given current vs target X-ratio, pick the direction and size to bring the
// value back within target ± min-drift-pct. Cap at max-correction-sats.
// Minimum-out is computed from expected output using slippage budget.
//
// Approximation: for a single corrective swap, ignore pool-price slippage on
// the correction itself (conservative: we only correct PART of the gap each
// cycle, not all of it — meta-cooldown prevents re-firing too quickly).

interface PlannerInputs {
  ratio: RatioSummary;
  pool: PoolMeta;
  activeBinPriceScaled: bigint;
  minDriftPct: number;
  maxCorrectionSats: bigint;
  slippageBps: number;
  // 1 minus the wallet's available side. If we're over-weight X, we sell X for Y, so the swap burns X.
}

function planCorrectiveSwap(inputs: PlannerInputs): SwapPlan | null {
  const { ratio, pool, activeBinPriceScaled, maxCorrectionSats, slippageBps, minDriftPct } = inputs;
  if (ratio.deviation_abs * 100 < minDriftPct) return null;

  const totalValueY = BigInt(ratio.total_value_in_y);
  if (totalValueY === 0n || activeBinPriceScaled === 0n) return null;

  const overWeightX = ratio.current_x_ratio > ratio.target_x_ratio;
  // Halfway conservative correction — smooths flow-driven oscillation and matches
  // Arc's "conservative sizing" guidance.
  const gapAbs = Math.abs(ratio.current_x_ratio - ratio.target_x_ratio);
  const gapMicro = BigInt(Math.floor(gapAbs * 1_000_000));
  const correctionValueY = (totalValueY * gapMicro) / 2_000_000n; // in raw Y units

  // Bitflow bin price semantic: raw_y = raw_x * price / PRICE_SCALE.
  // → raw_x = raw_y * PRICE_SCALE / price.

  let amountInRaw: bigint;
  let expectedOutRaw: bigint;
  let direction: "X->Y" | "Y->X";
  let tokenIn: string;
  let tokenOut: string;
  let tokenInSymbol: string;
  let tokenOutSymbol: string;
  let tokenInDecimals: number;
  let tokenOutDecimals: number;

  if (overWeightX) {
    direction = "X->Y";
    tokenIn = pool.token_x;
    tokenOut = pool.token_y;
    tokenInSymbol = pool.token_x_symbol;
    tokenOutSymbol = pool.token_y_symbol;
    tokenInDecimals = pool.token_x_decimals;
    tokenOutDecimals = pool.token_y_decimals;
    amountInRaw = (correctionValueY * BigInt(PRICE_SCALE)) / activeBinPriceScaled;
    expectedOutRaw = correctionValueY;
  } else {
    direction = "Y->X";
    tokenIn = pool.token_y;
    tokenOut = pool.token_x;
    tokenInSymbol = pool.token_y_symbol;
    tokenOutSymbol = pool.token_x_symbol;
    tokenInDecimals = pool.token_y_decimals;
    tokenOutDecimals = pool.token_x_decimals;
    amountInRaw = correctionValueY;
    expectedOutRaw = (correctionValueY * BigInt(PRICE_SCALE)) / activeBinPriceScaled;
  }

  // Cap at max-correction-sats for the sell token (interpreted as sat-denominated for 8-dec tokens;
  // for 6-dec tokens the raw-unit cap is still the conservative practical limit).
  if (amountInRaw > maxCorrectionSats) {
    const scale = Number(amountInRaw) / Number(maxCorrectionSats);
    amountInRaw = maxCorrectionSats;
    expectedOutRaw = BigInt(Math.floor(Number(expectedOutRaw) / scale));
  }

  if (amountInRaw < MIN_SWAP_SATS) return null;

  const minimumOutRaw = (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  return {
    direction,
    token_in: tokenIn,
    token_in_symbol: tokenInSymbol,
    token_in_decimals: tokenInDecimals,
    token_out: tokenOut,
    token_out_symbol: tokenOutSymbol,
    token_out_decimals: tokenOutDecimals,
    amount_in_raw: amountInRaw.toString(),
    expected_amount_out_raw: expectedOutRaw.toString(),
    minimum_amount_out_raw: minimumOutRaw.toString(),
    slippage_bps: slippageBps,
    quote_source: `${BITFLOW_QUOTES}/bins/${ratio.pool_id}#active_bin_price`,
    quote_fetched_at: ratio.quote_fetched_at,
  };
}

// ─── Bitflow swap execution (HODLMM pool direct-call) ─────────────────────────
//
// v1 corrective swap goes through the HODLMM pool contract directly — single
// hop through the same pool we're balancing. Post-conditions: Deny with an FT
// receive condition on `minimum_amount_out_raw`.

// Unified token-kind resolver — single source of truth for "is this native STX
// (via the wrapper passthrough) or a real SIP-010?" Post-conditions, balance
// gates, and any future token-handling branch should go through this helper so
// the two codepaths cannot drift out of sync (per @arc0btc's observation on
// bff-skills #494).
type TokenAsset =
  | { kind: "stx" }
  | { kind: "ft"; contract: `${string}.${string}`; assetName: string };

function resolveTokenAsset(contract: string): TokenAsset {
  if (contract === STX_WRAPPER_CONTRACT) return { kind: "stx" };
  const override = process.env.TOKEN_ASSETS_OVERRIDE;
  let assetName: string | undefined;
  if (override) {
    try {
      const map = JSON.parse(override) as Record<string, string>;
      if (map[contract]) assetName = map[contract];
    } catch { /* ignore */ }
  }
  if (!assetName) assetName = TOKEN_ASSET_NAMES[contract];
  if (!assetName) {
    // Fall back to the contract name — safe for contracts that use
    // `(define-fungible-token <contract-name>)`, unsafe otherwise. Flagged loudly.
    assetName = contract.split(".")[1] ?? contract;
    log(`WARN: no verified asset-name for ${contract}, falling back to contract-name '${assetName}'`);
  }
  return { kind: "ft", contract: contract as `${string}.${string}`, assetName };
}

async function executeCorrectiveSwap(
  privateKey: string,
  senderAddress: string,
  pool: PoolMeta,
  plan: SwapPlan,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall,
    broadcastTransaction,
    uintCV,
    boolCV,
    listCV,
    tupleCV,
    contractPrincipalCV,
    PostConditionMode,
    AnchorMode,
    Pc,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const amountIn = BigInt(plan.amount_in_raw);
  const minOut = BigInt(plan.minimum_amount_out_raw);

  const inAsset = resolveTokenAsset(plan.token_in);

  // Post-condition: bounded upper send on the INPUT side. Allow mode because
  // the router emits pool/protocol fee transfers that vary with pool config;
  // Deny would require an explicit allowance for each fee flow. Minimum-output
  // slippage is enforced by the router's own `min-received` argument
  // (ERR_MINIMUM_RECEIVED internally). Same safety contract `hodlmm-move-liquidity`
  // uses for its DLP mint/burn flow.
  const senderPin = Pc.principal(senderAddress).willSendLte(amountIn);
  const pcs: unknown[] = [
    inAsset.kind === "stx" ? senderPin.ustx() : senderPin.ft(inAsset.contract, inAsset.assetName),
  ];

  // Canonical entrypoint: swap-simple-multi takes a list of swap tuples.
  // Single-hop in our case → list of 1. max-steps=319 (contract MAX_STEPS).
  const swapTuple = tupleCV({
    "pool-trait": contractPrincipalCV(poolAddr, poolName),
    "x-token-trait": contractPrincipalCV(xAddr, xName),
    "y-token-trait": contractPrincipalCV(yAddr, yName),
    amount: uintCV(amountIn),
    "min-received": uintCV(minOut),
    "x-for-y": boolCV(plan.direction === "X->Y"),
    // max-steps bounds how many bins the router walks. Tiny corrective swaps
    // finish in 1–2 bins; 10 gives headroom without overallocating the fold.
    "max-steps": uintCV(10),
  });

  const tx = await makeContractCall({
    contractAddress: DLMM_SWAP_ROUTER_ADDR,
    contractName: DLMM_SWAP_ROUTER_NAME,
    functionName: "swap-simple-multi",
    functionArgs: [listCV([swapTuple])],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Allow,
    postConditions: pcs as never[],
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Swap broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return result.txid as string;
}

// ─── Redeploy via hodlmm-move-liquidity CLI ───────────────────────────────────

function invokeMoveLiquidityRedeploy(poolId: string, stxAddress: string, password: string | undefined): string {
  const cli =
    process.env.HODLMM_MOVE_LIQUIDITY_CLI ??
    path.resolve(__dirname, "..", "hodlmm-move-liquidity", "hodlmm-move-liquidity.ts");
  if (!fs.existsSync(cli)) {
    throw new Error(`hodlmm-move-liquidity CLI not found at ${cli}. Install the skill or set HODLMM_MOVE_LIQUIDITY_CLI.`);
  }
  // `hodlmm-move-liquidity`'s `run` requires `--wallet <address>` + `--pool` + boolean `--confirm`
  // (no value). `--force` overrides the IN_RANGE no-op gate — required here because the
  // inventory balancer corrects exposure ratio regardless of price-drift status.
  const args = ["run", cli, "run", "--wallet", stxAddress, "--pool", poolId, "--confirm", "--force"];
  if (password) args.push("--password", password);

  const result = spawnSync("bun", args, { encoding: "utf-8", timeout: 120_000 });
  if (result.error) throw new Error(`move-liquidity invoke failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`move-liquidity exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  // Parse the last JSON line from stdout
  const lines = result.stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  if (lines.length === 0) throw new Error("move-liquidity returned no JSON output");
  const parsed = JSON.parse(lines[lines.length - 1]);
  if (parsed.status !== "success") {
    throw new Error(`move-liquidity reported ${parsed.status}: ${parsed.error ?? JSON.stringify(parsed)}`);
  }
  const tx = parsed?.data?.tx_id ?? parsed?.data?.txid ?? parsed?.data?.transaction?.txid;
  if (!tx) throw new Error("move-liquidity succeeded but returned no tx_id");
  return String(tx);
}

// ─── Pool/position utilities ──────────────────────────────────────────────────

async function gatherPool(poolId: string, wallet: string) {
  const pools = await fetchPools();
  const pool = pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new Error(`Pool ${poolId} not found in Bitflow DLMM registry.`);
  if (!V1_ELIGIBLE_POOLS.has(poolId)) {
    throw new Error(`Pool ${poolId} not in v1 scope (JingSwap-only pairs excluded — unaudited).`);
  }
  const [poolBins, userBins] = await Promise.all([fetchPoolBins(poolId), fetchUserPositions(poolId, wallet)]);
  return { pool, poolBins, userBins };
}

function activeBinPriceScaled(poolBins: BinData[], activeBin: number): bigint {
  // Bitflow bin prices are integer strings already scaled so that
  // raw_y = raw_x * price / PRICE_SCALE. Return as-is.
  const bin = poolBins.find((b) => b.bin_id === activeBin);
  if (!bin) return 0n;
  return BigInt(bin.price || "0");
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-inventory-balancer")
  .description("Restore target HODLMM LP token-exposure ratio via corrective swap + redeploy")
  .version("1.0.0");

program
  .command("install-packs")
  .description("Install @stacks SDK dependencies")
  .action(async () => {
    const packs = ["@stacks/transactions", "@stacks/network", "@stacks/wallet-sdk", "@stacks/encryption", "commander"];
    const result = spawnSync("bun", ["add", ...packs], { stdio: "inherit" });
    if (result.status !== 0) {
      return err("install-packs", `bun add exited ${result.status}`);
    }
    out("success", "install-packs", { installed: packs });
  });

program
  .command("doctor")
  .description("Pre-flight checks")
  .option("--pool <id>", "Optional: narrow to a single pool")
  .option("--password <pw>", "Wallet password (env: WALLET_PASSWORD)")
  .action(async (opts) => {
    try {
      const password = opts.password ?? process.env.WALLET_PASSWORD ?? "";
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
      let wallet = "";
      try {
        const { stxAddress } = await getWalletKeys(password);
        wallet = stxAddress;
        checks.push({ name: "wallet", ok: true, detail: wallet });
      } catch (e) {
        checks.push({ name: "wallet", ok: false, detail: (e as Error).message });
      }

      try {
        const pools = await fetchPools();
        const eligible = pools.filter((p) => V1_ELIGIBLE_POOLS.has(p.pool_id));
        checks.push({ name: "bitflow_app_api", ok: eligible.length > 0, detail: `${eligible.length} eligible pools` });
      } catch (e) {
        checks.push({ name: "bitflow_app_api", ok: false, detail: (e as Error).message });
      }

      if (wallet) {
        try {
          const bal = await fetchStxBalanceUstx(wallet);
          const ok = bal >= STX_GAS_FLOOR_USTX;
          checks.push({
            name: "stx_gas_reserve",
            ok,
            detail: `${Number(bal) / 1e6} STX (floor ${Number(STX_GAS_FLOOR_USTX) / 1e6})`,
          });

          const pending = await fetchPendingMempoolTxCount(wallet);
          checks.push({
            name: "mempool_depth",
            ok: pending === 0,
            detail: pending === 0 ? "clear" : `${pending} pending txs — would serialize via nonce-manager`,
          });
        } catch (e) {
          checks.push({ name: "chain_reads", ok: false, detail: (e as Error).message });
        }
      }

      // Surface cooldown state per pool (or the targeted one)
      const targetPool = opts.pool as string | undefined;
      const cooldowns: Record<string, string> = {};
      const poolsToCheck = targetPool ? [targetPool] : [...V1_ELIGIBLE_POOLS];
      for (const pid of poolsToCheck) {
        const ms = readMoveLiquidityCooldownMs(pid);
        cooldowns[pid] = ms === 0 ? "clear" : `${Math.ceil(ms / 60_000)} min remaining`;
      }
      checks.push({
        name: "move_liquidity_cooldown",
        ok: true,
        detail: JSON.stringify(cooldowns),
      });

      // Surface unresolved state markers
      const state = loadInventoryState();
      const unresolved = Object.entries(state)
        .filter(([, v]) => v.last_cycle_status === "swap_done_redeploy_pending")
        .map(([k]) => k);
      checks.push({
        name: "state_marker",
        ok: unresolved.length === 0,
        detail: unresolved.length === 0 ? "no unresolved cycles" : `unresolved: ${unresolved.join(", ")}`,
      });

      const allOk = checks.every((c) => c.ok);
      out(allOk ? "success" : "error", "doctor", { checks }, allOk ? null : "One or more checks failed");
      if (!allOk) process.exit(1);
    } catch (e) {
      err("doctor", (e as Error).message);
    }
  });

program
  .command("status")
  .description("Read-only ratio + deviation per eligible pool")
  .option("--pool <id>", "Narrow to a single pool")
  .option("--target-ratio <r>", "X:Y percent (e.g. 50:50)", "50:50")
  .option("--min-drift-pct <n>", "Drift threshold (%)", String(DEFAULT_MIN_DRIFT_PCT))
  .option("--password <pw>", "Wallet password (env: WALLET_PASSWORD)")
  .action(async (opts) => {
    try {
      const password = opts.password ?? process.env.WALLET_PASSWORD ?? "";
      const { stxAddress } = await getWalletKeys(password);
      const targetXRatio = parseTargetRatio(opts.targetRatio);
      const minDriftPct = Number(opts.minDriftPct);
      const pools = await fetchPools();
      const eligible = pools.filter((p) => V1_ELIGIBLE_POOLS.has(p.pool_id));
      const targetPools = opts.pool ? eligible.filter((p) => p.pool_id === opts.pool) : eligible;

      const reports = [];
      for (const pool of targetPools) {
        const userBins = await fetchUserPositions(pool.pool_id, stxAddress);
        if (userBins.length === 0) continue;
        const { bins, active_bin_id, fetched_at } = await fetchPoolBins(pool.pool_id);
        const ratio = computeRatio(pool, userBins, bins, active_bin_id, targetXRatio, fetched_at);
        const cooldownMs = readMoveLiquidityCooldownMs(pool.pool_id);
        const state = loadInventoryState()[pool.pool_id];
        reports.push({
          ...ratio,
          breach: ratio.deviation_abs * 100 >= minDriftPct,
          move_liquidity_cooldown_minutes: Math.ceil(cooldownMs / 60_000),
          last_cycle: state ?? null,
        });
      }
      out("success", "status", { pools: reports, min_drift_pct: minDriftPct });
    } catch (e) {
      err("status", (e as Error).message);
    }
  });

program
  .command("recommend")
  .description("Dry-run cycle plan")
  .option("--pool <id>", "Pool to plan against (required)")
  .option("--target-ratio <r>", "X:Y percent", "50:50")
  .option("--min-drift-pct <n>", String(DEFAULT_MIN_DRIFT_PCT))
  .option("--max-correction-sats <n>", String(DEFAULT_MAX_CORRECTION_SATS))
  .option("--max-quote-staleness-seconds <n>", String(DEFAULT_MAX_QUOTE_STALENESS_SECONDS))
  .option("--slippage-bps <n>", String(slippageDefault()))
  .option("--skip-redeploy", "Plan swap only; do not include redeploy")
  .option("--password <pw>", "Wallet password")
  .action(async (opts) => {
    try {
      await recommendOrRun(opts, false);
    } catch (e) {
      err("recommend", (e as Error).message);
    }
  });

program
  .command("run")
  .description("Execute the corrective cycle (requires --confirm=BALANCE)")
  .option("--pool <id>", "Pool to correct (required)")
  .option("--target-ratio <r>", "X:Y percent", "50:50")
  .option("--min-drift-pct <n>", String(DEFAULT_MIN_DRIFT_PCT))
  .option("--max-correction-sats <n>", String(DEFAULT_MAX_CORRECTION_SATS))
  .option("--max-quote-staleness-seconds <n>", String(DEFAULT_MAX_QUOTE_STALENESS_SECONDS))
  .option("--slippage-bps <n>", String(slippageDefault()))
  .option("--skip-redeploy", "Execute swap only; write swap_done_redeploy_pending marker")
  .option("--force-direction <dir>", "Override planner direction: X->Y or Y->X (operator escape hatch)")
  .option("--force-amount-in-raw <n>", "Override planner amount_in (raw sats)")
  .option("--confirm <token>", "Must equal BALANCE to execute")
  .option("--password <pw>", "Wallet password")
  .action(async (opts) => {
    try {
      const execute = opts.confirm === "BALANCE";
      await recommendOrRun(opts, execute);
    } catch (e) {
      err("run", (e as Error).message);
    }
  });

// ─── Shared recommend/run body ────────────────────────────────────────────────

async function recommendOrRun(opts: Record<string, string | boolean | undefined>, execute: boolean): Promise<void> {
  const action = execute ? "run" : "recommend";
  const poolId = opts.pool as string | undefined;
  if (!poolId) return err(action, "--pool is required");
  const password = (opts.password as string) ?? process.env.WALLET_PASSWORD ?? "";
  const targetXRatio = parseTargetRatio(String(opts.targetRatio ?? "50:50"));
  const minDriftPct = Number(opts.minDriftPct ?? DEFAULT_MIN_DRIFT_PCT);
  const maxCorrectionSats = BigInt(String(opts.maxCorrectionSats ?? DEFAULT_MAX_CORRECTION_SATS));
  const maxStaleSec = Number(opts.maxQuoteStalenessSeconds ?? DEFAULT_MAX_QUOTE_STALENESS_SECONDS);
  const slippageBps = Number(opts.slippageBps ?? slippageDefault());
  const skipRedeploy = Boolean(opts.skipRedeploy);

  const { stxAddress, stxPrivateKey } = await getWalletKeys(password);

  // Cooldown gate
  const cooldownMs = readMoveLiquidityCooldownMs(poolId);
  if (cooldownMs > 0 && !skipRedeploy) {
    return out("blocked", action, {
      pool_id: poolId,
      reason: "move_liquidity_cooldown_active",
      cooldown_minutes_remaining: Math.ceil(cooldownMs / 60_000),
      hint: "Pass --skip-redeploy to run the swap-only correction, or wait for the cooldown to clear.",
    });
  }

  // Check state marker: resume-from-redeploy path
  const state = loadInventoryState();
  const poolState = state[poolId];
  const pending = poolState?.last_cycle_status === "swap_done_redeploy_pending" ? poolState.swap_pending_details : undefined;
  if (pending && skipRedeploy) {
    return out("blocked", action, {
      reason: "swap_done_redeploy_pending — call without --skip-redeploy to finish the cycle",
      pending,
    });
  }

  if (pending && !skipRedeploy) {
    // Resume directly at redeploy (skip swap)
    if (!execute) {
      return out("success", action, { resume: "redeploy-only", pending });
    }
    const { stxAddress: resumeStx } = await getWalletKeys(password);
    const redeployTx = invokeMoveLiquidityRedeploy(poolId, resumeStx, password || undefined);
    state[poolId] = {
      ...poolState,
      last_cycle_at: new Date().toISOString(),
      last_cycle_status: "success",
      last_redeploy_tx: redeployTx,
      swap_pending_details: undefined,
    };
    saveInventoryState(state);
    return out("success", action, {
      pool_id: poolId,
      resumed: true,
      redeploy: { tx_id: redeployTx, explorer: `${EXPLORER}/0x${redeployTx}?chain=mainnet` },
      state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
    });
  }

  // Meta-cooldown gate (prevents rapid re-correction within the same flow event)
  const metaCdMs = inventoryMetaCooldownMs(state, poolId);
  if (metaCdMs > 0) {
    return out("blocked", action, {
      reason: "inventory_balancer_meta_cooldown_active",
      cooldown_minutes_remaining: Math.ceil(metaCdMs / 60_000),
    });
  }

  // Gather + assess
  const { pool, poolBins, userBins } = await gatherPool(poolId, stxAddress);
  if (userBins.length === 0) {
    return out("success", action, { pool_id: poolId, reason: "no_user_position" });
  }
  const ratio = computeRatio(pool, userBins, poolBins.bins, poolBins.active_bin_id, targetXRatio, poolBins.fetched_at);

  if (ratio.quote_staleness_seconds > maxStaleSec) {
    return out("blocked", action, {
      reason: "bitflow_quote_stale",
      quote_age_seconds: ratio.quote_staleness_seconds,
      max_allowed: maxStaleSec,
    });
  }

  if (ratio.deviation_abs * 100 < minDriftPct) {
    return out("success", action, { pool_id: poolId, reason: "within_threshold", ratio });
  }

  // Wallet gas reserve
  const stxBal = await fetchStxBalanceUstx(stxAddress);
  if (stxBal < STX_GAS_FLOOR_USTX) {
    return out("blocked", action, {
      reason: "insufficient_stx_gas_reserve",
      stx_balance_ustx: stxBal.toString(),
      required_ustx: STX_GAS_FLOOR_USTX.toString(),
    });
  }

  // Mempool depth guard
  const pendingCount = await fetchPendingMempoolTxCount(stxAddress);
  if (pendingCount > 0) {
    return out("blocked", action, {
      reason: "sender_has_pending_mempool_tx",
      pending_count: pendingCount,
      hint: "Wait for the prior tx to confirm, then retry — avoids TooMuchChaining on nonce-serial writes.",
    });
  }

  const activePriceScaled = activeBinPriceScaled(poolBins.bins, poolBins.active_bin_id);
  if (activePriceScaled === 0n) {
    return out("blocked", action, { reason: "active_bin_price_unavailable" });
  }

  // Operator overrides — deliberate escape hatch for testing or for corrections
  // the planner refuses (e.g. wallet holds under-weight side, over-weight side
  // is fully in the LP). Both flags must be supplied together.
  const forceDir = opts["forceDirection"] as string | undefined;
  const forceAmt = opts["forceAmountInRaw"] as string | undefined;
  if ((forceDir || forceAmt) && !(forceDir && forceAmt)) {
    return err(action, "--force-direction and --force-amount-in-raw must be used together");
  }
  if (forceDir && forceDir !== "X->Y" && forceDir !== "Y->X") {
    return err(action, "--force-direction must be 'X->Y' or 'Y->X'");
  }

  let plan: SwapPlan | null;
  if (forceDir && forceAmt) {
    const overrideIn = BigInt(forceAmt);
    const xForY = forceDir === "X->Y";
    const expectedOutRaw = xForY
      ? (overrideIn * activePriceScaled) / BigInt(PRICE_SCALE)
      : (overrideIn * BigInt(PRICE_SCALE)) / activePriceScaled;
    plan = {
      direction: forceDir as "X->Y" | "Y->X",
      token_in: xForY ? pool.token_x : pool.token_y,
      token_in_symbol: xForY ? pool.token_x_symbol : pool.token_y_symbol,
      token_in_decimals: xForY ? pool.token_x_decimals : pool.token_y_decimals,
      token_out: xForY ? pool.token_y : pool.token_x,
      token_out_symbol: xForY ? pool.token_y_symbol : pool.token_x_symbol,
      token_out_decimals: xForY ? pool.token_y_decimals : pool.token_x_decimals,
      amount_in_raw: overrideIn.toString(),
      expected_amount_out_raw: expectedOutRaw.toString(),
      minimum_amount_out_raw: ((expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
      slippage_bps: slippageBps,
      quote_source: `${BITFLOW_QUOTES}/bins/${poolId}#active_bin_price (operator override)`,
      quote_fetched_at: poolBins.fetched_at,
    };
  } else {
    plan = planCorrectiveSwap({
      ratio,
      pool,
      activeBinPriceScaled: activePriceScaled,
      minDriftPct,
      maxCorrectionSats,
      slippageBps,
    });
    if (!plan) {
      return out("success", action, { pool_id: poolId, reason: "no_correction_planned_below_min_swap", ratio });
    }
  }

  if (!execute) {
    return out("success", action, {
      pool_id: poolId,
      ratio_before: ratio,
      swap: plan,
      redeploy: skipRedeploy ? null : { skill: "hodlmm-move-liquidity", invocation: `run --pool ${poolId} --confirm` },
      note: "Dry-run. Pass --confirm=BALANCE to execute.",
    });
  }

  // Pre-broadcast thin-pool guard — #493 safety contract.
  // If the active bin's reserve of the OUTPUT token is less than
  // THIN_POOL_MIN_RATIO × the expected output, a single-hop swap would
  // need to walk many bins and risk moving the pool price by more than the
  // slippage budget. Refuse rather than broadcast.
  const outputActiveReserveRaw = plan.direction === "X->Y"
    ? BigInt(
      poolBins.bins.find((b) => b.bin_id === poolBins.active_bin_id)?.reserve_y ?? "0"
    )
    : BigInt(
      poolBins.bins.find((b) => b.bin_id === poolBins.active_bin_id)?.reserve_x ?? "0"
    );
  const expectedOutForThreshold = BigInt(plan.expected_amount_out_raw);
  if (outputActiveReserveRaw < expectedOutForThreshold * THIN_POOL_MIN_RATIO) {
    return out("blocked", action, {
      reason: "pool_volume_too_thin",
      direction: plan.direction,
      active_bin_output_reserve_raw: outputActiveReserveRaw.toString(),
      expected_output_raw: expectedOutForThreshold.toString(),
      min_ratio: THIN_POOL_MIN_RATIO.toString(),
      hint: "Active bin's output-token reserve is less than the conservative headroom (3× expected). Thin pools can move price beyond the slippage budget. Shrink --max-correction-sats or try a different pool.",
    });
  }

  // Pre-broadcast input-token balance gate — per @arc0btc's review on PR #494.
  // The swap transfers `amount_in_raw` of token_in FROM the sender's wallet
  // via the SIP-010 transfer call inside the router. If the wallet doesn't
  // hold it (common when the over-weight side is fully locked in LP bins),
  // the tx would abort on-chain AND the state marker would still be written,
  // leaving the next run trying to redeploy against a swap that never settled.
  // Routes through `resolveTokenAsset` so STX vs FT detection stays in sync
  // with the post-condition path.
  const inAssetResolved = resolveTokenAsset(plan.token_in);
  const requiredIn = BigInt(plan.amount_in_raw);
  const availableIn = await fetchTokenBalanceRaw(stxAddress, inAssetResolved);
  if (availableIn < requiredIn) {
    return out("blocked", action, {
      reason: "insufficient_input_token_balance",
      token_in: plan.token_in,
      token_in_symbol: plan.token_in_symbol,
      required_raw: requiredIn.toString(),
      available_raw: availableIn.toString(),
      hint: "The over-weight token likely sits inside LP bins. Withdraw a slice first or top up the wallet externally. v1 does not auto-withdraw.",
    });
  }

  // Execute: swap → state marker → redeploy (if not skipped)
  const nonce = await fetchNonce(stxAddress);
  const swapTx = await executeCorrectiveSwap(stxPrivateKey, stxAddress, pool, plan, nonce);

  state[poolId] = {
    ...(state[poolId] ?? {}),
    last_cycle_at: new Date().toISOString(),
    last_cycle_status: "swap_done_redeploy_pending",
    last_swap_tx: swapTx,
    swap_pending_details: {
      swap_tx: swapTx,
      swap_direction: plan.direction,
      swap_amount_in_raw: plan.amount_in_raw,
      swap_minimum_out_raw: plan.minimum_amount_out_raw,
      target_ratio_x: targetXRatio,
      captured_at: new Date().toISOString(),
    },
  };
  saveInventoryState(state);

  if (skipRedeploy) {
    const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, targetXRatio);
    return out("success", action, {
      pool_id: poolId,
      ratio_before: ratio,
      ratio_after: ratioAfter,
      swap: { ...plan, tx_id: swapTx, explorer: `${EXPLORER}/0x${swapTx}?chain=mainnet` },
      redeploy: null,
      state_marker: { path: INVENTORY_STATE_FILE, status: "swap_done_redeploy_pending" },
    });
  }

  let redeployTx: string;
  try {
    redeployTx = invokeMoveLiquidityRedeploy(poolId, stxAddress, password || undefined);
  } catch (e) {
    return out("error", action, {
      pool_id: poolId,
      swap: { ...plan, tx_id: swapTx, explorer: `${EXPLORER}/0x${swapTx}?chain=mainnet` },
      state_marker: { path: INVENTORY_STATE_FILE, status: "swap_done_redeploy_pending" },
    }, `Redeploy failed after swap — marker kept for resumption: ${(e as Error).message}`);
  }

  state[poolId] = {
    ...(state[poolId] ?? {}),
    last_cycle_at: new Date().toISOString(),
    last_cycle_status: "success",
    last_swap_tx: swapTx,
    last_redeploy_tx: redeployTx,
    swap_pending_details: undefined,
  };
  saveInventoryState(state);

  // #493 step 6 "Verify": re-read position post-broadcast and emit ratio_after.
  const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, targetXRatio);

  return out("success", action, {
    pool_id: poolId,
    pair: ratio.pair,
    ratio_before: ratio,
    ratio_after: ratioAfter,
    swap: { ...plan, tx_id: swapTx, explorer: `${EXPLORER}/0x${swapTx}?chain=mainnet` },
    redeploy: { tx_id: redeployTx, explorer: `${EXPLORER}/0x${redeployTx}?chain=mainnet` },
    state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
  });
}

/**
 * Re-read the position ratio after a short delay so the first Nakamoto block
 * has a chance to include our tx. If the tx hasn't confirmed yet, the returned
 * ratio may still reflect pre-swap state — the `quote_fetched_at` field on the
 * returned RatioSummary lets the caller reason about freshness.
 */
async function readRatioAfterDelay(poolId: string, wallet: string, targetXRatio: number): Promise<RatioSummary | { note: string }> {
  try {
    await new Promise((r) => setTimeout(r, VERIFY_SLEEP_MS));
    const { pool, poolBins, userBins } = await gatherPool(poolId, wallet);
    if (userBins.length === 0) return { note: "no_user_position_after" };
    return computeRatio(pool, userBins, poolBins.bins, poolBins.active_bin_id, targetXRatio, poolBins.fetched_at);
  } catch (e) {
    return { note: `ratio_after_read_failed: ${(e as Error).message}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTargetRatio(s: string): number {
  const parts = s.split(":").map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((p) => Number.isNaN(p) || p < 0)) {
    throw new Error(`Invalid --target-ratio '${s}'. Expected X:Y like '50:50'.`);
  }
  const sum = parts[0] + parts[1];
  if (sum === 0) throw new Error("target-ratio sides cannot both be 0.");
  return parts[0] / sum;
}

function slippageDefault(): number {
  const fromEnv = process.env.INVENTORY_BALANCER_SLIPPAGE_BPS;
  const parsed = fromEnv ? Number(fromEnv) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 5000 ? parsed : DEFAULT_SLIPPAGE_BPS;
}

// ─── Go ───────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  program.parseAsync(process.argv).catch((e) => {
    err("main", (e as Error).message);
  });
}
