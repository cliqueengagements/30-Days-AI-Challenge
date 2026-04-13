---
name: sbtc-capital-allocator
description: "Routes sBTC capital between HODLMM pools and Zest lending based on real-time APY, with DCA execution mode triggered by risk signals from Pyth oracle, whale tracking, and fee spike detection."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk — Agent #77"
  user-invocable: "false"
  arguments: "install-packs | doctor | scan | monitor | recommend | execute"
  entry: "sbtc-capital-allocator/sbtc-capital-allocator.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds"
---

# sBTC Capital Allocator

## What it does

Compares real-time APY across Bitflow HODLMM pools (7-day smoothed fee revenue / TVL) and Zest Protocol lending (on-chain liquidity rate), then routes sBTC capital to the highest risk-adjusted yield. The decision function separates allocation (WHERE to deploy) from execution timing (HOW to deploy) — when risk signals fire (whale pressure, oracle divergence, fee spikes), capital is deployed via DCA over multiple intervals instead of a single lump sum. Before any capital movement, it verifies price freshness via Pyth oracle vs pool price divergence, monitors LP range drift, and checks whale repositioning signals.

## Why agents need it

Agents holding sBTC need a single decision function that answers two questions: which protocol earns the most, and whether to deploy all at once or gradually. Most yield tools compare APYs and pick the highest. This skill goes further — it's time-aware and risk-aware, splitting deployment when conditions are volatile. The agent runs `recommend` on a schedule and `execute` when conditions are optimal.

## Safety notes

- **Writes to chain:** The `execute` command emits MCP commands for `zest_supply` or `call_contract (add-relative-liquidity-multi on the DLMM router)`. These are emitted with `auto_execute: false` — the agent must confirm.
- **--confirm required:** Without `--confirm`, execute runs in dry-run preview mode showing execution_mode.
- **Oracle gate:** Execute is blocked if Pyth price diverges >2% from pool price or if Pyth data is older than 120 seconds.
- **DCA mode:** Oracle divergence between 1-2%, whale pressure, fee spikes, or high-risk pools trigger DCA — capital is split into 5 intervals.
- **Fee spike gate:** Execute is blocked if the target pool has 1-day fees >3x the 7-day daily average.
- **TVL impact gate:** Execute is blocked if deploy amount exceeds 5% of pool TVL.
- **Spend cap:** Maximum 500,000 sats (0.005 BTC) per execute. Hard-coded constant.
- **Wallet reserve:** Always keeps 10,000 sats in wallet — never deploys entire balance.
- **Micro-pool filter:** Pools below $10,000 TVL are excluded from routing.
- **Cooldown:** 30 minutes between executions.
- **Mainnet only.**

## Commands

### install-packs

Installs required npm packages: `@stacks/transactions`, `@stacks/network`, `commander`.

```bash
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts install-packs
```

### doctor

Pre-flight checks: wallet balance (STX gas floor), Bitflow API (sBTC HODLMM pools), Zest on-chain reads (position data), Pyth Hermes oracle (BTC price + freshness), mempool whale scan (pending sBTC/HODLMM/Zest transactions).

```bash
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts doctor --wallet <STX_ADDRESS>
```

### scan

Live APY scan. HODLMM APY uses 7-day smoothed fees `(feesUsd7d / 7 / tvlUsd) * 365`, cross-validated against Bitflow's full-period `apr` — divergence >30% takes the conservative value. Zest rate read from on-chain `get-reserve-state` → `current-liquidity-rate` (1e6 precision, already annualized). Results sorted by APY descending.

```bash
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts scan --wallet <STX_ADDRESS>
```

### monitor

Three safety checks before committing capital:
1. **Oracle gate** — Pyth BTC/USD vs HODLMM pool implied price. Stale if >2% divergence or >120s age.
2. **Range drift** — LP bin positions relative to active bin. Warning if within 3 bins of edge, critical if out of range.
3. **Whale signals** — Scans the Stacks mempool (Hiro API) for pending sBTC transfers, HODLMM liquidity moves, and Zest supply/withdraw calls. Detects repositioning BEFORE it settles on-chain.

```bash
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts monitor --wallet <STX_ADDRESS>
```

### recommend

Two-layer decision function:
1. **WHERE** — Risk-adjusted APY ranking (APY / risk_score). Requires >2% APY improvement to recommend moving. Blocked on oracle stale or fee spike.
2. **HOW** — `lump_sum` (deploy immediately) or `dca` (split into 5 intervals). DCA triggers on: whale pressure, oracle divergence >1%, fee spike in ecosystem, high-risk pool (score ≥4/5).

```bash
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts recommend --wallet <STX_ADDRESS>
```

### execute

Routes capital to the recommended protocol using the recommended execution mode. Without `--confirm`, shows a dry-run preview including execution_mode and risk signals. With `--confirm`, emits the MCP command. In DCA mode, deploys 1/5th of the amount per interval — re-run execute for each subsequent interval.

```bash
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts execute --wallet <STX_ADDRESS>
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts execute --wallet <STX_ADDRESS> --confirm
bun run sbtc-capital-allocator/sbtc-capital-allocator.ts execute --wallet <STX_ADDRESS> --confirm --amount 0.002
```

## Output contract

All outputs are JSON to stdout.

**Success (recommend):**
```json
{
  "status": "success",
  "action": "recommend",
  "data": {
    "recommendation": {
      "target_protocol": "hodlmm",
      "target_pool": "dlmm_1",
      "target_apy_pct": 11.8,
      "current_protocol": null,
      "current_apy_pct": null,
      "risk_score": 4,
      "oracle_safe": true,
      "whale_pressure": "neutral",
      "action": "move",
      "execution_mode": "dca",
      "dca_intervals": 5,
      "dca_reason": "Risk signals detected: high risk pool (score 4/5). Splitting deployment into 5 intervals.",
      "reason": "No current position — deploy to hodlmm/dlmm_1 at 11.8% APY"
    }
  },
  "error": null
}
```

**Error:**
```json
{ "status": "error", "action": "scan", "data": {}, "error": { "code": "bitflow_error", "message": "HTTP 503", "next": "check bitflow API" } }
```

**Blocked:**
```json
{ "status": "blocked", "action": "execute", "data": {}, "error": { "code": "oracle_stale", "message": "Oracle price is stale", "next": "run monitor" } }
```

## Known constraints

- HODLMM APY uses 7-day smoothing — may lag sudden fee changes by up to a day. Fee spike detector catches anomalies.
- Zest on-chain rate may return 0 if Pyth oracle is unavailable (Zest depends on Pyth internally for collateral valuation).
- Whale tracking scans the Stacks mempool for pending sBTC/HODLMM/Zest transactions. Signal quality depends on mempool size — quiet periods produce fewer signals. The scan catches repositioning in-flight but cannot determine USD value of pending transactions.
- DCA execution is stateless — each `execute --confirm` deploys one interval. The agent is responsible for scheduling subsequent intervals.
- The skill emits MCP commands but does not call them directly — the agent must execute the final step.
