#!/usr/bin/env bun
/**
 * HODLMM Emergency Exit
 * Autonomous capital protection for HODLMM LP positions.
 *
 * Decision pipeline:
 *   1. Run sBTC Proof-of-Reserve audit (sbtc-proof-of-reserve)
 *   2. Check HODLMM bin position status (bin range + slippage)
 *   3. Evaluate exit conditions against safety thresholds
 *   4. Output: HOLD / WARN / EXIT with MCP withdrawal commands
 *
 * Composability:
 *   import { evaluateExit } from "../hodlmm-emergency-exit/hodlmm-emergency-exit.ts"
 *   const result = await evaluateExit({ wallet: "SP...", poolId: "dlmm_1" })
 *
 * CLI:
 *   bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts doctor
 *   bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts run --wallet <STX_ADDRESS>
 *   bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts run --wallet <STX_ADDRESS> --confirm
 *
 * Mainnet only. Write-capable (withdrawal). Requires wallet for execution.
 */

import { Command }   from "commander";
import { readFileSync, writeFileSync } from "fs";
import { join }       from "path";
import { homedir }    from "os";
import { runAudit, type AuditResult, type HodlmmSignal } from "../sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts";

// ── Mainnet API endpoints ───────────────────────────────────────────────────
const BITFLOW_HODLMM_API = "https://bff.bitflowapis.finance";
const HIRO_API            = "https://api.mainnet.hiro.so";

// ── Safety constants ────────────────────────────────────────────────────────
const DEFAULT_POOL_ID        = "dlmm_1";                    // sBTC-USDCx
const EXIT_COOLDOWN_MS       = 30 * 60 * 1000;              // 30 min between exits
const OUT_OF_RANGE_GRACE_H   = 2;                            // hours before out-of-range triggers exit
const MAX_GAS_STX            = 50;                           // max gas spend per exit
const FETCH_TIMEOUT_MS       = 30_000;
const STX_ADDRESS_RE         = /^SP[0-9A-Z]{38,39}$/;

// ── State file ──────────────────────────────────────────────────────────────
const STATE_FILE = join(homedir(), ".hodlmm-emergency-exit-state.json");

interface ExitState {
  last_exit_at:        string | null;
  last_exit_reason:    string | null;
  last_exit_pool:      string | null;
  out_of_range_since:  string | null;   // ISO timestamp when bins first went OOR
  total_exits:         number;
}

function readState(): ExitState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      last_exit_at: null, last_exit_reason: null,
      last_exit_pool: null, out_of_range_since: null,
      total_exits: 0,
    };
  }
}

