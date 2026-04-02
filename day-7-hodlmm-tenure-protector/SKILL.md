---
name: hodlmm-tenure-protector
description: "Nakamoto tenure-aware risk monitor that protects HODLMM concentrated liquidity positions from toxic arbitrage flow during stale Bitcoin block tenures — the only skill that correlates Bitcoin L1 block timing with L2 LP risk."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "true"
  arguments: "doctor | install-packs | run [--pool <id>] [--wallet <address>] [--verbose]"
  entry: "hodlmm-tenure-protector/hodlmm-tenure-protector.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, infrastructure"
---

# hodlmm-tenure-protector

> **⚠️ DEPRECATED** — This skill's core premise was flawed. Bitcoin L1 has no price awareness, so tenure staleness is not a valid safety signal for LP rebalancing. Identified by [@JakeBlockchain in PR #125 review](https://github.com/BitflowFinance/bff-skills/pull/125). PR closed. The useful parts (decision gate architecture) were absorbed into [day-8-hodlmm-rebalance-arbiter](../day-8-hodlmm-rebalance-arbiter/), which uses only defensible signals. Kept here as historical record.

## What it does

Monitors the age of the current Bitcoin block tenure and correlates it with HODLMM concentrated liquidity risk. Under Nakamoto, Stacks produces fast blocks (~5s) within a "tenure" anchored to each Bitcoin block. Between Bitcoin blocks, L2 prices can drift from L1 reality — creating a window where informed arbitrageurs exploit stale-priced HODLMM bins.

The protector reads real-time Bitcoin block timing from Hiro APIs, computes tenure freshness, and assesses every active HODLMM pool for toxic flow exposure based on tenure age, pool volume, bin width, bin price deviation, and (optionally) the LP's individual position overlap with the active trading range.

Output is a four-level risk signal:
- **GREEN / SAFE** — Tenure fresh, bins safe at current spreads
- **YELLOW / CAUTION** — Tenure aging, monitor high-volume pools
- **RED / WIDEN** — Stale tenure, widen bin spreads to reduce arb exposure
- **CRITICAL / SHELTER** — Tenure change imminent, move to outer bins or pause

## Why agents need it

Every HODLMM LP is silently exposed to tenure-drift risk. When a Bitcoin block is overdue (>15 minutes), the L2/L1 price gap widens and arbitrageurs with faster L1 data trade against your bins. No existing skill monitors this — LPs currently have zero visibility into when their positions are mechanically vulnerable.

This is the HODLMM circuit breaker: it tells LPs exactly when their money is safe and when they are about to get picked off.

## Safety notes

- **Read-only skill** — never executes transactions, only reads chain state and pool data
- **Fail-safe default** — if any data source is unreachable, defaults to CRITICAL/SHELTER (maximum caution)
- **No API keys required** — all data sources are public Hiro and Bitflow endpoints
- **Pool TVL gate** — ignores pools below $10,000 TVL to avoid noise from dust pools
- **APR sanity check** — rejects pools with >500% APR as data anomalies
- **Structured exit codes** — 0 (safe), 1 (widen), 2 (shelter/critical), 3 (error)

## Commands

### `doctor`
Validates all 5 data sources: Hiro node info, Hiro blocks, Hiro burn blocks, Bitflow HODLMM pools, Hiro fees.

```bash
bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts doctor
```

### `install-packs`
No additional packs required. Uses native `fetch` for all API calls.

```bash
bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts install-packs
```

### `run`
Assesses current tenure risk across all HODLMM pools (or a specific pool). When `--wallet` is provided, performs position-level analysis by checking if the LP's bins overlap the active trading range. Always fetches bin price quotes to validate actual L2/L1 price deviation.

```bash
# All pools (pool-level risk only)
bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts run

# Specific pool
bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts run --pool dlmm_1

# Position-level risk for a specific wallet
bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts run --wallet SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9

# Combined: specific pool + wallet + verbose
bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts run --pool dlmm_1 --wallet SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9 --verbose
```

#### `--wallet <address>` (optional)
When provided, fetches the user's bin positions from Bitflow and checks whether held bins overlap the active trading range. If the LP's bins are entirely in outer range, toxic flow exposure is downgraded to LOW regardless of tenure age (outer bins have zero toxic flow exposure). If only partially overlapping, risk is reduced by one severity level. Without `--wallet`, falls back to pool-level assessment only.

