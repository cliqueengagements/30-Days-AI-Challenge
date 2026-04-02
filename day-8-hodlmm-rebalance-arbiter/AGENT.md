---
name: hodlmm-rebalance-arbiter
skill: hodlmm-rebalance-arbiter
description: "Decision gate that synthesizes 3 independent signals into a single REBALANCE/BLOCKED/IN_RANGE/DEGRADED verdict for HODLMM LPs."
---

# hodlmm-rebalance-arbiter

## Purpose

The arbiter answers one question: **"Should I rebalance right now, or wait?"**

It consumes 3 signals — bin drift, tenure safety, and sBTC peg health — and applies a priority matrix to produce a single verdict. This replaces the need for an LP to manually cross-reference 3 independent skill outputs.

## Decision order

1. **Check data availability** — if any signal source returns ERROR, output DEGRADED. Never act on incomplete data.
2. **Check if rebalance is needed** — if bins are in range, output IN_RANGE regardless of other signals.
3. **Check for RED signals** — if tenure is RED/CRITICAL or sBTC reserve is RED, output BLOCKED with specific reason and retry_after timestamp.
4. **Check for double YELLOW** — if both tenure and reserve are YELLOW simultaneously, output BLOCKED. One caution signal is acceptable; two means the environment is degrading on multiple fronts.
5. **All clear** — if no blockers remain, output REBALANCE.

## Guardrails

- **Read-only** — this skill never executes transactions, never constructs transaction payloads, never moves funds. It outputs a decision for a human or executor skill to act on.
- **Fail-safe default** — the default state is "do nothing." Missing data, malformed responses, stale data, and timeouts all push toward WAIT or DEGRADED — never toward REBALANCE.
- **Silence locks the gate** — you need 3 positive signals to unlock a REBALANCE decision. Any gap in data blocks action.
- **Double YELLOW = WAIT** — one caution signal is tolerable. Two simultaneous caution signals mean conditions are deteriorating and action should be deferred until at least one clears.
- **No credential access** — uses only public API endpoints. No wallet passwords, no private keys, no API keys.
- **Stale data detection** — if tenure age exceeds 2 hours, the skill flags potential Hiro API staleness and downgrades tenure to YELLOW.
- **30-second timeout** — all API calls abort after 30 seconds. Timeouts are treated as ERROR → DEGRADED.
- **Pool TVL gate** — ignores pools below $10,000 TVL to avoid decisions based on dust pool noise.
- **Volume gate** — requires $10,000+ 24h volume before recommending a rebalance. Low-volume pools are not worth the gas.
- **Slippage cap** — rebalance is blocked if active bin price deviates >0.5% from Bitflow app price.

## Signal sources

| Signal | Data Source | Question Answered |
|--------|------------|-------------------|
| bin_guardian | Bitflow Quotes + App + User Positions APIs | Are my bins out of range? Is volume sufficient? Is slippage acceptable? |
| tenure_protector | Hiro Node Info + Blocks + Burn Blocks APIs | Is the current Bitcoin tenure fresh enough for reliable L2 prices? |
| sbtc_reserve | sBTC Registry + mempool.space + Hiro Contract Reads | Is the sBTC peg healthy? Is the reserve fully backed? |

## Priority matrix

| bin_guardian | tenure | reserve | Decision |
|---|---|---|---|
| IN_RANGE | any | any | **IN_RANGE** |
| REBALANCE | GREEN | GREEN | **REBALANCE** |
| REBALANCE | GREEN | YELLOW | **REBALANCE** |
| REBALANCE | YELLOW | GREEN | **REBALANCE** |
| REBALANCE | YELLOW | YELLOW | **BLOCKED** |
| REBALANCE | RED | any | **BLOCKED** |
| REBALANCE | any | RED | **BLOCKED** |
| any ERROR | any | any | **DEGRADED** |

## Refusal conditions

The arbiter will refuse to recommend REBALANCE when:
- Any data source is unreachable (30s timeout)
- Tenure is RED or CRITICAL (stale Bitcoin block — prices unreliable)
- sBTC reserve ratio is below 0.995 (peg instability)
- Both tenure and reserve are YELLOW simultaneously
- Pool TVL is below $10,000
- 24h volume is below $10,000
- Price slippage exceeds 0.5%
- Wallet address format is invalid

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | REBALANCE or IN_RANGE — action clear |
| 1 | BLOCKED — safety signal preventing rebalance |
| 3 | DEGRADED or ERROR — data sources need attention |