function writeState(state: ExitState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Types ───────────────────────────────────────────────────────────────────
type ExitDecision = "HOLD" | "WARN" | "EXIT";

interface McpCommand {
  step:        number;
  tool:        string;
  description: string;
  params:      Record<string, unknown>;
}

interface BinInfo {
  bin_id:          number;
  user_liquidity:  number;
}

interface PoolInfo {
  pool_id:         string;
  active_bin_id:   number;
  token_x_price:   number;
  token_x_decimals: number;
  token_y_decimals: number;
  volume_24h_usd:  number;
  liquidity_usd:   number;
  apr_24h:         number;
}

interface PositionCheck {
  has_position:    boolean;
  in_range:        boolean | null;
  active_bin:      number;
  user_bins:       number[];
  user_bin_count:  number;
}

interface ExitResult {
  status:         "success" | "blocked" | "error";
  decision:       ExitDecision;
  action:         string;
  data: {
    reserve_audit:     AuditResult | null;
    position_check:    PositionCheck | null;
    exit_reason:       string | null;
    refusal_reasons:   string[];
    mcp_commands:      McpCommand[];
    cooldown_ok:       boolean;
    cooldown_remaining_min: number;
    gas_ok:            boolean;
    gas_estimated_stx: number;
    pool_id:           string;
    wallet:            string;
    confirm_required:  boolean;
    out_of_range_hours: number | null;
  };
  error:          string | null;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────
async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { "User-Agent": "bff-skills/hodlmm-emergency-exit", ...(opts.headers ?? {}) },
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1000));
      const retry = await fetch(url, {
        ...opts,
        headers: { "User-Agent": "bff-skills/hodlmm-emergency-exit", ...(opts.headers ?? {}) },
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

// ── Data fetchers ───────────────────────────────────────────────────────────
async function fetchPoolInfo(poolId: string): Promise<PoolInfo> {
  interface TokenInfo { symbol?: string; decimals?: number; priceUsd?: number }
  interface PoolEntry {
    poolId: string;
    activeBinId?: number;
    tokens?: TokenInfo[];
    tvlUsd?: number;
    volumeUsd1d?: number;
    apr1d?: number;
  }
  interface PoolResponse { data?: PoolEntry[] }

  const resp = await fetchJson<PoolResponse>(`${BITFLOW_HODLMM_API}/api/app/v1/pools`);
  const pools = resp.data ?? [];
  const pool = pools.find(p => p.poolId === poolId);
  if (!pool) throw new Error(`Pool ${poolId} not found in ${pools.length} pools`);

  // Fetch active bin from quotes API for accuracy
  interface BinsResponse { active_bin_id?: number }
  const binsData = await fetchJson<BinsResponse>(`${BITFLOW_HODLMM_API}/api/quotes/v1/bins/${poolId}`);

  const tokenX = pool.tokens?.[0];
  const tokenY = pool.tokens?.[1];

  return {
    pool_id:          poolId,
    active_bin_id:    binsData.active_bin_id ?? pool.activeBinId ?? 0,
    token_x_price:    tokenX?.priceUsd ?? 0,
    token_x_decimals: tokenX?.decimals ?? 8,
    token_y_decimals: tokenY?.decimals ?? 6,
    volume_24h_usd:   pool.volumeUsd1d ?? 0,
    liquidity_usd:    pool.tvlUsd ?? 0,
    apr_24h:          pool.apr1d ?? 0,
  };
}

async function fetchUserBins(wallet: string, poolId: string): Promise<BinInfo[]> {
  interface BinResponse {
    bin_id?: number;
    user_liquidity?: number;
    liquidityShares?: number;
    amount?: number;
  }
  interface PositionResponse {
    bins?: BinResponse[];
    position_bins?: BinResponse[];
    positions?: { bins?: BinResponse[] };
    data?: BinResponse[];
  }

  let data: PositionResponse;
  try {
    data = await fetchJson<PositionResponse>(
      `${BITFLOW_HODLMM_API}/api/app/v1/users/${wallet}/positions/${poolId}/bins`
    );
  } catch {
    return []; // No position = empty
  }

  const raw = data.bins ?? data.position_bins ?? data.positions?.bins ?? data.data ?? [];
  return raw
    .filter(b => (b.user_liquidity ?? b.liquidityShares ?? b.amount ?? 0) > 0)
    .map(b => ({
      bin_id:         b.bin_id ?? 0,
      user_liquidity: b.user_liquidity ?? b.liquidityShares ?? b.amount ?? 0,
    }));
}

async function fetchGasFee(): Promise<number> {
  interface FeeResponse { fee?: number }
  const data = await fetchJson<FeeResponse>(`${HIRO_API}/v2/fees/transfer`);
  return (data.fee ?? 200) / 1e6; // Convert to STX
}

// ── Position analysis ───────────────────────────────────────────────────────
async function checkPosition(wallet: string, poolId: string): Promise<PositionCheck> {
  const pool = await fetchPoolInfo(poolId);
  const userBins = await fetchUserBins(wallet, poolId);

  if (userBins.length === 0) {
    return {
      has_position: false, in_range: null,
      active_bin: pool.active_bin_id, user_bins: [],
      user_bin_count: 0,
    };
  }

  const binIds = userBins.map(b => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  const inRange = pool.active_bin_id >= minBin && pool.active_bin_id <= maxBin;

  return {
    has_position: true,
    in_range:     inRange,
    active_bin:   pool.active_bin_id,
    user_bins:    binIds,
    user_bin_count: binIds.length,
  };
}

// ── Decision engine ─────────────────────────────────────────────────────────
function makeDecision(
  audit: AuditResult,
  position: PositionCheck,
  state: ExitState,
): { decision: ExitDecision; reason: string } {
  const signal = audit.hodlmm_signal;

  // RED or DATA_UNAVAILABLE → immediate EXIT
  if (signal === "RED" || signal === "DATA_UNAVAILABLE") {
    return {
      decision: "EXIT",
      reason: `Reserve signal ${signal} — sBTC peg unsafe (reserve_ratio: ${audit.reserve_ratio ?? "null"}, score: ${audit.score})`,
    };
  }

  // No position → nothing to exit
  if (!position.has_position) {
    return { decision: "HOLD", reason: "No HODLMM position found." };
  }

  // YELLOW → WARN (don't exit yet, but alert)
  if (signal === "YELLOW") {
    return {
      decision: "WARN",
      reason: `Reserve signal YELLOW — peg degraded (reserve_ratio: ${audit.reserve_ratio}, score: ${audit.score}). Hold position, do not add liquidity.`,
    };
  }

  // GREEN but out of range for too long → EXIT
  if (position.in_range === false) {
    const oorSince = state.out_of_range_since
      ? new Date(state.out_of_range_since).getTime()
      : Date.now();
    const oorHours = (Date.now() - oorSince) / 3_600_000;

    if (oorHours >= OUT_OF_RANGE_GRACE_H) {
      return {
        decision: "EXIT",
        reason: `Bins out of range for ${oorHours.toFixed(1)}h (>${OUT_OF_RANGE_GRACE_H}h grace). Active bin: ${position.active_bin}, your bins: [${position.user_bins.join(", ")}].`,
      };
    }

    return {
      decision: "WARN",
      reason: `Bins out of range for ${oorHours.toFixed(1)}h (grace: ${OUT_OF_RANGE_GRACE_H}h). Monitoring.`,
    };
  }

  // GREEN + in range → HOLD
  return { decision: "HOLD", reason: "Reserve GREEN, bins in range. Position safe." };
}

// ── Safety gates ────────────────────────────────────────────────────────────
function checkCooldown(state: ExitState): { ok: boolean; remaining_min: number } {
  if (!state.last_exit_at) return { ok: true, remaining_min: 0 };
  const elapsed = Date.now() - new Date(state.last_exit_at).getTime();
  const remaining = Math.max(0, EXIT_COOLDOWN_MS - elapsed);
  return { ok: remaining === 0, remaining_min: Math.ceil(remaining / 60_000) };
}

// ── MCP command builder ─────────────────────────────────────────────────────
function buildWithdrawCommands(binIds: number[], poolId: string): McpCommand[] {
  return [{
    step: 1,
    tool: "bitflow_hodlmm_remove_liquidity",
    description: `EMERGENCY EXIT: Remove all liquidity from ${poolId} bins [${binIds.join(", ")}]`,
    params: { poolId, binIds },
  }];
}

// ── Core evaluation (exported for composability) ────────────────────────────

/**
 * Evaluate whether an emergency exit is needed for an HODLMM position.
 *
 * @param opts.wallet  - STX address of the LP
 * @param opts.poolId  - HODLMM pool ID (default: dlmm_1)
 * @param opts.confirm - If true, include executable MCP commands. If false, dry-run only.
 * @returns ExitResult with decision, MCP commands, and full breakdown.
 *
 * @example
 * import { evaluateExit } from "../hodlmm-emergency-exit/hodlmm-emergency-exit.ts"
 * const result = await evaluateExit({ wallet: "SP...", poolId: "dlmm_1" })
 * if (result.decision === "EXIT") {
 *   // Execute result.data.mcp_commands
 * }
 */
export async function evaluateExit(opts: {
  wallet: string;
  poolId?: string;
  confirm?: boolean;
}): Promise<ExitResult> {
  const { wallet, poolId = DEFAULT_POOL_ID, confirm = false } = opts;

  if (!STX_ADDRESS_RE.test(wallet)) {
    return errorResult("INVALID_ADDRESS", `Invalid STX address: ${wallet}`, poolId, wallet);
  }

  const state = readState();

  try {
    // Step 1: Reserve audit
    const audit = await runAudit();

    // Step 2: Position check
    const position = await checkPosition(wallet, poolId);

    // Step 3: Decision
    const { decision, reason } = makeDecision(audit, position, state);

    // Update out-of-range tracking
    if (position.in_range === false && !state.out_of_range_since) {
      state.out_of_range_since = new Date().toISOString();
      writeState(state);
    } else if (position.in_range !== false && state.out_of_range_since) {
      state.out_of_range_since = null;
      writeState(state);
    }

    // Step 4: Safety gates for EXIT
    const refusalReasons: string[] = [];
    const cooldown = checkCooldown(state);
    let gasFee = 0;
    let gasOk = true;

    if (decision === "EXIT" && position.has_position) {
      // Cooldown check
      if (!cooldown.ok) {
        refusalReasons.push(`Exit cooldown active (${cooldown.remaining_min} min remaining)`);
      }

      // Gas check
      gasFee = await fetchGasFee();
      if (gasFee > MAX_GAS_STX) {
        gasOk = false;
        refusalReasons.push(`Gas fee ${gasFee.toFixed(4)} STX exceeds ${MAX_GAS_STX} STX cap`);
      }

      // Confirm gate
      if (!confirm) {
        refusalReasons.push("--confirm flag required to execute withdrawal");
      }
    }

    // Build MCP commands only if EXIT + no refusals
    const canExecute = decision === "EXIT" && position.has_position && refusalReasons.length === 0;
    const mcpCommands = canExecute
      ? buildWithdrawCommands(position.user_bins, poolId)
      : [];

    // Update state on successful exit command generation
    if (canExecute) {
      state.last_exit_at = new Date().toISOString();
      state.last_exit_reason = reason;
      state.last_exit_pool = poolId;
      state.out_of_range_since = null;
      state.total_exits += 1;
      writeState(state);
    }

    // Calculate OOR hours
    let oorHours: number | null = null;
    if (state.out_of_range_since) {
      oorHours = (Date.now() - new Date(state.out_of_range_since).getTime()) / 3_600_000;
      oorHours = parseFloat(oorHours.toFixed(1));
    }

    const blocked = decision === "EXIT" && refusalReasons.length > 0;
    const actionText = blocked
      ? `EXIT BLOCKED — ${refusalReasons.join("; ")}`
      : decision === "EXIT"
        ? `[CRITICAL] HODLMM Exit Triggered: ${reason}`
        : decision === "WARN"
          ? `WARN — ${reason}`
          : `HOLD — ${reason}`;

    return {
      status:   blocked ? "blocked" : "success",
      decision: blocked ? "EXIT" : decision,
      action:   actionText,
      data: {
        reserve_audit:        audit,
        position_check:       position,
        exit_reason:          decision === "EXIT" || decision === "WARN" ? reason : null,
        refusal_reasons:      refusalReasons,
        mcp_commands:         mcpCommands,
        cooldown_ok:          cooldown.ok,
        cooldown_remaining_min: cooldown.remaining_min,
        gas_ok:               gasOk,
        gas_estimated_stx:    gasFee,
        pool_id:              poolId,
        wallet,
        confirm_required:     decision === "EXIT" && !confirm,
        out_of_range_hours:   oorHours,
      },
      error: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult("EVALUATION_FAILED", msg, poolId, wallet);
  }
}

function errorResult(code: string, message: string, poolId: string, wallet: string): ExitResult {
  return {
    status:   "error",
    decision: "EXIT",
    action:   `[CRITICAL] HODLMM Exit Triggered: ${code} — ${message}. Treat as EXIT — do not proceed with HODLMM operations.`,
    data: {
      reserve_audit: null, position_check: null,
      exit_reason: `${code}: ${message}`,
      refusal_reasons: [], mcp_commands: [],
      cooldown_ok: false, cooldown_remaining_min: 0,
      gas_ok: false, gas_estimated_stx: 0,
      pool_id: poolId, wallet,
      confirm_required: false, out_of_range_hours: null,
    },
    error: message,
  };
}

// ── CLI: doctor ─────────────────────────────────────────────────────────────
async function runDoctor(): Promise<void> {
  interface Check { name: string; ok: boolean; detail: string }
  const checks: Check[] = [];

  // 1. sBTC Proof-of-Reserve import
  try {
    const audit = await runAudit();
    checks.push({
      name: "sBTC Proof-of-Reserve (runAudit)",
      ok:   audit.status !== "error",
      detail: `signal=${audit.hodlmm_signal}, ratio=${audit.reserve_ratio}, score=${audit.score}`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: "sBTC Proof-of-Reserve (runAudit)", ok: false, detail: msg });
  }

  // 2. HODLMM Pool API
  try {
    const pool = await fetchPoolInfo(DEFAULT_POOL_ID);
    checks.push({
      name: "Bitflow HODLMM Pool API",
      ok:   pool.active_bin_id > 0,
      detail: `${DEFAULT_POOL_ID} active_bin=${pool.active_bin_id}, TVL=$${pool.liquidity_usd.toFixed(0)}, APR=${pool.apr_24h.toFixed(1)}%`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: "Bitflow HODLMM Pool API", ok: false, detail: msg });
  }

  // 3. Hiro fees API
  try {
    const fee = await fetchGasFee();
    checks.push({
      name: "Hiro Stacks Fees API",
      ok:   fee > 0,
      detail: `${fee.toFixed(6)} STX estimated`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: "Hiro Stacks Fees API", ok: false, detail: msg });
  }

  // 4. State file
  try {
    const state = readState();
    checks.push({
      name: "State file",
      ok:   true,
      detail: `exits=${state.total_exits}, last=${state.last_exit_at ?? "never"}`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: "State file", ok: false, detail: msg });
  }

  const allOk = checks.every(c => c.ok);
  console.log(JSON.stringify({
    status:  allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All systems operational. Emergency exit pipeline ready."
      : "One or more checks failed — exit pipeline may be degraded.",
  }, null, 2));
}

// ── CLI wiring ──────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-emergency-exit")
  .description("HODLMM Emergency Exit — autonomous capital protection for LP positions")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify all data sources, reserve oracle, and exit pipeline")
  .action(runDoctor);

program
  .command("install-packs")
  .description("No additional packs required")
  .action(() => {
    console.log(JSON.stringify({
      status: "ok",
      message: "No packs required. Depends on sbtc-proof-of-reserve (co-located).",
    }));
  });

program
  .command("run")
  .description("Evaluate HODLMM position and execute emergency exit if conditions met")
  .requiredOption("--wallet <address>", "STX wallet address holding the HODLMM position")
  .option("--pool-id <id>", "HODLMM pool ID", DEFAULT_POOL_ID)
  .option("--confirm", "Required to execute actual withdrawal. Without this flag, dry-run only.", false)
  .action(async (opts: { wallet: string; poolId: string; confirm: boolean }) => {
    const result = await evaluateExit({
      wallet:  opts.wallet,
      poolId:  opts.poolId,
      confirm: opts.confirm,
    });

    console.log(JSON.stringify(result, null, 2));

    if (result.status === "error")   process.exit(3);
    if (result.decision === "EXIT")  process.exit(2);
    if (result.decision === "WARN")  process.exit(1);
  });

// Only run CLI when this file is the entry point
if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ status: "error", error: msg }));
    process.exit(3);
  });
}
