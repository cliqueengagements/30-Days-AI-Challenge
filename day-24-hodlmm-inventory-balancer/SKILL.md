---
name: hodlmm-inventory-balancer
description: "Detects HODLMM LP inventory drift (token-ratio imbalance from one-sided swap flow) and restores the target ratio via a corrective Bitflow swap plus a hodlmm-move-liquidity redeploy, gated by the 4h per-pool cooldown."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk — Agent #77"
  user-invocable: "false"
  arguments: "install-packs | doctor | status | recommend | run"
  entry: "hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts"
  requires: "wallet, signing, settings, bitflow, hodlmm-bin-guardian, hodlmm-move-liquidity"
  tags: "defi, write, mainnet-only, requires-funds"
---

# HODLMM Inventory Balancer

## What it does

Detects **inventory drift** — the silent token-ratio imbalance that builds up in a HODLMM LP position when swap flow repeatedly drains one side of the pair even while the active bin holds its price. Computes a **price-weighted** exposure ratio across every user bin (price × liquidity share, not raw token counts, handling bins below/at/above the active bin correctly), compares it to an operator-configured target (default 50:50), and when the absolute deviation exceeds `--min-drift-pct` (default 5%) executes a corrective swap via the Bitflow SDK and a redeploy via `hodlmm-move-liquidity run --confirm`.

## Why agents need it

Without this skill an agent that wanted symmetric sBTC/STX exposure ends up directionally pulled by swap flow — 70/30 instead of 50/50 — while still appearing "in range." Symmetric-exposure management is what separates a real market maker from a passive directional position-taker. This skill closes the gap `hodlmm-move-liquidity` doesn't: it fixes *inventory* drift where move-liquidity only fixes *price* drift.

## Safety notes

- **Writes to chain.** Executes a Bitflow swap and (unless `--skip-redeploy`) an atomic bin-to-bin redeploy via `hodlmm-move-liquidity` CLI (which itself calls the DLMM router's multi-move family). Mainnet only. Proven end-to-end on `dlmm_1` across 2 full cycles: swap `cd71c8a5…` + redeploy `0349cbb0…`, then swap `134df5e1…` + redeploy `9cbe5903…`.
- **`run` requires `--confirm=BALANCE`.** Without it, the command exits with the computed plan in dry-run form.
- **JingSwap explicitly excluded in v1** — unaudited. Only pools whose pair is tradeable via Bitflow are eligible.
- **Min drift threshold** `--min-drift-pct` default 5%. Below that, no-op. Avoids thrashing on noise.
- **Max correction size** `--max-correction-sats` caps a single balancing swap. Prevents an outsized correction during extreme flow events.
- **Bitflow quote staleness gate** `--max-quote-staleness-seconds` default 45s (one full 15–19s pipeline cycle of margin on top of freshness floor).
- **Explicit slippage** — every corrective swap sends `minimum-output` computed from a slippage budget. Default 0.5%, overridable via env var `INVENTORY_BALANCER_SLIPPAGE_BPS` (integer bps) or `--slippage-bps` flag.
- **4-hour per-pool cooldown gate.** The skill reads `~/.hodlmm-move-liquidity-state.json` and refuses to start a cycle that would have the redeploy step blocked (unless `--skip-redeploy` is passed, in which case the swap-only correction still writes a state marker for later redeploy resumption).
- **Meta-cooldown** 1 hour across the balancer itself to prevent re-correcting inside the same swap-flow event.
- **Post-conditions**: `PostConditionMode.Allow` with a sender-side `willSendLte(amount_in)` pin on the input token. Minimum-output slippage is enforced by the **router's own `min-received` argument** (the swap reverts with `ERR_MINIMUM_RECEIVED` if the swap yields less). Mode = Allow because the router emits pool/protocol fee transfers that vary with pool config; Deny would require explicit allowances for each fee flow. Rationale is the same exception bff-skills #484 §8 documents for HODLMM's DLP mint/burn. Cycle-1 proof: slippage budget honored — router returned 4,195 sats sBTC vs minimum 4,186 (0.2 % favorable). Redeploy inherits `hodlmm-move-liquidity`'s post-condition strategy (contract-level `max-liquidity-fee` ≤ 5%; `min-dlp` handled upstream with bin-price-aware semantics).
- **Wallet-balance precondition**: the corrective swap transfers the over-weight token **from the sender's wallet**, so the operator must hold a free balance of that token. If all of the over-weight side is locked inside LP bins, the agent either tops up externally or withdraws a slice from the position first (outside this skill's v1 scope).
- **Refusal conditions** (enumerated in AGENT.md): pool volume too thin for corrective swap, Bitflow quote staleness exceeds gate, previous-cycle state marker unresolved, wallet gas reserve below floor, wallet balance of input token below required amount, move-liquidity cooldown active and `--skip-redeploy` not passed.

