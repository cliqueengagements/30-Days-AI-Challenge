# Day 6 — [AIBTC Skills Comp Day 6] USDCx Yield Optimizer
> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/118
> **Status:** Open

## Skill Name

> **The USDCx First Mover!** Pushed 2026-03-31 13:15 UTC

usdcx-yield-optimizer

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

**One question:** "I'm holding USDCx — where should it be earning yield right now, and is it safe?"

The first skill that treats USDCx as a primary yield asset. Scans every live USDCx venue on Bitflow (7 HODLMM pools + XYK), risk-tags each one, applies a Yield-to-Gas profit gate, and outputs executable MCP command specs to deploy USDCx to the highest-yielding HODLMM pool. Reads on-chain positions directly from HODLMM pool contracts. Suggests Hermetica sUSDh as a cross-protocol route when swap yields beat direct venues.

**Five problems, one skill:**

1. **Where is my USDCx now?** → `position` reads on-chain — which pool, which bins, in-range or not
2. **What are all my options?** → `run` scans 7 HODLMM pools + XYK + Hermetica in one call
3. **Which option is safest?** → Risk-tags each venue (stablecoin=low, STX=medium, sBTC=depends on reserve health)
4. **Is moving worth it?** → Profit gate: "will 7 days of extra yield cover 3x the gas to migrate?"
5. **How do I execute?** → Generates the exact contract call spec for the winning pool

Write-ready — generates complete `call_contract` deployment specs for `add-liquidity-multi` on the HODLMM liquidity router with `--confirm`. Currently spec-only because MCP `call_contract` doesn't support `trait_reference` args (documented honestly with exact fix path).

### On-chain position reader

The `position` command reads HODLMM liquidity positions directly from on-chain pool contracts via `call-read-only`. Scans 3 unique pool contracts (sBTC/USDCx, STX/USDCx, aeUSDC/USDCx), returning bin placements, balances, active bin distance, and in-range status. No signing required — pure read-only Clarity calls. Encodes principals as Clarity hex (type 05 + version + hash160).

## On-chain proof

