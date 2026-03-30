---
name: smart-yield-migrator
description: "Cross-protocol DeFi migration optimizer — scans live APY across Bitflow HODLMM, Zest, and ALEX, estimates real gas cost for the move, and applies a Yield-to-Gas profit gate before recommending any capital migration. Never move a satoshi unless the math says yes."
author: cliqueengagements
author_agent: "Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
user-invocable: true
arguments: "doctor | install-packs | run --from <zest|hodlmm|alex|pox> --asset <sBTC|STX> --amount <number> [--risk <low|medium|high>]"
entry: "smart-yield-migrator/smart-yield-migrator.ts"
requires: []
tags: [defi, read-only, mainnet-only, l2, yield, hodlmm, infrastructure]
network: mainnet
---

# Smart Yield Migrator

One command that runs a full "Migration Checklist" before recommending any capital move across Stacks DeFi protocols. Scans live APY, estimates the real gas cost, and applies a **Yield-to-Gas profit gate** — so agents and users in capital-constrained markets never pay more in fees than they earn in extra yield.

## What it does

Runs a three-step checklist before recommending any migration:

**Step 1 — The Scanner**
Fetches live APY from every major Stacks yield venue in parallel:
- Bitflow HODLMM concentrated liquidity pools (`bff.bitflowapis.finance`)
- Bitflow XYK pools (Bitflow ticker API)
- Zest Protocol lending (Hiro read-only contract call)
- ALEX DEX liquidity pools (`api.alexlab.co`)
- Stacks PoX stacking (`api.mainnet.hiro.so/v2/pox`)

**Step 2 — The YTG (Yield-to-Gas) Filter**
Fetches the current Stacks network fee rate and estimates the gas cost of the full migration (withdraw from current protocol + deposit into destination). Calculates:
- Migration gas cost in STX and USD
- Break-even period (hours/days until extra yield covers gas)
- 7-day net gain after gas

**Step 3 — The Profit Gate**
Applies a hard rule in code: `7-day extra yield > gas cost × 3`
- If passed → `MIGRATE` with exact destination, action steps, and break-even timeline
- If failed → `STAY` with reason and estimated wait time until conditions improve

## Why agents need it

An agent optimizing yield across Stacks DeFi faces two hidden costs that existing skills ignore:

1. **Gas cost** — withdrawing from Zest and depositing into HODLMM costs 2 contract calls. At current network rates that's ~0.005-0.012 STX per call. Small but non-zero.
2. **Churn risk** — migrating for a 0.5% APY improvement that takes 6 months to break even is not optimization, it's churn. This skill prevents it.

Especially critical in **emerging markets** (sub-Saharan Africa, Southeast Asia) where agents may manage smaller positions — even a $0.50 gas cost matters when the position is $50.

## Safety notes

- **Read-only.** No transactions submitted. No wallet required.
- **No funds moved.** Analysis only — output includes exact MCP commands for agent to execute after review.
- **Mainnet only.** All endpoints target Stacks mainnet.
- **Profit gate is enforced in code** — not just documented:
  - `PROFIT_GATE_MULTIPLIER = 3` — 7d gain must exceed 3× gas cost
  - `MIN_APY_IMPROVEMENT_PCT = 1.0` — never recommend migration for <1% APY gain
  - `MIN_POSITION_USD = 50` — warns if position too small to benefit from any migration
  - `MIN_DEST_TVL_USD = 100_000` — destination pool must have >$100k TVL
  - `MAX_SLIPPAGE_PCT = 0.5` — destination pool flagged if spread >0.5%
- Exit codes: `0` = ok, `1` = degraded (some sources unavailable), `3` = error

## Commands

### doctor

Checks all data sources: Bitflow HODLMM API, Bitflow Ticker, Zest contract, ALEX tickers, Hiro PoX, Hiro fee rate, CoinGecko prices.

```bash
bun run smart-yield-migrator/smart-yield-migrator.ts doctor
```

### install-packs

No additional packages required — self-contained using native `fetch`.

```bash
bun run smart-yield-migrator/smart-yield-migrator.ts install-packs
```