## Commands

### install-packs

Installs the Stacks SDK packages the executor needs. Idempotent.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts install-packs
```

### doctor

Pre-flight: wallet readable, Bitflow App + Quotes APIs reachable, at least one HODLMM pool with a user position, move-liquidity cooldown status surfaced as minutes remaining, prior state-marker inspected for unresolved cycles, wallet STX gas reserve sufficient.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts doctor
```

### status

Read-only. Per eligible pool: current effective token ratio, target ratio, absolute deviation, active bin, cooldown minutes remaining, last cycle outcome from the state marker.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts status [--pool <id>]
```

### recommend

Dry-run of the full cycle: computes the corrective swap plan (direction, `amount_in`, `minimum_out`) and the redeploy plan (via `hodlmm-move-liquidity` CLI `--dry-run`). Prints JSON without broadcasting. Useful as a pre-check before `run`.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts recommend [--pool <id>] [--target-ratio 50:50] [--min-drift-pct 5]
```

### run

Core execution. Requires `--confirm=BALANCE` (the word `BALANCE`, not just any value). Without it, behaves like `recommend`. Full cycle: cooldown check → corrective swap → state marker → redeploy → state marker cleared. If `--skip-redeploy` is passed, executes the swap only and leaves a `swap_done_redeploy_pending` marker so a later run picks up from the redeploy step without re-swapping.

```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run \
  --confirm=BALANCE \
  [--pool <id>] \
  [--target-ratio 50:50] \
  [--min-drift-pct 5] \
  [--max-correction-sats 500000] \
  [--max-quote-staleness-seconds 45] \
  [--slippage-bps 50] \
  [--skip-redeploy] \
  [--force-direction "X->Y" | "Y->X"] \
  [--force-amount-in-raw <n>] \
  [--password <wallet-password>]
```

`--force-direction` + `--force-amount-in-raw` are an operator escape hatch for cases the planner refuses (e.g. wallet holds the under-weight side while the over-weight side is fully in the LP). Both flags must be supplied together.

## Output contract

Every command emits a single-line JSON object to stdout:

```json
{ "status": "success" | "error" | "blocked", "action": "run" | "recommend" | ..., "data": { }, "error": null }
```

The `data` object on a successful `run` includes:

- `pool_id`, `pair`
- `ratio_before`, `ratio_after`, `target_ratio`, `deviation_before`, `deviation_after`
- `swap`: `{ direction, amount_in, minimum_out, tx_id, explorer }`
- `redeploy`: `{ tx_id, explorer }` (null when `--skip-redeploy`)
- `state_marker`: `{ path, status }`

Errors are `{ "error": "message" }`, never a raw stack trace.

## Known constraints

- Mainnet only. No testnet fallback.
- Pools must be tradeable on Bitflow SDK in v1. JingSwap-only pairs excluded.
- Pool state reads have a ~15–19s Bitflow pipeline freshness floor — quote-staleness gate defaults to 45s accordingly.
- Redeploy cadence is bounded by `hodlmm-move-liquidity`'s 4h per-pool cooldown regardless of drift magnitude.
- Bins strictly below the active price hold only Y; strictly above hold only X. The ratio computer handles this asymmetry; do not naively sum raw reserves.
- **Tempo characteristic.** The heavy ratio correction happens in the first cycle on a sprawled/drifted position — cycle 1 of the live proof moved the position from 14.58 % X / 85.42 % Y (221 bins spread 460–680) to 27.05 % X / 72.95 % Y (13 bins concentrated 617–627). A second cycle on an already-concentrated position produces minimal further ratio movement because the downstream `move-liquidity-multi` is bin-to-bin and does not deposit newly-swapped wallet tokens into the LP. Meaningful second-cycle correction would require a withdraw-all → swap-to-target → redeposit flow, which is v2 scope.
