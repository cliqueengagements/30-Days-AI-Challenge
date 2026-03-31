# Day 6 — [AIBTC Skills Comp Day 6] USDCx Yield Optimizer
> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/118
> **Status:** Open

## Skill Name

usdcx-yield-optimizer

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

The first skill that treats USDCx as a primary yield asset. Scans every live USDCx venue on Bitflow (7 HODLMM pools + XYK), risk-tags each one (stablecoin=low, STX=medium, sBTC=medium/high based on reserve health), applies a Yield-to-Gas profit gate, and outputs executable MCP command specs to deploy USDCx to the highest-yielding HODLMM pool. Suggests Hermetica sUSDh as a cross-protocol route when swap yields beat direct venues.

Write-ready — generates complete `call_contract` deployment specs for `add-liquidity-multi` on the HODLMM liquidity router with `--confirm`. Currently spec-only because MCP `call_contract` doesn't support `trait_reference` args (documented honestly with exact fix path).

## On-chain proof

Read-only skill — no on-chain transactions submitted. Live mainnet output below from all 6 data sources.

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Scans all 7 USDCx HODLMM concentrated liquidity pools via the Bitflow App API (`/api/app/v1/pools`), extracts live APR/TVL/volume, classifies each by pair type (stablecoin vs volatile), and generates deployment specs targeting the HODLMM liquidity router (`dlmm-liquidity-router-v-1-2.add-liquidity-multi`).

| Pool | Pair | Fee | Type |
|------|------|-----|------|
| `dlmm_1` | sBTC/USDCx | 15+15 bps | Volatile |
| `dlmm_2` | sBTC/USDCx | 15+15 bps | Volatile |
| `dlmm_3` | STX/USDCx | 15+15 bps | Volatile |
| `dlmm_4` | STX/USDCx | 15+15 bps | Volatile |
| `dlmm_5` | STX/USDCx | 15+15 bps | Volatile |
| `dlmm_7` | aeUSDC/USDCx | 3+3 bps | Stablecoin |
| `dlmm_8` | USDh/USDCx | 3+3 bps | Stablecoin |

## Write Capability Status

Generates complete `call_contract` specs for `add-liquidity-multi` on the HODLMM liquidity router with `--confirm` gate, 5000 USDCx cap, active bin fetch. **Spec-only** because MCP `call_contract` doesn't support `trait_reference` arguments (required for `pool-trait`, `x-token-trait`, `y-token-trait`). Once MCP adds trait_reference support — a one-line type addition in the Clarity argument encoder — the skill becomes fully autonomous with zero code changes.

## v2 Changelog

First submission for this skill. Builds on ecosystem knowledge from 3 prior PRs:

| # | Prior PR | Contribution to this skill |
|---|----------|---------------------------|
| PR #39 | hodlmm-bin-guardian | HODLMM pool scanning pattern, Bitflow App API integration |
| PR #56 | hermetica-yield-rotator | Hermetica sUSDh rate fetching, cross-protocol route suggestion |
| PR #97 | sbtc-proof-of-reserve | sBTC reserve health signal (price-deviation proxy) |

## Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is a quoted string (`"true"`)
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results

**doctor** — 6/6 sources green

```json
{
  "status": "ok",
  "checks": [
    {
      "name": "Hermetica Staking (sUSDh rate)",
      "ok": true,
      "detail": "estimated APY 20.00%"
    },
    {
      "name": "Bitflow Ticker (XYK + sBTC price)",
      "ok": true,
      "detail": "44 pairs"
    },
    {
      "name": "Hiro Fee Rate",
      "ok": true,
      "detail": "~800 uSTX for 2-call migration"
    },
    {
      "name": "Bitflow Prices (from pool data)",
      "ok": true,
      "detail": "BTC $66,753.088 STX $0.21697259 sBTC/BTC 1.0051"
    },
    {
      "name": "Bitflow HODLMM App API",
      "ok": true,
      "detail": "8 pools total, 7 with USDCx"
    },
    {
      "name": "sBTC Price Signal",
      "ok": true,
      "detail": "signal=YELLOW, deviation=0.51%"
    }
  ],
  "message": "All sources reachable. USDCx venue scan ready."
}
```

**run** — DEPLOY decision, 3 venues ranked, 5/5 sources

