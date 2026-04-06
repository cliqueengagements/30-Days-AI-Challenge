# Day 4 — [AIBTC Skills Comp Day 4] Hermetica Yield Rotator
> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/56 (merged)
> **Live upstream:** https://github.com/BitflowFinance/bff-skills/tree/main/skills/hermetica-yield-rotator

## Skill name

hermetica-yield-rotator

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

**HODLMM integration?** Yes — eligible for the +$1,000 sBTC bonus pool

## What it does
Cross-protocol yield rotator for Stacks mainnet. Monitors Hermetica USDh staking APY against Bitflow HODLMM dlmm_1 APR from live on-chain data — querying five Hermetica contracts and the Bitflow App API — and executes capital rotation to the higher-yielding protocol when the differential exceeds a 2% threshold.

Features write-capable MCP command outputs for stake, unstake, withdraw-claim, and rotate actions with guardrails including --confirm gates, 500 USDh spend cap, STX gas verification, and preflight checks.

**Rotation pipeline:** When rotating to HODLMM, the skill first swaps USDh → USDCx via `bitflow_swap` (dlmm_1 accepts USDCx, not USDh), then deposits USDCx into the HODLMM pool via `bitflow_hodlmm_add_liquidity`.

## On-chain proof
Skill outputs MCP commands via `npx @aibtc/mcp-server@latest` without direct transaction broadcasting. All five Hermetica mainnet contracts confirmed reachable. Includes balance guards, confirms requirements, and enforces spend limit with documented error responses.

## Does this integrate HODLMM?
Yes — eligible for +$1,000 sBTC bonus pool. Fetches live dlmm_1 APR and active bin per run, outputs `bitflow_swap` (USDh → USDCx), `bitflow_hodlmm_add_liquidity`, and `bitflow_hodlmm_remove_liquidity` MCP commands as part of the rotation pipeline. The swap step ensures correct token denomination for dlmm_1.


**Balance guard (live mainnet):**
```json
{
  "status": "error",
  "action": "Blocked: Amount 500.00 USDh exceeds wallet balance 0.00",
  "error": { "code": "INSUFFICIENT_BALANCE", "message": "Amount 500.00 USDh exceeds wallet balance 0.00", "next": "Reduce --amount or acquire more USDh." }
}
```

**Confirm guard (live mainnet):**
```json
{
  "status": "error",
  "action": "Blocked: --confirm required for action 'rotate'",
  "error": { "code": "CONFIRM_REQUIRED", "message": "--confirm required for action 'rotate'", "next": "Re-run with --confirm to execute." }
}
```
### Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is the string `"true"`, not a boolean
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results
Doctor checks confirm all data sources reachable; install-packs shows no external dependencies; run demonstrates protocol health checks and yield comparison capabilities

<details>
<summary>doctor output</summary>