**Deposit tx:** [`0xf2ffb41e...bab9e315`](https://explorer.hiro.so/txid/0xf2ffb41e1f29a5c5ee5fa0df628a700e21bf14a4aabbd334b5f49b98bab9e315?chain=mainnet) — add-relative-liquidity-same-multi on sBTC/USDCx HODLMM pool, block 7,423,687.

The `position` command detects this deposit on-chain via `call-read-only`:

```
Pool: dlmm_1 (sBTC/USDCx)
  Active bin: 11
  User bins: 221 (range 460-680)
  Overall balance: 99.66 LP units
  In range: False (449 bins from active)
  Sources: 3 pool contracts scanned, 0 failures
```

Live mainnet output below from 7 data sources (including on-chain HODLMM pool reads).

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Scans all 7 USDCx HODLMM concentrated liquidity pools via the Bitflow App API (`/api/app/v1/pools`), reads positions directly from on-chain pool contracts via `call-read-only`, extracts live APR/TVL/volume, classifies each by pair type (stablecoin vs volatile), and generates deployment specs targeting the HODLMM liquidity router (`dlmm-liquidity-router-v-1-2.add-liquidity-multi`).

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

**doctor** — 7/7 sources green (includes on-chain HODLMM reads)

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
      "name": "HODLMM On-Chain Reads",
      "ok": true,
      "detail": "STX/USDCx active bin -221, 3 pool contracts reachable"
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
      "detail": "BTC $67,056.319 STX $0.21739903 sBTC/BTC 1.0000"
    },
    {
      "name": "sBTC Price Signal",
      "ok": true,
      "detail": "signal=GREEN, deviation=0.00%"
    },
    {
      "name": "Bitflow HODLMM App API",
      "ok": true,
      "detail": "8 pools total, 7 with USDCx"
    }
  ],
  "message": "All sources reachable. USDCx venue scan ready."
}
```

**position** — on-chain HODLMM position detected (real deposit, 221 bins)

```json
{
  "status": "ok",
  "wallet": "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY",
  "positions": [
    {
      "pool_id": "dlmm_1",
      "pool_contract": "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10",
      "pair": "sBTC/USDCx",
      "active_bin_id": 11,
      "user_bins": [ {"bin_id": 460}, {"bin_id": 461}, {"bin_id": 462}, "...218 more...", {"bin_id": 678}, {"bin_id": 679}, {"bin_id": 680} ],
      "overall_balance": 99.661451,
      "in_range": false,
      "bins_from_active": 449
    }
  ],
  "total_pools": 3,
  "active_pools": 1,
  "sources_used": [
    "on-chain:dlmm-pool-sbtc-usdcx-v-1-bps-10",
    "on-chain:dlmm-pool-stx-usdcx-v-1-bps-10",
    "on-chain:dlmm-pool-aeusdc-usdcx-v-1-bps-1"
  ],
  "sources_failed": [],
  "timestamp": "2026-03-31T15:14:06.288Z"
}
```

**run** — DEPLOY decision, 4 venues ranked, sBTC/USDCx tops at 31.34% APR

```json
{
  "status": "ok",
  "decision": "DEPLOY",
  "direct_venues": [
    {
      "rank": 1,
      "protocol": "hodlmm",
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx",
      "apr_pct": 31.34,
      "tvl_usd": 179317,
      "risk": "medium",
      "risk_factors": ["sBTC exposure — check reserve signal"]
    },
    {
      "rank": 2,
      "protocol": "bitflow-xyk",
      "pool_id": "xyk-pool-stx-aeusdc-v-1-2",
      "pair": "STX/aeUSDC",
      "apr_pct": 9.46,
      "tvl_usd": 347170,
      "risk": "medium",
      "risk_factors": ["passive LP — lower capital efficiency than HODLMM"]
    },
    {
      "rank": 3,
      "protocol": "hodlmm",
      "pool_id": "dlmm_3",
      "pair": "STX/USDCx",
      "apr_pct": 3.62,
      "tvl_usd": 1032415,
      "risk": "medium",
      "risk_factors": ["STX volatility — impermanent loss risk"]
    },
    {
      "rank": 4,
      "protocol": "hodlmm",
      "pool_id": "dlmm_7",
      "pair": "aeUSDC/USDCx",
      "apr_pct": 0.02,
      "tvl_usd": 99357,
      "risk": "low",
      "risk_factors": []
    }
  ],
  "suggested_routes": [],
  "risk_assessment": {
    "sbtc_reserve_signal": "GREEN",
    "sbtc_price_deviation_pct": 0,
    "flagged_pools": []
  },
  "profit_gate": null,
  "mcp_commands": [],
  "action": "DEPLOY — USDCx to hodlmm dlmm_1 (sBTC/USDCx). 31.34% APR, $179k TVL, medium risk.",
  "sources_used": ["bitflow-prices", "sbtc-reserve-signal", "bitflow-hodlmm", "bitflow-xyk", "hermetica"],
  "sources_failed": [],
  "timestamp": "2026-03-31T15:14:00.800Z"
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
      "tvl_usd": 99357,
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
      "risk": "medium",
      "note": "Requires sBTC exposure. Use hermetica-yield-rotator skill to execute."
    }
  ],
  "risk_assessment": {
    "sbtc_reserve_signal": "GREEN",
    "sbtc_price_deviation_pct": 0,
    "flagged_pools": []
  },
  "profit_gate": null,
  "mcp_commands": [],
  "action": "DEPLOY — USDCx to hodlmm dlmm_7 (aeUSDC/USDCx). 0.02% APR, $99k TVL, low risk. | Higher yield available via Hermetica sUSDh vault (19.7% net APY after swap cost) — use hermetica-yield-rotator to execute.",
  "sources_used": ["bitflow-prices", "sbtc-reserve-signal", "bitflow-hodlmm", "bitflow-xyk", "hermetica"],
  "sources_failed": [],
  "timestamp": "2026-03-31T15:14:03.107Z"
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
- **On-chain reads via `call-read-only`** — position command requires no signing, no wallet unlock
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
- On-chain active bin IDs use Clarity signed int128 — decoded correctly via two's complement.
- Position reader skips per-bin balance fetches (avoids 221 API calls) — uses overall balance instead.
