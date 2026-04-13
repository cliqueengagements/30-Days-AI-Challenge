# Day 3 — feat(hodlmm-bin-guardian): add HODLMM LP range monitor skill
> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/39 (merged)
> **Live upstream:** https://github.com/BitflowFinance/bff-skills/tree/main/skills/hodlmm-bin-guardian

## Skill Name

hodlmm-bin-guardian

## Category

- [ ] Trading
- [ ] Yield
- [ ] Infrastructure
- [x] Signals

## What it does

Read-only HODLMM LP range monitor for Bitflow DLMM pools. Fetches live pool bin state and the user's actual position bins via wallet address, compares against the active earning bin, and outputs a structured JSON recommendation (HOLD / REBALANCE / CHECK). Slippage, volume, TVL, APR, and token prices are sourced directly from Bitflow's HODLMM app API - no external oracles.

## On-chain proof

Read-only skill - no on-chain transactions submitted. Live mainnet output below.

## Does this integrate HODLMM?

- [x] Yes - eligible for the +$1,000 sBTC bonus pool

Directly reads HODLMM pool bin state via `bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}`, user position bins via `/api/app/v1/users/{addr}/positions/{pool}/bins`, and live pool stats (volume, TVL, APR, token prices) via `/api/app/v1/pools`.

## Registry compatibility checklist

  - [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
  - [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
  - [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays                                                                                                                                                                                       - [x] `user-invocable` is a quoted string (`"true"`)
  - [x] `entry` path is repo-root-relative (no `skills/` prefix)                                                                                                                                                                                                        - [x] `metadata.author` field is present with your GitHub username
  - [x] All commands output JSON to stdout
  - [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results

**doctor**

```
bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
```

```json
{
  "status": "ok",
  "checks": [
    { "name": "Bitflow HODLMM API",        "ok": true, "detail": "8 pools found, dlmm_1 active bin: 504" },
    { "name": "Bitflow Bins API (dlmm_1)", "ok": true, "detail": "active_bin_id=504, 1001 bins" },
    { "name": "Bitflow App Pools API",     "ok": true, "detail": "dlmm_1 TVL: $77,142.99, vol_24h: $126,045, APR: 17.72%" },
    { "name": "Hiro Stacks API (fees)",    "ok": true, "detail": "2 µSTX/byte" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

**install-packs**

```
bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts install-packs --pack all
```

```json
{
  "status": "ok",
  "message": "No packs required. hodlmm-bin-guardian uses Bitflow and Hiro public APIs only.",
  "data": { "requires": [] }
}
```

**run**

```
bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

```json
{
  "status": "success",
  "action": "HOLD — position out of range but rebalance blocked: price slippage 1.86% > 0.5% cap.",
  "data": {
    "in_range": false,
    "active_bin": 504,
    "user_bin_range": null,
    "can_rebalance": false,
    "refusal_reasons": ["price slippage 1.86% > 0.5% cap"],
    "slippage_ok": false,
    "slippage_pct": 1.8595,
    "bin_price_raw": 66459654464,
    "pool_price_usd": 66459.65,
    "market_price_usd": 65246.37,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0144,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": null,
    "volume_ok": true,
    "volume_24h_usd": 126045,
    "liquidity_usd": 77143,
    "apr_24h_pct": 17.72,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 30,
    "position_note": "No position found for SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY in pool dlmm_1."
  },
  "error": null
}
```

## Frontmatter validation

No `validate-frontmatter.ts` script present in upstream repo. Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array)
- `requires` empty quoted string
- `user-invocable` quoted `"true"`
- `entry` path is `hodlmm-bin-guardian/hodlmm-bin-guardian.ts` (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- Read-only - no transactions submitted, no funds moved.
- Mainnet-only. Bitflow HODLMM API does not support testnet.
- Cooldown state written to `~/.hodlmm-guardian-state.json` (local file only, no chain writes).
- Any rebalance action requires explicit human approval before execution.

## Known constraints or edge cases

- `in_range` returns `null` (not `false`) when no `--wallet` provided — distinguishes unchecked from out-of-range.
- Slippage check requires a USD-pegged `token_y`. Non-USD pairs skip the check and report `slippage_ok: true`.
- Defaults to `dlmm_1` (sBTC-USDCx). Other pool IDs accepted via `--pool-id`.

## PR Description

## Skill Name

hodlmm-bin-guardian

## Category

- [ ] Trading
- [ ] Yield
- [ ] Infrastructure
- [x] Signals

## What it does

Read-only HODLMM LP range monitor for Bitflow DLMM pools. Fetches live pool bin state and the user's actual position bins via wallet address, compares against the active earning bin, and outputs a structured JSON recommendation (HOLD / REBALANCE / CHECK). Slippage, volume, TVL, APR, and token prices are sourced directly from Bitflow's HODLMM app API - no external oracles.

## On-chain proof

Read-only skill - no on-chain transactions submitted. Live mainnet output below.

## Does this integrate HODLMM?

- [x] Yes - eligible for the +$1,000 sBTC bonus pool

Directly reads HODLMM pool bin state via `bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}`, user position bins via `/api/app/v1/users/{addr}/positions/{pool}/bins`, and live pool stats (volume, TVL, APR, token prices) via `/api/app/v1/pools`.

## Registry compatibility checklist                                                                                                                                                                                                                                 
                                                                                                                                                                                                                                                                      
  - [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
  - [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
  - [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays                                                                                                                                                                                       - [x] `user-invocable` is a quoted string (`"true"`)
  - [x] `entry` path is repo-root-relative (no `skills/` prefix)                                                                                                                                                                                                        - [x] `metadata.author` field is present with your GitHub username
  - [x] All commands output JSON to stdout                                                                                                                                                                                                                            
  - [x] Error output uses `{ "error": "descriptive message" }` format   

## Smoke test results

**doctor**

```
bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
```

```json
{
  "status": "ok",
  "checks": [
    { "name": "Bitflow HODLMM API",        "ok": true, "detail": "8 pools found, dlmm_1 active bin: 504" },
    { "name": "Bitflow Bins API (dlmm_1)", "ok": true, "detail": "active_bin_id=504, 1001 bins" },
    { "name": "Bitflow App Pools API",     "ok": true, "detail": "dlmm_1 TVL: $77,142.99, vol_24h: $126,045, APR: 17.72%" },
    { "name": "Hiro Stacks API (fees)",    "ok": true, "detail": "2 µSTX/byte" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

**install-packs**

```
bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts install-packs --pack all
```

```json
{
  "status": "ok",
  "message": "No packs required. hodlmm-bin-guardian uses Bitflow and Hiro public APIs only.",
  "data": { "requires": [] }
}
```

**run**

```
bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

```json
{
  "status": "success",
  "action": "HOLD — position out of range but rebalance blocked: price slippage 1.86% > 0.5% cap.",
  "data": {
    "in_range": false,
    "active_bin": 504,
    "user_bin_range": null,
    "can_rebalance": false,
    "refusal_reasons": ["price slippage 1.86% > 0.5% cap"],
    "slippage_ok": false,
    "slippage_pct": 1.8595,
    "bin_price_raw": 66459654464,
    "pool_price_usd": 66459.65,
    "market_price_usd": 65246.37,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0144,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": null,
    "volume_ok": true,
    "volume_24h_usd": 126045,
    "liquidity_usd": 77143,
    "apr_24h_pct": 17.72,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 30,
    "position_note": "No position found for SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY in pool dlmm_1."
  },
  "error": null
}
```

## Frontmatter validation

No `validate-frontmatter.ts` script present in upstream repo. Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array)
- `requires` empty quoted string
- `user-invocable` quoted `"true"`
- `entry` path is `hodlmm-bin-guardian/hodlmm-bin-guardian.ts` (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- Read-only - no transactions submitted, no funds moved.
- Mainnet-only. Bitflow HODLMM API does not support testnet.
- Cooldown state written to `~/.hodlmm-guardian-state.json` (local file only, no chain writes).
- Any rebalance action requires explicit human approval before execution.

## Known constraints or edge cases

- `in_range` returns `null` (not `false`) when no `--wallet` provided — distinguishes unchecked from out-of-range.
- Slippage check requires a USD-pegged `token_y`. Non-USD pairs skip the check and report `slippage_ok: true`.
- Defaults to `dlmm_1` (sBTC-USDCx). Other pool IDs accepted via `--pool-id`.