```json
{
  "status": "ok",
  "checks": [
    { "name": "Hermetica staking-v1", "ok": true, "detail": "exchange rate: 1.00000000 USDh/sUSDh" },
    { "name": "Hermetica staking-state-v1", "ok": true, "detail": "staking enabled: true, cooldown: 7.0 days" },
    { "name": "Hermetica token contracts (USDh + sUSDh)", "ok": true, "detail": "USDh supply: $9,059,673.16, sUSDh: 1,829,438.07" },
    { "name": "Bitflow HODLMM App API (dlmm_1)", "ok": true, "detail": "APR: 31.77%, TVL: $43,969" },
    { "name": "Bitflow HODLMM Bins API (dlmm_1)", "ok": true, "detail": "active bin: 506" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

</details>

<details>
<summary>run output</summary>

```json
{
  "status": "success",
  "action": "CHECK — staking enabled, protocol healthy. Provide --wallet to check position.",
  "data": {
    "staking_enabled": true,
    "exchange_rate": 1,
    "accumulated_yield_pct": 0,
    "estimated_apy_pct": null,
    "cooldown_days": 7,
    "usdh_total_supply": 9059673.16,
    "susdh_total_supply": 1829438.07,
    "hodlmm_apr_pct": 31.77,
    "hodlmm_tvl_usd": 43969.25,
    "hodlmm_active_bin": 506,
    "yield_comparison": "HODLMM dlmm_1 APR: 31.77% | USDh staking APY: tracking started — check again in ≥1h",
    "user_usdh": 0,
    "user_susdh": 0,
    "user_susdh_value_usdh": 0,
    "hodlmm_position_bins": null,
    "rotation_cooldown_ok": true,
    "rotate_threshold_pct": 2,
    "refusal_reasons": null,
    "silo_epoch_ts": 1774747320
  },
  "error": null
}
```

</details>

### Reviewer fixes applied

All three issues raised by @arc0btc have been implemented and verified:

1. **`decodeBool` wrapper stripping** — added `0x07` (response-ok) / `0x08` (response-err) prefix handling, matching `decodeUint128` behavior. Previously would throw on `(ok true)` responses.
2. **Rotation cooldown no-op guard** — `last_rotation_at` now only updates when commands are actually generated (`cmds.length > 0`), preserving the 30-min window on no-op rotations.
3. **USDh→USDCx token mismatch** — added `TOKEN_USDCX` constant, `swapUsdhToUsdcxCmd()` builder, and swap step before `addLiquidityCmd` in the HODLMM path. dlmm_1 accepts USDCx, not USDh — without this, MCP commands would fail on-chain.

Documentation fixes per @TheBigMacBTC:
- Renamed "Safety model" → "Safety notes" in SKILL.md
- Added "Output Contract" section to SKILL.md
- Renamed AGENT.md headings to "Decision order" and "Guardrails"

### Security notes

- **Hardcoded 500 USDh autonomous spend cap** enforced in code at `MAX_AUTONOMOUS_STAKE_USDH = 500`
- **Doctor-first preflight** — write actions abort with `PREFLIGHT_FAILED` if Hermetica contracts unreachable
- **All write actions require `--confirm`** — stake, unstake, withdraw-claim, rotate
- **STX gas check** — refused if wallet STX < 10,000 µSTX
- **Post-conditions** — sUSDh credit FT `gte` post-condition with 1% slippage; tx reverts on-chain if short
- **2% rotation threshold** + **30-min cooldown** prevent churn
- **USDh→USDCx swap** before HODLMM deposit (dlmm_1 accepts USDCx, not USDh)
- Mainnet-only. State in `~/.hermetica-yield-rotator-state.json` — no keys, no sensitive data

## Frontmatter validation

```
bun run scripts/validate-frontmatter.ts skills/hermetica-yield-rotator
```

```
✅ hermetica-yield-rotator (skills/hermetica-yield-rotator)

────────────────────────────────────────────────────────────
Skills validated: 1 | Errors: 0 | Warnings: 0 | ALL PASSED ✅
```

### Bug fix: wrong unstake function names (2026-04-06)

The original merged PR #56 used `initiate-unstake` and `complete-unstake` as on-chain function names — **these functions do not exist** on the Hermetica staking-v1 contract. The actual on-chain interface is:

| Action | Wrong (PR #56) | Correct (fixed) |
|--------|---------------|-----------------|
| Unstake sUSDh | `staking-v1.initiate-unstake(uint)` | `staking-v1.unstake(uint)` |
| Withdraw USDh | `staking-v1.complete-unstake()` | `staking-silo-v1-1.withdraw(claim-id)` |

The fix changes:
- `initiateUnstakeCmd` → `unstakeCmd` — calls `staking-v1.unstake(uint)`, which burns sUSDh and creates a claim in `staking-silo-v1-1`
- `completeUnstakeCmd` → `withdrawClaimCmd` — calls `staking-silo-v1-1.withdraw(claim-id)` (different contract), which returns USDh after the 7-day cooldown
- CLI actions renamed: `initiate-unstake` → `unstake`, `complete-unstake` → `withdraw-claim`
- All state tracking, rotate handler references, and docs updated

Bug flagged as comment on [aibtcdev/skills#273](https://github.com/aibtcdev/skills/pull/273) by @microbasilisk.

## Known constraints
- Estimated APY returns null for ~1 hour post-first-run (needs exchange rate history)
- Cooldown blocking enforced from state file
- HODLMM position fetch returns null when no active bins exist

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Hermetica staking-v1 | Exchange rate | `SPN5AK…HSG.staking-v1::get-usdh-per-susdh` |
| Hermetica staking-state-v1 | Staking enabled, cooldown | `::get-staking-enabled`, `::get-cooldown-window` |
| Hermetica staking-silo-v1-1 | Epoch timestamp | `::get-current-ts` |
| Hermetica usdh-token-v1 / susdh-token-v1 | Token supplies | `::get-total-supply` |
| Hiro Address API | User FT balances | `api.mainnet.hiro.so/extended/v1/address/{addr}/balances` |
| Bitflow HODLMM App API | dlmm_1 APR, TVL, user position bins | `bff.bitflowapis.finance/api/app/v1/pools`, `/users/{addr}/positions/{pool}/bins` |
| Bitflow HODLMM Quotes API | Active bin ID | `bff.bitflowapis.finance/api/quotes/v1/bins/{pool}` |
