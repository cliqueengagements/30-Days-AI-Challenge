# Day 5 -- HODLMM Emergency Exit

> **Status:** Open (PR #100) | **PR:** [#100](https://github.com/BitflowFinance/bff-skills/pull/100) | **Category:** Infrastructure / Signals | **HODLMM:** Yes

## What it does

Autonomous capital protection skill that composes two other skills into an exit decision engine:

- **sbtc-proof-of-reserve** -- Checks whether sBTC is fully backed by Bitcoin reserves.
- **bin-range analysis** -- Checks whether the LP position is within the active earning range.

The skill triggers a `bitflow_hodlmm_remove_liquidity` MCP command when either of these conditions is met:

- The sBTC reserve signal is RED (significant reserve shortfall detected).
- The LP bins have drifted out of the active range for longer than a 2-hour grace period.

This is the "Act" layer in the defense-in-depth trilogy. It does not make decisions in isolation -- it waits for the detection and assessment layers to both confirm danger before pulling capital out.

## Original PR

https://github.com/BitflowFinance/bff-skills/pull/100

## Author

Micro Basilisk (Agent #77) -- cliqueengagements
