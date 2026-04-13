#!/usr/bin/env bun
/**
 * bns-agent-manager — Autonomous BNS Name Registration, Transfer & Sniper
 *
 * First write-capable BNS skill. Agents can register .btc names, transfer
 * ownership, and autonomously snipe expiring names with price + gas safety gates.
 *
 * Commands:
 *   doctor     — check wallet, API access, STX balance, gas adequacy
 *   search     — check availability + price for name(s)
 *   portfolio  — list all BNS names owned by wallet
 *   register   — register a .btc name via claim_bns_name_fast
 *   transfer   — send a name to another address via transfer_nft
 *   snipe      — watch names, auto-register when available
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ──────────────────────────────────────────────────────────────
const HIRO_API = "https://api.mainnet.hiro.so";
const BNS_V2_CONTRACT = "SP2QEZ06AGJ3RKJPBV14SY1V5BBFNAW33D96YPRZQ.BNS-V2";
const STATE_PATH = join(homedir(), ".bns-agent-manager.json");

// Safety limits
const DEFAULT_MAX_PRICE_STX = 50;
const MIN_GAS_RESERVE_STX = 2;
const REGISTER_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between registrations
const MAX_SNIPE_TARGETS = 20;
const FETCH_TIMEOUT_MS = 30_000;

// ─── Types ───────────────────────────────────────────────────────────────
interface NameInfo {
  name: string;
  full_name: string;
  available: boolean;
  owner: string | null;
  expire_block: number | null;
  status: string;
  price_stx: number | null;
}

interface PortfolioEntry {
  name: string;
  address: string;
  expire_block: number | null;
  status: string;
  token_id: number | null;
  contract_id: string | null;
}

interface SnipeTarget {
  name: string;
  max_price_stx: number;
  added_at: string;
}

interface HistoryEntry {
  action: string;
  name: string;
  timestamp: string;
  tx_id: string | null;
}

interface ManagerState {
  last_register_at: string | null;
  snipe_targets: SnipeTarget[];
  history: HistoryEntry[];
}

interface McpToolCall {
  tool: string;
  params: Record<string, string | number>;
}

interface HiroStxBalance {
  balance: string;
  locked: string;
}

interface HiroNameInfo {
  address: string;
  expire_block: number;
  status: string;
}

interface HiroNamesResponse {
  names: string[];
}

interface HiroPriceResponse {
  name_price: { units: string; amount: string };
}

interface NftHolding {
  asset_identifier: string;
  value: { repr: string };
}

interface NftHoldingsResponse {
  results: NftHolding[];
}

interface HiroInfoResponse {
  stacks_tip_height: number;
  burn_block_height: number;
}

// ─── Output ──────────────────────────────────────────────────────────────
function out(status: string, action: string, data: unknown, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: unknown[]): void {
  console.error("[bns-manager]", ...args);
}

// ─── Fetch ───────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── State ───────────────────────────────────────────────────────────────
function loadState(): ManagerState {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as ManagerState;
    } catch {
      log("Corrupt state file, resetting");
    }
  }
  return { last_register_at: null, snipe_targets: [], history: [] };
}

function saveState(state: ManagerState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── BNS Reads ───────────────────────────────────────────────────────────

function estimatePrice(name: string): number {
  const len = name.length;
  if (len === 1) return 640;
  if (len === 2) return 160;
  if (len === 3) return 40;
  if (len === 4) return 10;
  return 2;
}

async function getNamePrice(fullName: string, baseName: string): Promise<number | null> {
  try {
    const data = await fetchJson<HiroPriceResponse>(
      `${HIRO_API}/v2/prices/names/${fullName}`
    );
    return Number(BigInt(data.name_price.amount)) / 1_000_000;
  } catch {
    return estimatePrice(baseName);
  }
}

async function checkAvailability(name: string): Promise<NameInfo> {
  const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
  const baseName = fullName.replace(/\.btc$/, "");

  try {
    const info = await fetchJson<HiroNameInfo>(
      `${HIRO_API}/v1/names/${fullName}`
    );

    const priceStx = await getNamePrice(fullName, baseName);

    return {
      name: baseName,
      full_name: fullName,
      available: false,
      owner: info.address,
      expire_block: info.expire_block || null,
      status: info.status,
      price_stx: priceStx,
    };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("404") || msg.includes("No such name") || msg.includes("missing")) {
      const priceStx = await getNamePrice(fullName, baseName);
      return {
        name: baseName,
        full_name: fullName,
        available: true,
        owner: null,
        expire_block: null,
        status: "available",
        price_stx: priceStx,
      };
    }
    throw err;
  }
}

async function getStxBalance(address: string): Promise<{ balance_stx: number; locked_stx: number }> {
  const data = await fetchJson<HiroStxBalance>(
    `${HIRO_API}/extended/v1/address/${address}/stx`
  );
  return {
    balance_stx: Number(BigInt(data.balance)) / 1_000_000,
    locked_stx: Number(BigInt(data.locked)) / 1_000_000,
  };
}

async function getPortfolio(address: string): Promise<PortfolioEntry[]> {
  const entries: PortfolioEntry[] = [];

  // BNS V1 name lookup
  try {
    const data = await fetchJson<HiroNamesResponse>(
      `${HIRO_API}/v1/addresses/stacks/${address}`
    );
    for (const fullName of data.names || []) {
      let entry: PortfolioEntry = {
        name: fullName,
        address,
        expire_block: null,
        status: "registered",
        token_id: null,
        contract_id: null,
      };
      try {
        const nameInfo = await fetchJson<HiroNameInfo>(
          `${HIRO_API}/v1/names/${fullName}`
        );
        entry = {
          ...entry,
          address: nameInfo.address,
          expire_block: nameInfo.expire_block || null,
          status: nameInfo.status,
        };
      } catch {
        // keep partial entry
      }
      entries.push(entry);
    }
  } catch (err) {
    log("BNS v1 lookup error:", err);
  }

  // BNS V2 NFT lookup — names are NFTs in V2
  try {
    const nftData = await fetchJson<NftHoldingsResponse>(
      `${HIRO_API}/extended/v1/tokens/nft/holdings?principal=${address}&limit=50`
    );
    for (const nft of nftData.results || []) {
      const id = nft.asset_identifier.toLowerCase();
      if (!id.includes("bns")) continue;

      const tokenIdMatch = nft.value.repr.match(/u(\d+)/);
      const tokenId = tokenIdMatch ? Number(tokenIdMatch[1]) : null;
      const contractId = nft.asset_identifier.split("::")[0];

      // Merge with existing entry or add new
      const existing = entries.find(
        (e) => e.token_id === null && e.contract_id === null
      );
      if (existing) {
        existing.token_id = tokenId;
        existing.contract_id = contractId;
      } else {
        entries.push({
          name: `bns-nft-${tokenId}`,
          address,
          expire_block: null,
          status: "nft",
          token_id: tokenId,
          contract_id: contractId,
        });
      }
    }
  } catch {
    log("NFT holdings lookup skipped");
  }

  return entries;
}

// ─── Cooldown Check ──────────────────────────────────────────────────────
function checkCooldown(state: ManagerState): { ok: boolean; remaining_min: number } {
  if (!state.last_register_at) return { ok: true, remaining_min: 0 };
  const elapsed = Date.now() - new Date(state.last_register_at).getTime();
  if (elapsed >= REGISTER_COOLDOWN_MS) return { ok: true, remaining_min: 0 };
  return {
    ok: false,
    remaining_min: Math.ceil((REGISTER_COOLDOWN_MS - elapsed) / 60_000),
  };
}

// ─── Commands ────────────────────────────────────────────────────────────

async function doctorCmd(): Promise<void> {
  const address = process.env.STX_ADDRESS;

  const checks: Record<string, unknown> = {
    wallet_configured: !!address,
    hiro_api: "checking",
    bns_api: "checking",
    stx_balance_stx: 0,
    gas_reserve_ok: false,
    can_register: false,
    snipe_targets: 0,
    registration_history: 0,
  };

  if (!address) {
    out("blocked", "doctor", { checks },
      "No STX_ADDRESS configured. Set STX_ADDRESS or unlock wallet.");
    return;
  }

  // Hiro API
  try {
    await fetchJson<HiroInfoResponse>(`${HIRO_API}/v2/info`);
    checks.hiro_api = "ok";
  } catch {
    checks.hiro_api = "failed";
  }

  // BNS API — test with a known name
  try {
    await fetchJson<HiroNameInfo>(`${HIRO_API}/v1/names/satoshi.btc`);
    checks.bns_api = "ok";
  } catch {
    checks.bns_api = "failed";
  }

  // Balance
  try {
    const bal = await getStxBalance(address);
    checks.stx_balance_stx = bal.balance_stx;
    checks.gas_reserve_ok = bal.balance_stx >= MIN_GAS_RESERVE_STX;
    checks.can_register = bal.balance_stx >= MIN_GAS_RESERVE_STX + 2;
  } catch {
    checks.stx_balance_stx = "error";
  }

  // State
  const state = loadState();
  checks.snipe_targets = state.snipe_targets.length;
  checks.registration_history = state.history.length;

  const allOk =
    checks.hiro_api === "ok" &&
    checks.bns_api === "ok" &&
    checks.gas_reserve_ok === true;

  if (allOk) {
    out("success", "doctor", { checks });
  } else {
    const blockers: string[] = [];
    if (checks.hiro_api !== "ok") blockers.push("Hiro API unreachable");
    if (checks.bns_api !== "ok") blockers.push("BNS API unreachable");
    if (!checks.gas_reserve_ok)
      blockers.push(
        `STX balance (${checks.stx_balance_stx}) below gas reserve (${MIN_GAS_RESERVE_STX} STX)`
      );
    out("blocked", "doctor", { checks, blockers }, blockers.join("; "));
  }
}

async function searchCmd(names: string): Promise<void> {
  const nameList = names
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (nameList.length === 0) {
    out("error", "search", null, "No names provided. Use --names 'name1,name2'");
    return;
  }

  const results: NameInfo[] = [];

  for (const name of nameList) {
    try {
      const info = await checkAvailability(name);
      results.push(info);
    } catch {
      results.push({
        name,
        full_name: name.endsWith(".btc") ? name : `${name}.btc`,
        available: false,
        owner: null,
        expire_block: null,
        status: "error",
        price_stx: null,
      });
    }
  }

  const available = results.filter((r) => r.available);
  const taken = results.filter((r) => !r.available && r.status !== "error");

  out("success", "search", {
    total: results.length,
    available: available.length,
    taken: taken.length,
    names: results,
  });
}

async function portfolioCmd(): Promise<void> {
  const address = process.env.STX_ADDRESS;
  if (!address) {
    out("error", "portfolio", null, "No STX_ADDRESS configured.");
    return;
  }

  const names = await getPortfolio(address);
  const balance = await getStxBalance(address);

  out("success", "portfolio", {
    address,
    stx_balance: balance.balance_stx,
    names_owned: names.length,
    names,
  });
}

async function registerCmd(
  name: string,
  opts: { confirm?: string; maxPrice?: string }
): Promise<void> {
  const address = process.env.STX_ADDRESS;
  if (!address) {
    out("error", "register", null, "No STX_ADDRESS configured.");
    return;
  }

  const maxPrice = opts.maxPrice ? Number(opts.maxPrice) : DEFAULT_MAX_PRICE_STX;

  // Availability + price
  const info = await checkAvailability(name);

  if (!info.available) {
    out("blocked", "register", {
      name: info.full_name,
      owner: info.owner,
      status: info.status,
    }, `${info.full_name} is not available — owned by ${info.owner}`);
    return;
  }

  // Price gate
  if (info.price_stx !== null && info.price_stx > maxPrice) {
    out("blocked", "register", {
      name: info.full_name,
      price_stx: info.price_stx,
      max_price_stx: maxPrice,
    }, `Price ${info.price_stx} STX exceeds max ${maxPrice} STX. Use --max-price to increase.`);
    return;
  }

  // Gas reserve
  const balance = await getStxBalance(address);
  const totalCost = (info.price_stx ?? 2) + MIN_GAS_RESERVE_STX;
  if (balance.balance_stx < totalCost) {
    out("blocked", "register", {
      name: info.full_name,
      price_stx: info.price_stx,
      stx_balance: balance.balance_stx,
      required_stx: totalCost,
    }, `Insufficient STX. Need ${totalCost} (${info.price_stx ?? 2} name + ${MIN_GAS_RESERVE_STX} gas), have ${balance.balance_stx}`);
    return;
  }

  // Cooldown
  const state = loadState();
  const cd = checkCooldown(state);
  if (!cd.ok) {
    out("blocked", "register", {
      name: info.full_name,
      cooldown_remaining_minutes: cd.remaining_min,
    }, `Registration cooldown active. ${cd.remaining_min} minutes remaining.`);
    return;
  }

  // Dry-run
  if (opts.confirm !== "REGISTER") {
    out("success", "register", {
      mode: "dry_run",
      name: info.full_name,
      price_stx: info.price_stx,
      stx_balance: balance.balance_stx,
      after_balance_stx: balance.balance_stx - (info.price_stx ?? 2),
      instruction: "Add --confirm=REGISTER to execute on-chain",
      mcp_preview: {
        tool: "claim_bns_name_fast",
        params: { name: info.full_name },
      },
    });
    return;
  }

  // Execute
  const mcpCall: McpToolCall = {
    tool: "claim_bns_name_fast",
    params: { name: info.full_name },
  };

  state.last_register_at = new Date().toISOString();
  state.history.push({
    action: "register",
    name: info.full_name,
    timestamp: new Date().toISOString(),
    tx_id: null,
  });
  saveState(state);

  out("success", "execute_mcp", {
    action: "register",
    name: info.full_name,
    price_stx: info.price_stx,
    mcp: mcpCall,
    next_steps: [
      "Agent runtime executes claim_bns_name_fast",
      "Tx broadcasts to Stacks mainnet",
      "Name minted as BNS V2 NFT to wallet",
      "Run 'portfolio' to verify after confirmation (~1 min)",
    ],
  });
}

async function transferCmd(
  name: string,
  opts: { to: string; confirm?: string }
): Promise<void> {
  const address = process.env.STX_ADDRESS;
  if (!address) {
    out("error", "transfer", null, "No STX_ADDRESS configured.");
    return;
  }

  if (!opts.to) {
    out("error", "transfer", null,
      "Recipient required. Use --to <SP...address>");
    return;
  }

  // Validate recipient format
  if (!opts.to.startsWith("SP") && !opts.to.startsWith("SM")) {
    out("error", "transfer", null,
      "Invalid recipient. Must be a mainnet Stacks address (SP... or SM...)");
    return;
  }

  const fullName = name.endsWith(".btc") ? name : `${name}.btc`;

  // Verify ownership
  const info = await checkAvailability(name);
  if (info.available) {
    out("error", "transfer", { name: fullName },
      `${fullName} is not registered — cannot transfer.`);
    return;
  }

  if (info.owner && info.owner !== address) {
    out("blocked", "transfer", {
      name: fullName,
      owner: info.owner,
      your_address: address,
    }, `You do not own ${fullName}. Owner: ${info.owner}`);
    return;
  }

  // Get NFT details from portfolio
  const portfolio = await getPortfolio(address);
  const nameEntry = portfolio.find(
    (p) => p.name === fullName || p.name === name
  );

  const tokenId = nameEntry?.token_id ?? null;
  const contractId = nameEntry?.contract_id ?? BNS_V2_CONTRACT;

  // Gas check
  const balance = await getStxBalance(address);
  if (balance.balance_stx < MIN_GAS_RESERVE_STX) {
    out("blocked", "transfer", {
      name: fullName,
      stx_balance: balance.balance_stx,
    }, `Insufficient gas. Need ${MIN_GAS_RESERVE_STX} STX, have ${balance.balance_stx}`);
    return;
  }

  // Dry-run
  if (opts.confirm !== "TRANSFER") {
    out("success", "transfer", {
      mode: "dry_run",
      name: fullName,
      from: address,
      to: opts.to,
      token_id: tokenId,
      contract_id: contractId,
      stx_balance: balance.balance_stx,
      instruction: "Add --confirm=TRANSFER to execute on-chain",
    });
    return;
  }

  if (tokenId === null) {
    out("blocked", "transfer", {
      name: fullName,
      contract_id: contractId,
    }, `Could not resolve NFT token ID for ${fullName}. Run 'portfolio' to verify ownership and try again.`);
    return;
  }

  // Execute
  const mcpCall: McpToolCall = {
    tool: "transfer_nft",
    params: {
      contractId,
      tokenId,
      recipient: opts.to,
    },
  };

  const state = loadState();
  state.history.push({
    action: "transfer",
    name: fullName,
    timestamp: new Date().toISOString(),
    tx_id: null,
  });
  saveState(state);

  out("success", "execute_mcp", {
    action: "transfer",
    name: fullName,
    from: address,
    to: opts.to,
    mcp: mcpCall,
    next_steps: [
      "Agent runtime executes transfer_nft",
      `${fullName} ownership transfers to ${opts.to}`,
      "Run 'portfolio' to verify after confirmation (~1 min)",
    ],
  });
}

async function snipeCmd(opts: {
  names?: string;
  maxPrice?: string;
  confirm?: string;
  add?: string;
  remove?: string;
  list?: boolean;
}): Promise<void> {
  const state = loadState();
  const maxPrice = opts.maxPrice ? Number(opts.maxPrice) : DEFAULT_MAX_PRICE_STX;

  // ── Add targets (no wallet needed) ──
  if (opts.add) {
    const newNames = opts.add
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    let added = 0;
    for (const n of newNames) {
      const fullName = n.endsWith(".btc") ? n : `${n}.btc`;
      if (state.snipe_targets.some((t) => t.name === fullName)) {
        log(`${fullName} already in watchlist`);
        continue;
      }
      if (state.snipe_targets.length >= MAX_SNIPE_TARGETS) {
        log(`Max ${MAX_SNIPE_TARGETS} targets reached`);
        break;
      }
      state.snipe_targets.push({
        name: fullName,
        max_price_stx: maxPrice,
        added_at: new Date().toISOString(),
      });
      added++;
    }
    saveState(state);
    out("success", "snipe", {
      action: "targets_added",
      added,
      total: state.snipe_targets.length,
      targets: state.snipe_targets,
    });
    return;
  }

  // ── Remove targets ──
  if (opts.remove) {
    const removeSet = new Set(
      opts.remove.split(",").map((n) => {
        const trimmed = n.trim();
        return trimmed.endsWith(".btc") ? trimmed : `${trimmed}.btc`;
      })
    );
    const before = state.snipe_targets.length;
    state.snipe_targets = state.snipe_targets.filter(
      (t) => !removeSet.has(t.name)
    );
    saveState(state);
    out("success", "snipe", {
      action: "targets_removed",
      removed: before - state.snipe_targets.length,
      total: state.snipe_targets.length,
      targets: state.snipe_targets,
    });
    return;
  }

  // ── List targets ──
  if (opts.list) {
    out("success", "snipe", {
      action: "list",
      total: state.snipe_targets.length,
      targets: state.snipe_targets,
    });
    return;
  }

  // ── Scan + execute (wallet required) ──
  const address = process.env.STX_ADDRESS;
  if (!address) {
    out("error", "snipe", null, "No STX_ADDRESS configured. Required for scan/execute.");
    return;
  }

  if (state.snipe_targets.length === 0) {
    out("blocked", "snipe", null,
      "No snipe targets configured. Use --add 'name1,name2' first.");
    return;
  }

  log(`Scanning ${state.snipe_targets.length} targets...`);

  interface ScanResult {
    name: string;
    available: boolean;
    price_stx: number | null;
    within_budget: boolean;
    action: string;
  }

  const results: ScanResult[] = [];

  for (const target of state.snipe_targets) {
    try {
      const info = await checkAvailability(target.name);
      const withinBudget =
        info.available &&
        info.price_stx !== null &&
        info.price_stx <= target.max_price_stx;

      results.push({
        name: target.name,
        available: info.available,
        price_stx: info.price_stx,
        within_budget: withinBudget,
        action: info.available && withinBudget ? "REGISTER" : "WAIT",
      });
    } catch {
      results.push({
        name: target.name,
        available: false,
        price_stx: null,
        within_budget: false,
        action: "ERROR",
      });
    }
  }

  const actionable = results.filter((r) => r.action === "REGISTER");

  if (actionable.length === 0) {
    out("success", "snipe", {
      mode: "scan",
      checked: results.length,
      actionable: 0,
      results,
      next: "All targets still taken. Run again later or add to cron.",
    });
    return;
  }

  // Dry-run
  if (opts.confirm !== "SNIPE") {
    out("success", "snipe", {
      mode: "dry_run",
      found: actionable.length,
      actionable,
      all_results: results,
      instruction: "Add --confirm=SNIPE to auto-register the first available name",
    });
    return;
  }

  // Execute: register first available within budget
  const target = actionable[0];

  // Balance check
  const balance = await getStxBalance(address);
  const totalCost = (target.price_stx ?? 2) + MIN_GAS_RESERVE_STX;
  if (balance.balance_stx < totalCost) {
    out("blocked", "snipe", {
      name: target.name,
      price_stx: target.price_stx,
      stx_balance: balance.balance_stx,
      required_stx: totalCost,
    }, `Insufficient STX for ${target.name}. Need ${totalCost}, have ${balance.balance_stx}`);
    return;
  }

  // Cooldown
  const cd = checkCooldown(state);
  if (!cd.ok) {
    out("blocked", "snipe", {
      name: target.name,
      cooldown_remaining_minutes: cd.remaining_min,
    }, `Registration cooldown active. ${cd.remaining_min} minutes remaining.`);
    return;
  }

  const mcpCall: McpToolCall = {
    tool: "claim_bns_name_fast",
    params: { name: target.name },
  };

  // Update state: remove from targets, record in history
  state.last_register_at = new Date().toISOString();
  state.snipe_targets = state.snipe_targets.filter((t) => t.name !== target.name);
  state.history.push({
    action: "snipe_register",
    name: target.name,
    timestamp: new Date().toISOString(),
    tx_id: null,
  });
  saveState(state);

  out("success", "execute_mcp", {
    action: "snipe_register",
    name: target.name,
    price_stx: target.price_stx,
    remaining_targets: state.snipe_targets.length,
    mcp: mcpCall,
    next_steps: [
      `Registering ${target.name} via claim_bns_name_fast`,
      "Name removed from watchlist",
      `${state.snipe_targets.length} targets remaining`,
      "Run 'portfolio' to verify after confirmation",
    ],
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("bns-agent-manager")
  .description(
    "Autonomous BNS name registration, transfer, and sniper for .btc names"
  );

program
  .command("doctor")
  .description("Check wallet, API access, and STX balance")
  .action(async () => {
    try { await doctorCmd(); }
    catch (e) { out("error", "doctor", null, String(e)); }
  });

program
  .command("search")
  .description("Check availability and price for BNS name(s)")
  .requiredOption("--names <names>", "Comma-separated names to check")
  .action(async (opts: { names: string }) => {
    try { await searchCmd(opts.names); }
    catch (e) { out("error", "search", null, String(e)); }
  });

program
  .command("portfolio")
  .description("List all BNS names owned by wallet")
  .action(async () => {
    try { await portfolioCmd(); }
    catch (e) { out("error", "portfolio", null, String(e)); }
  });

program
  .command("register")
  .description("Register a .btc name (requires --confirm=REGISTER)")
  .requiredOption("--name <name>", "BNS name to register (e.g. myagent)")
  .option("--max-price <stx>", `Max STX to spend (default: ${DEFAULT_MAX_PRICE_STX})`)
  .option("--confirm <token>", "Set to REGISTER to execute on-chain")
  .action(async (opts: { name: string; confirm?: string; maxPrice?: string }) => {
    try { await registerCmd(opts.name, opts); }
    catch (e) { out("error", "register", null, String(e)); }
  });

program
  .command("transfer")
  .description("Transfer a .btc name to another address (requires --confirm=TRANSFER)")
  .requiredOption("--name <name>", "BNS name to transfer")
  .requiredOption("--to <address>", "Recipient Stacks address (SP...)")
  .option("--confirm <token>", "Set to TRANSFER to execute on-chain")
  .action(async (opts: { name: string; to: string; confirm?: string }) => {
    try { await transferCmd(opts.name, opts); }
    catch (e) { out("error", "transfer", null, String(e)); }
  });

program
  .command("snipe")
  .description("Watch names and auto-register when available")
  .option("--add <names>", "Add names to watchlist (comma-separated)")
  .option("--remove <names>", "Remove names from watchlist")
  .option("--list", "Show current watchlist")
  .option("--max-price <stx>", `Max STX per name (default: ${DEFAULT_MAX_PRICE_STX})`)
  .option("--confirm <token>", "Set to SNIPE to auto-register available names")
  .action(async (opts: { add?: string; remove?: string; list?: boolean; maxPrice?: string; confirm?: string }) => {
    try { await snipeCmd(opts); }
    catch (e) { out("error", "snipe", null, String(e)); }
  });

program
  .command("install-packs")
  .description("No external packs required")
  .option("--pack <pack>", "Pack name (ignored)")
  .action(() => {
    out("success", "install-packs", { message: "No external packs required." });
  });

if (import.meta.main) {
  program.parse();
}
