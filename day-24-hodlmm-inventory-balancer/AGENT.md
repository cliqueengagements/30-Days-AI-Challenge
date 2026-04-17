---
name: hodlmm-inventory-balancer-agent
skill: hodlmm-inventory-balancer
description: "Autonomous HODLMM inventory balancer — restores a target token-exposure ratio by routing a corrective Bitflow swap and a hodlmm-move-liquidity redeploy, gated by the shared 4h per-pool cooldown."
---

# Agent Behavior — HODLMM Inventory Balancer

## Decision order

1. Run `hodlmm-inventory-balancer doctor` first. If `status != "success"`, stop and surface the blocker. Never run `run` when doctor has flagged a problem.
2. Run `hodlmm-inventory-balancer status` to survey which pools (if any) breach `--min-drift-pct`. Skip the cycle if none do.
3. Read `~/.hodlmm-move-liquidity-state.json` directly — or rely on doctor's surfaced `move_liquidity_cooldown_minutes`. If the target pool is in cooldown AND `--skip-redeploy` is not set, abort the cycle. Do not attempt a swap that cannot be followed by a redeploy.
4. Check for an unresolved state marker at `~/.hodlmm-inventory-balancer-state.json` for the target pool. If `last_cycle_status == "swap_done_redeploy_pending"`, resume from the redeploy step — do not re-swap.
5. Run `hodlmm-inventory-balancer recommend --pool <id>` to preview the corrective swap + redeploy plan. Human or orchestrator inspects `ratio_before`, `deviation_before`, `swap.direction`, `swap.minimum_out`, `redeploy.plan`. Abort if the plan looks anomalous.
6. Call `hodlmm-inventory-balancer run --confirm=BALANCE --pool <id>` (with any additional flags). The skill enforces its own safety gates — an agent must not override them by editing state files.
7. On success, parse the JSON output, confirm `tx_status: success` for both the swap and (unless skipped) the redeploy via Hiro, log `ratio_after` and `deviation_after`, update any downstream portfolio state.

## Refusal conditions (hard gates — the skill must reject the cycle)

The `run` command will refuse and emit `status: "blocked"` when any of the following are true:

- **Pool volume too thin** to absorb the corrective swap without moving the pool price by more than the slippage budget. Thin-volume pools silently skew the swap price.
- **Bitflow quote staleness exceeds gate** (`--max-quote-staleness-seconds`, default 45s — the 15–19s pipeline freshness floor plus a single-cycle safety margin).
- **Previous-cycle state marker unresolved** and it doesn't match `swap_done_redeploy_pending`. A prior incomplete cycle must be manually inspected or resumed via the redeploy path before a new cycle starts.
- **Wallet gas reserve below floor.** The skill refuses rather than construct a tx guaranteed to fail. Surface the required vs available STX in the error.
- **Wallet balance of input token below required `amount_in`.** The corrective swap transfers the over-weight token from the sender's wallet. If the tokens are locked inside LP bins, the cycle must be preceded by a withdrawal (outside this skill's v1 scope) or a top-up. Surface required vs available raw balance.
- **Move-liquidity cooldown active for the target pool** AND `--skip-redeploy` is not set. Surface `N minutes remaining`.
- **`--confirm` missing or not equal to `BALANCE`.** Enforced literally — any other value falls through to `recommend`-style dry-run output.
- **`hodlmm-move-liquidity` not installed** when the cycle requires a redeploy. Check via `metadata.requires`.
- **Target pool not tradeable on Bitflow** (e.g., JingSwap-only pairs). Refused by design in v1.

## Guardrails

- **Price-weighted ratio only.** The skill must never make decisions from raw token-count sums. Each bin's contribution to exposure is `reserve × bin_price`, and bins above the active price are X-only while bins below are Y-only — this asymmetry is load-bearing.
- **Single cooldown gate across the chain.** When composed under a meta-skill (e.g., a HODLMM Yield Router), only the last step in the chain calls `hodlmm-move-liquidity run --confirm`. The balancer exposes `--skip-redeploy` precisely so the meta-skill can run `harvest → balance (swap only) → single redeploy`.
- **Post-conditions: Allow mode with a sender-side send pin, and contract-level minimum-output.** The Bitflow swap uses `PostConditionMode.Allow` with `willSendLte(amount_in)` on the sender for the input token. Minimum-output slippage is enforced by the router's own `min-received` argument (`ERR_MINIMUM_RECEIVED` internally) — not by a receive-side post-condition. Allow mode rationale: the swap emits pool/protocol fee transfers whose structure varies with pool config; Deny would require an explicit allowance for each fee flow. This is the same exception pattern `hodlmm-move-liquidity` uses for DLP mint/burn (bff-skills #484 §8). The redeploy inherits `hodlmm-move-liquidity`'s contract-level slippage (`max-liquidity-fee` ≤ 5%; `min-dlp` is price-aware per-bin, not a flat 95%, since cross-bin DLP shares are not 1:1 comparable).
- **State-marker semantics are load-bearing.** If the swap succeeds but the redeploy fails (cooldown hit mid-cycle, gas shortfall, network error), the state marker captures the intermediate state so the next run skips the swap and goes straight to redeploy. Never clear the marker unless the redeploy succeeds.
- **Never surface secrets.** Wallet password is accepted via `--password` or `WALLET_PASSWORD` env var only. It is never logged, echoed, or included in JSON output.

## On error

- Emit `{"error": "<descriptive message>"}` — no stack traces.
- Do not retry silently. Retry is the caller's decision.
- If the error occurs after the swap has been broadcast but before the redeploy completes, ensure a `swap_done_redeploy_pending` state marker is written with the swap tx_id before returning. This is the single most important error-path invariant.
- Surface actionable next steps in the error message where possible (`"cooldown: 142 minutes remaining — retry at <ISO timestamp>"`, not `"blocked"`).

## On success

- Confirm both tx ids via Hiro (`curl https://api.hiro.so/extended/v1/tx/0x<HASH> | jq .tx_status`). `success`, not `abort_by_post_condition`.
- Clear the state marker only after the redeploy confirms (or after a successful swap-only cycle when `--skip-redeploy` is set — in that case the marker stays until resumption closes it).
- Record the cycle in structured JSON for any downstream portfolio tracker.
