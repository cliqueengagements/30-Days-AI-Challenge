# Day 7 — HODLMM Tenure Protector (DEPRECATED)

> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/125 (closed)

## Skill name

hodlmm-tenure-protector

## Category

- [ ] Trading
- [ ] Yield
- [x] Infrastructure
- [x] Signals

## Deprecation notice

This skill's core premise was flawed. Bitcoin L1 has no price awareness, so tenure staleness is not a valid safety signal for LP rebalancing. Identified by @JakeBlockchain in PR #125 review. The useful parts (decision gate architecture) were absorbed into [day-8-hodlmm-rebalance-arbiter](../day-8-hodlmm-rebalance-arbiter/).

## What it does

Monitors Bitcoin block tenure age and correlates it with HODLMM concentrated liquidity risk. Under Nakamoto, Stacks produces fast blocks (~5s) within a tenure anchored to each Bitcoin block. Between Bitcoin blocks, L2 prices can drift from L1 reality, creating a window where arbitrageurs exploit stale-priced HODLMM bins.

Outputs a four-level risk signal: GREEN (safe), YELLOW (caution), RED (widen spreads), CRITICAL (shelter).

## Safety notes

- **Read-only** — never executes transactions
- **Fail-safe default** — unreachable data sources default to CRITICAL/SHELTER
- **No API keys required** — all public endpoints
- **Pool TVL gate** — ignores pools below $10K TVL
- **APR sanity check** — rejects pools with >500% APR

## HODLMM integration

Directly monitors all active HODLMM DLMM pools with per-pool risk assessments. Designed as a pre-check before any HODLMM operation.

## Data sources

| Source | Data |
|--------|------|
| Hiro Node Info | Tenure height, burn block height |
| Hiro Blocks/Burn Blocks | Block timestamps, inter-block gaps |
| Bitflow HODLMM | Pool TVL, APR, volume, bin step |
| Bitflow Bin Quotes | Active bin price, deviation |
| Bitflow User Positions | LP bin overlap analysis |
| Hiro Fees | Gas costs for rebalance awareness |

## Known constraints

- Core premise invalidated — L1 has no price awareness, tenure age is not a valid LP risk signal
- Bitcoin block times are inherently unpredictable (1-60+ min)
- Read-only — cannot execute bin adjustments
- Kept as historical record only