### run

Runs the full migration checklist. Specify where you currently are, what asset, and how much.

```bash
# Check if migrating 1 sBTC from Zest is worth it
bun run smart-yield-migrator/smart-yield-migrator.ts run --from zest --asset sBTC --amount 1.0

# Check migration for STX from PoX, conservative risk only
bun run smart-yield-migrator/smart-yield-migrator.ts run --from pox --asset STX --amount 5000 --risk low

# Check migration from HODLMM
bun run smart-yield-migrator/smart-yield-migrator.ts run --from hodlmm --asset sBTC --amount 0.5 --risk medium
```

## Output contract

All outputs are strict JSON to stdout.

```json
{
  "status": "ok | degraded | error",
  "verdict": "MIGRATE | STAY | INSUFFICIENT_DATA",
  "current": {
    "protocol": "zest",
    "asset": "sBTC",
    "amount": 1.0,
    "apy_pct": 5.0,
    "weekly_earn_usd": 66.35
  },
  "best_destination": {
    "protocol": "bitflow-hodlmm",
    "pool": "STX/sBTC (dlmm_6)",
    "apy_pct": 12.4,
    "weekly_earn_usd": 164.62,
    "tvl_usd": 1389000,
    "risk": "low"
  },
  "migration": {
    "apy_improvement_pct": 7.4,
    "extra_weekly_earn_usd": 98.27,
    "gas_cost_stx": 0.012,
    "gas_cost_usd": 0.003,
    "breakeven_hours": 0.52,
    "7d_net_gain_usd": 98.27
  },
  "profit_gate": {
    "rule": "7d_extra_yield > gas_cost × 3",
    "7d_extra_yield_usd": 98.27,
    "threshold_usd": 0.009,
    "passed": true,
    "verdict": "MIGRATE"
  },
  "checklist": {
    "yield_improvement": "PASS — HODLMM pays 7.4% more than Zest",
    "min_improvement": "PASS — 7.4% > 1.0% minimum threshold",
    "profit_gate": "PASS — 7d gain ($98.27) > gas × 3 ($0.009)",
    "destination_tvl": "PASS — pool TVL $1.39M > $100k minimum",
    "position_size": "PASS — position ($69,000) above $50 minimum"
  },
  "action": "Withdraw 1.0 sBTC from Zest. Deposit into Bitflow HODLMM dlmm_6 (STX/sBTC). Gas: ~0.012 STX ($0.003). Break-even: 31 minutes.",
  "sources_used": ["bitflow-hodlmm", "bitflow-xyk", "alex", "pox", "hiro-fees", "coingecko"],
  "sources_failed": [],
  "timestamp": "2026-03-27T03:00:00.000Z"
}
```

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Bitflow HODLMM API | DLMM pool list, fee schedules | `bff.bitflowapis.finance/api/quotes/v1/pools` |
| Bitflow Ticker API | XYK pool TVL, 24h volume | `bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker` |
| ALEX DEX | Pair tickers, volume, USD prices | `api.alexlab.co/v1/tickers` |
| Hiro PoX | Stacking cycle data, stacked STX | `api.mainnet.hiro.so/v2/pox` |
| Hiro Fee Rate | Current STX fee rate (μSTX/byte) | `api.mainnet.hiro.so/v2/fees/transfer` |
| Hiro Transactions | Recent contract call fee samples | `api.mainnet.hiro.so/extended/v1/address/.../transactions` |
| CoinGecko | BTC/USD, STX/USD spot prices | `api.coingecko.com/api/v3` |

## Known constraints

- Zest Protocol APY is estimated from on-chain supply rate via read-only contract call. If the Zest API is unavailable, Zest is excluded from the destination ranking.
- HODLMM APY applies only when position stays in the active bin range. Out-of-range = 0 fee income. Pair with HODLMM Bin Guardian for live range monitoring.
- PoX stacking requires a minimum ~120,000 STX and has a lock-up period per cycle. The skill flags this constraint when PoX is the recommended destination.
- Gas cost estimates are based on recent median contract call fees. Actual fees may vary ±50% during congestion.