```json
{
  "status": "ok",
  "decision": "DEPLOY",
  "direct_venues": [
    {
      "rank": 1,
      "protocol": "bitflow-xyk",
      "pool_id": "xyk-pool-stx-aeusdc-v-1-2",
      "pair": "STX/aeUSDC",
      "apr_pct": 9.02,
      "tvl_usd": 344710,
      "risk": "medium",
      "risk_factors": ["passive LP — lower capital efficiency than HODLMM"]
    },
    {
      "rank": 2,
      "protocol": "hodlmm",
      "pool_id": "dlmm_3",
      "pair": "STX/USDCx",
      "apr_pct": 3.62,
      "tvl_usd": 1032415,
      "risk": "medium",
      "risk_factors": ["STX volatility — impermanent loss risk"]
    },
    {
      "rank": 3,
      "protocol": "hodlmm",
      "pool_id": "dlmm_7",
      "pair": "aeUSDC/USDCx",
      "apr_pct": 0.02,
      "tvl_usd": 98425,
      "risk": "low",
      "risk_factors": []
    }
  ],
  "suggested_routes": [
    {
      "destination": "Hermetica sUSDh vault",
      "estimated_apy_pct": 20,
      "swap_path": "USDCx -> sBTC (Bitflow) -> stake USDh -> sUSDh",
      "swap_cost_pct": 0.3,
      "net_apy_pct": 19.7,
      "risk": "high",
      "note": "Requires sBTC exposure. Reserve signal YELLOW — elevated risk."
    }
  ],
  "risk_assessment": {
    "sbtc_reserve_signal": "YELLOW",
    "sbtc_price_deviation_pct": 0.51,
    "flagged_pools": []
  },
  "profit_gate": null,
  "mcp_commands": [],
  "action": "DEPLOY — USDCx to bitflow-xyk xyk-pool-stx-aeusdc-v-1-2 (STX/aeUSDC). 9.02% APR, $345k TVL, medium risk. | Higher yield available via Hermetica sUSDh vault (19.7% net APY after swap cost) — use hermetica-yield-rotator to execute.",
  "sources_used": ["bitflow-prices", "sbtc-reserve-signal", "bitflow-hodlmm", "bitflow-xyk", "hermetica"],
  "sources_failed": [],
  "timestamp": "2026-03-31T13:15:01.073Z"
}
```

**run --risk low** — conservative mode, stablecoin pairs only

```json
{
  "status": "ok",
  "decision": "DEPLOY",
  "direct_venues": [
    {
      "rank": 1,
      "protocol": "hodlmm",
      "pool_id": "dlmm_7",
      "pair": "aeUSDC/USDCx",
      "apr_pct": 0.02,
      "tvl_usd": 98425,
      "risk": "low",
      "risk_factors": []
    }
  ],
  "suggested_routes": [
    {
      "destination": "Hermetica sUSDh vault",
      "estimated_apy_pct": 20,
      "swap_path": "USDCx -> sBTC (Bitflow) -> stake USDh -> sUSDh",
      "swap_cost_pct": 0.3,
      "net_apy_pct": 19.7,
      "risk": "high",
      "note": "Requires sBTC exposure. Reserve signal YELLOW — elevated risk."
    }
  ],
  "risk_assessment": {
    "sbtc_reserve_signal": "YELLOW",
    "sbtc_price_deviation_pct": 0.51,
    "flagged_pools": []
  },
  "profit_gate": null,
  "mcp_commands": [],
  "action": "DEPLOY — USDCx to hodlmm dlmm_7 (aeUSDC/USDCx). 0.02% APR, $98k TVL, low risk. | Higher yield available via Hermetica sUSDh vault (19.7% net APY after swap cost) — use hermetica-yield-rotator to execute.",
  "sources_used": ["bitflow-prices", "sbtc-reserve-signal", "bitflow-hodlmm", "bitflow-xyk", "hermetica"],
  "sources_failed": [],
  "timestamp": "2026-03-31T13:15:03.003Z"
}
```

## Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array)
- `requires` empty quoted string
- `user-invocable` quoted string `"true"`
- `entry` path repo-root-relative: `usdcx-yield-optimizer/usdcx-yield-optimizer.ts` (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- **Write-ready with `--confirm` gate** — without flag, analysis only, no deployment specs generated
- **Deployment cap: 5,000 USDCx** per operation — enforced in code (`MAX_DEPLOY_USDCX = 5000`)
- **Profit gate enforced in code** — `PROFIT_GATE_MULTIPLIER = 3`, `MIN_APY_IMPROVEMENT_PCT = 1.0`, `MIN_TVL_USD = 50,000`, `MAX_SANE_APR = 500`, `SBTC_DEV_GREEN_PCT = 0.5`
- **Mainnet only** — all endpoints target Stacks and Bitcoin mainnet
- **No external oracles** — all prices from Bitflow pool data (zero CoinGecko, zero external dependencies)
- **Graceful degradation** — if any source unavailable, continues with available data, reports `sources_failed`, status becomes `"degraded"`
- Exit codes: `0` = ok, `1` = degraded, `3` = error

## Known constraints

- Hermetica APY is estimated from sUSDh exchange rate (20% historical). Estimate improves as rate baseline ages.
- sBTC reserve signal is a price-deviation proxy (not full on-chain audit). For high-value decisions, pair with `sbtc-proof-of-reserve`.
- HODLMM APR based on last 24h trading volume. Actual returns depend on active bin range.
- Write capability is spec-only until MCP adds `trait_reference` support. Exact fix path documented.
- sBTC-paired pools currently filtered at YELLOW signal (0.51% deviation) — conservative by design.