## Output contract

```json
{
  "status": "ok | degraded | error",
  "decision": "SAFE | CAUTION | WIDEN | SHELTER",
  "action": "Human-readable recommendation with specific timing",
  "tenure": {
    "burn_block_height": 943140,
    "burn_block_time_iso": "2026-04-01T01:59:15.000Z",
    "tenure_age_s": 485,
    "tenure_height": 237125,
    "stacks_tip_height": 7428849,
    "stacks_blocks_in_tenure": 153,
    "risk_level": "GREEN | YELLOW | RED | CRITICAL",
    "risk_description": "Tenure fresh (8.1m). Bitcoin block recent — L2 prices aligned with L1."
  },
  "timing": {
    "avg_gap_s": 612,
    "min_gap_s": 120,
    "max_gap_s": 1800,
    "stddev_s": 340,
    "predicted_next_block_s": 612,
    "blocks": [
      { "burn_height": 943140, "burn_time_iso": "...", "gap_s": 1380, "stacks_blocks": 153 }
    ]
  },
  "pools": [
    {
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx",
      "tvl_usd": 190280,
      "apr": 47.64,
      "bin_step": 10,
      "volume_24h_usd": 515758,
      "current_spread_bps": 10,
      "recommended_spread_bps": 10,
      "spread_action": "HOLD | WIDEN | WIDEN_URGENT | EXIT_RISK",
      "toxic_flow_exposure": "LOW | MODERATE | HIGH | CRITICAL",
      "rationale": "Tenure fresh — normal spreads safe.",
      "position_overlap": {
        "pool_id": "dlmm_1",
        "wallet": "SP3K8...",
        "total_bins": 12,
        "active_bins": 2,
        "bins_in_active_range": 4,
        "overlap_ratio": 0.333,
        "position_exposure": "NONE | PARTIAL | FULL"
      },
      "bin_price_deviation": {
        "pool_id": "dlmm_1",
        "active_bin_id": 8388608,
        "active_bin_price": 95234.56,
        "price_deviation_pct": 0.12,
        "price_source": "bin_quotes | unavailable"
      }
    }
  ],
  "sources_used": ["hiro-node-info", "hiro-blocks", "hiro-burn-blocks", "bitflow-hodlmm", "hiro-fees"],
  "sources_failed": [],
  "timestamp": "2026-04-01T02:30:00.000Z",
  "error": null
}
```

## Data sources

| Source | Endpoint | Data |
|--------|----------|------|
| Hiro Node Info | `/v2/info` | Tenure height, burn block height, sync status |
| Hiro Blocks | `/extended/v2/blocks` | Block timestamps, burn block time, tenure mapping |
| Hiro Burn Blocks | `/extended/v2/burn-blocks` | BTC block history, inter-block gaps, Stacks blocks per tenure |
| Bitflow HODLMM | `bff.bitflowapis.finance/api/app/v1/pools` | Pool TVL, APR, volume, bin step, fees |
| Bitflow Bin Quotes | `bff.bitflowapis.finance/api/quotes/v1/bins/{pool_id}` | Active bin price, price deviation measurement |
| Bitflow User Positions | `bff.bitflowapis.finance/api/app/v1/users/{addr}/positions/{pool}/bins` | User's bin positions for overlap analysis (--wallet) |
| Hiro Fees | `/v2/fees/transfer` | Current gas costs for rebalance cost awareness |

## HODLMM integration

This skill directly monitors all active HODLMM DLMM pools and provides per-pool risk assessments. It is designed to be the first check before any HODLMM operation:

- **Before deploying liquidity** — check tenure is GREEN before committing capital
- **During active positions** — poll periodically to detect tenure drift
- **Before rebalancing** — verify tenure is fresh so rebalance doesn't execute at stale prices
- **Composable** — exports `assessTenureRisk()` for other skills to import

## Known constraints

- Bitcoin block times are inherently unpredictable (range: 1–60+ minutes). The skill provides probabilistic guidance, not guarantees.
- `dynamicFee` is currently 0 on all HODLMM pools. If Bitflow enables dynamic fees based on volatility, this skill's spread recommendations should be adjusted to account for automatic fee widening.
- Read-only — cannot execute bin adjustments. Outputs actionable recommendations for the agent or human to execute.
- Tenure age calculation depends on system clock accuracy. NTP-synced hosts recommended.
