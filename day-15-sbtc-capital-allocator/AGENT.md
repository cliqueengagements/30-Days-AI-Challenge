---
name: sbtc-capital-allocator-agent
skill: sbtc-capital-allocator
description: "Autonomous sBTC capital allocator that routes between HODLMM and Zest based on risk-adjusted yield, with DCA execution mode triggered by market risk signals."
---

# Agent Behavior — sBTC Capital Allocator

## Decision order

1. Run `doctor` to verify wallet, APIs, and oracle connectivity. If any check fails, stop and surface the blocker.
2. Run `scan` to get live APY across HODLMM and Zest.
3. Run `monitor` to check oracle freshness, LP range drift, and whale activity.
4. Run `recommend` to get the two-layer decision:
   - **WHERE:** which protocol (HODLMM or Zest)
   - **HOW:** lump_sum or dca (based on risk signals)
5. If recommendation `action` is `move`:
   - If `execution_mode` is `lump_sum`: run `execute --confirm` once.
   - If `execution_mode` is `dca`: run `execute --confirm` once per interval. Wait between intervals (recommended: 30+ minutes, matching cooldown). Re-run `recommend` before each interval to re-evaluate conditions.
6. Call the emitted MCP tool (`zest_supply` or `call_contract` for HODLMM `add-relative-liquidity-multi`) to complete execution.
7. Verify the transaction status after broadcast.

## Guardrails

- **Oracle gate (hard block):** Never execute if Pyth price diverges >2% from pool price or if Pyth data is older than 120 seconds.
- **Fee spike gate (hard block):** Never execute into a pool where 1-day fees are >3x the 7-day daily average.
- **TVL impact gate (hard block):** Never execute if deploy amount exceeds 5% of pool TVL.
- **DCA mode (soft gate):** When risk signals fire (oracle divergence >1%, whale pressure, fee spikes in ecosystem, high-risk pool), split deployment into 5 intervals instead of lump sum. This is a timing control, not a destination change.
- **Spend cap:** Maximum 500,000 sats (0.005 BTC) per execution. Hard-coded constant.
- **Wallet reserve:** Always keep at least 10,000 sats in the wallet.
- **Gas floor:** Refuse all operations if STX balance is below 0.1 STX.
- **Cooldown:** 30 minutes between executions.
- **APY threshold:** Only recommend `move` if target offers >2% higher APY than current position.
- **Dry-run default:** Execute without `--confirm` shows preview with execution_mode. No capital moves without explicit confirmation.
- **Micro-pool filter:** Pools below $10,000 TVL are excluded from routing entirely.

## On error

- Log the full error payload with code, message, and suggested next action.
- Do not retry silently — surface to the user with the `next` field as guidance.
- If oracle is unavailable, degrade to read-only mode (scan/monitor only, no execute).
- If Bitflow API is down, report Zest-only data rather than failing entirely.

## On success

- Report the target protocol, pool, APY, amount, and execution mode.
- In DCA mode, report which interval was completed and how many remain.
- Include the MCP command that was emitted for transparency.
- Log the cooldown expiry time so the agent knows when it can execute again.
- Update state file with execution timestamp and daily counter.
