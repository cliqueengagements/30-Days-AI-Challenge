# Day 9 — ZBG Yield Scout

> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/191 (closed — superseded by PR #213)

## Skill name

zbg-yield-scout

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

**HODLMM integration?** Yes — scans all 8 HODLMM pools

## What it does

One command, five sections, no DeFi knowledge required. Scans Zest, Bitflow (HODLMM), and Granite for your sBTC, STX, and USDCx positions. Compares yield across the top 3 sBTC protocols on Stacks, recommends the best safe move, and shows sBTC break prices.

**ZBG** = Zest ($77.7M TVL) + Bitflow HODLMM + Granite ($25.9M TVL) — over $100M TVL combined.

### Five-section output

1. **What You Have** — Token balances in USD
2. **Available ZBG Positions** — Active deposits across all 3 protocols + 8 HODLMM pools
3. **ZBG Smart Options** — Side-by-side yield comparison sorted best to worst with APY, daily/monthly earnings, gas cost
4. **Best Safe Move** — One clear recommendation with opportunity cost
5. **Break Prices** — sBTC prices where HODLMM bins go out of range or Granite liquidates

**Read-only. No transactions. No gas. No risk.**

## Why agents need it

Most agents deposit into one protocol and forget. They don't know if Granite is paying more than Zest this week, or that their HODLMM bins went out of range. This skill answers: "Where should my money be right now?"

## Safety notes

- **Read-only** — no transactions submitted, no gas spent
- **Mainnet-only** — all on-chain reads target Stacks mainnet
- Granite and HODLMM reads go direct to on-chain contracts via Hiro API
- Break prices use sBTC on-chain pricing, not BTC L1
- Degrades gracefully if <4 data sources respond

## HODLMM integration

Scans all 8 HODLMM pools for user positions, active bins, and APR. Shows per-pool yield in the Smart Options table. Break prices show where HODLMM bins exit range.

## Data sources

| Source | Data |
|--------|------|
| Hiro Stacks API | STX balance, contract reads |
| Tenero API | sBTC/STX/USDCx USD prices |
| Zest Protocol | Supply position (on-chain read) |
| Granite Protocol | Supply/borrow params, user position (on-chain read) |
| HODLMM Pool Contracts | User bins, balances, active bin (8 pools) |
| Bitflow App API | HODLMM pool APR, TVL, volume |

## Known constraints

- Read-only — recommends but does not execute
- Superseded by stacks-alpha-engine (PR #213) which adds write capability, YTG profit gates, Hermetica support, and 6-token scanning
