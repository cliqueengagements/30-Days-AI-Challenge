# Day 8 — HODLMM Rebalance Arbiter

> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/141 (closed — superseded by PR #213)

## Skill name

hodlmm-rebalance-arbiter

## Category

- [ ] Trading
- [x] Yield
- [x] Infrastructure

**HODLMM integration?** Yes

## What it does

Answers one question for HODLMM liquidity providers: **"Should I rebalance right now, or wait?"**

Consumes 2 independent signals — bin drift and sBTC peg health — to produce a single REBALANCE, BLOCKED, or IN_RANGE verdict. Running monitoring skills independently gives you separate signals but no verdict. The arbiter encodes the operational logic into a single decision gate.

| Scenario | Decision |
|---|---|
| All GREEN | **REBALANCE** — safe to move |
| Reserve YELLOW | **REBALANCE** — acceptable risk |
| Any RED | **BLOCKED** — specific reason provided |
| Any ERROR | **DEGRADED** — fix data sources first |
| Bins in range | **IN_RANGE** — no rebalance needed |

## Why agents need it

Monitoring without a decision layer is noise. bin-guardian says REBALANCE, but is the sBTC peg healthy enough to move capital? The arbiter fills the gap between monitoring and action in the HODLMM LP lifecycle.

v2 note: The original submission included a third signal (Bitcoin tenure timing) which was removed after community review identified a flawed premise. Two rock-solid signals beat three with a weak link.

## Safety notes

- **Read-only** — never executes transactions, never moves funds
- **Fail-safe default** — missing or stale data pushes toward WAIT or DEGRADED, never toward REBALANCE
- **Double YELLOW = WAIT** — one caution signal is acceptable; two simultaneous caution signals defer action
- **Silence locks the gate** — 2 positive signals required to unlock REBALANCE
- **No API keys required** — all data from public endpoints
- **Structured exit codes** — 0 (rebalance/in_range), 1 (blocked), 3 (degraded/error)
- **BIP-341 PoR derivation** — full Golden Chain (aggregate pubkey -> P2TR -> BTC balance) for sBTC reserve verification
- **Bech32m self-test** — crypto failure blocks all operations

## HODLMM integration

Decision layer in the HODLMM LP lifecycle:

| Phase | Skill | Role |
|-------|-------|------|
| Entry | usdcx-yield-optimizer | Where to deploy capital |
| Monitor | bin-guardian, sbtc-reserve | Watch for drift and peg health |
| **Act** | **rebalance-arbiter** | **Should I rebalance now?** |
| Optimize | smart-yield-migrator | Move between protocols |
| Exit | hodlmm-emergency-exit | Get out when things break |

## Data sources

| Source | Signal |
|--------|--------|
| Bitflow Quotes/App/Bins API | bin_guardian — pool discovery, TVL, active bin |
| Bitflow User Positions | bin_guardian — LP bin positions |
| Hiro Node Info | sbtc_reserve — block heights |
| sBTC Contract | sbtc_reserve — circulating supply |
| sBTC Registry | sbtc_reserve — signer pubkey |
| mempool.space | sbtc_reserve — BTC reserve balance |

## Known constraints

- Read-only — outputs a decision but cannot execute the rebalance itself
- sBTC reserve uses full Golden Chain derivation; sbtc-registry pubkey format changes would fail gracefully
- Requires `--wallet` — cannot decide without knowing which bins the LP holds
- Superseded by stacks-alpha-engine (PR #213) which includes this logic in its Guardian module
