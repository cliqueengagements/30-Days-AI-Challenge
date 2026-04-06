# Day 10 — ZBG Alpha Engine (SUPERSEDED)

> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/196 (closed)
> **Superseded by:** [Day 12 — Stacks Alpha Engine](../day-12-stacks-alpha-engine/) (PR #213)

## Why it was closed

The Granite LP pool accepts **aeUSDC only** — not sBTC as originally assumed. Attempting to deposit sBTC returned `(err u1)` on-chain: [`dd4061b3...`](https://explorer.hiro.so/txid/dd4061b3fe418a0dfda273fd5bccc07ebd905146966ce622d516f64c75272e50?chain=mainnet)

This was a fundamental routing bug that required a full rebuild rather than a patch.

## What changed in the rebuild (PR #213)

- Granite correctly routes aeUSDC to LP deposit
- Added Hermetica protocol (USDh staking via correct `unstake` / `silo.withdraw`)
- Added YTG (Yield-to-Gas) profit gate
- Expanded from 3 to 6 tokens
- 3-tier yield mapping (deploy now / swap first / acquire to unlock)
- 11 doctor checks (was 10)

See [day-12-stacks-alpha-engine](../day-12-stacks-alpha-engine/) for the working version.
