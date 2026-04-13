## Skill Name

hodlmm-emergency-exit

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [ ] Yield
- [x] Infrastructure
- [x] Signals

## What it does

Autonomous capital protection for HODLMM LP positions. Composes `sbtc-proof-of-reserve` (peg safety) and bin-range analysis into a single exit decision engine. When sBTC reserve is RED/DATA_UNAVAILABLE or bins drift out of range beyond the 2-hour grace period, outputs executable `bitflow_hodlmm_remove_liquidity` MCP withdrawal commands. The defensive counterpart to HODLMM yield strategies.

## On-chain proof

Write-capable skill — generates MCP withdrawal commands. Dry-run output below (no position found, so no withdrawal triggered). The `sbtc-proof-of-reserve` import returns live mainnet data (signer address verified, reserve ratio computed from on-chain BTC balance).

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Directly reads HODLMM pool bin state via `bff.bitflowapis.finance/api/app/v1/pools`, user position bins via `/api/app/v1/users/{addr}/positions/{pool}/bins`, and active bin via `/api/quotes/v1/bins/{poolId}`. Outputs `bitflow_hodlmm_remove_liquidity` MCP commands for emergency withdrawal.

## The Trilogy — Three Skills, One Pipeline

| Skill | Role | Status |
|-------|------|--------|
| `hodlmm-bin-guardian` | **Detect** — are bins in range? | Day 3 winner (bff-skills PR #39, merged; registry PR [aibtcdev/skills#265](https://github.com/aibtcdev/skills/pull/265)) |
| `sbtc-proof-of-reserve` | **Assess** — is sBTC fully backed? | PR #97 (Arc approved) |
| `hodlmm-emergency-exit` | **Act** — remove liquidity when unsafe | This PR |

No other competitor can compose merged skills into this pipeline.

## Defense-in-Depth Strategy

This skill completes the Micro Basilisk "Defense-in-Depth" strategy. It is the active response arm to the monitoring capabilities merged in bff-skills PR #39 / registry [aibtcdev/skills#265](https://github.com/aibtcdev/skills/pull/265) (hodlmm-bin-guardian, Day 3 winner) and PR #97 (sbtc-proof-of-reserve, Arc approved). Together, these three skills form a complete autonomous LP protection pipeline: **detect → assess → act**.

### Panic Mode Logging

When an EXIT decision is triggered, the skill outputs explicit, human-readable and machine-readable status codes:

```
[CRITICAL] HODLMM Exit Triggered: Reserve signal RED — sBTC peg unsafe (reserve_ratio: 0.993, score: 0)
[CRITICAL] HODLMM Exit Triggered: Bins out of range for 2.5h (>2h grace). Active bin: 518, your bins: [500, 504, 508]
```

The `action` field in the JSON output always starts with the decision level (`HOLD`, `WARN`, `EXIT`, `EXIT BLOCKED`, `ERROR`) for machine parsing.

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

**doctor**

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts doctor
```

```json
{
  "status": "ok",
  "checks": [
    { "name": "sBTC Proof-of-Reserve (runAudit)", "ok": true, "detail": "signal=GREEN, ratio=1, score=90" },
    { "name": "Bitflow HODLMM Pool API", "ok": true, "detail": "dlmm_1 active_bin=518, TVL=$190379, APR=0.0%" },
    { "name": "Hiro Stacks Fees API", "ok": true, "detail": "0.000200 STX estimated" },
    { "name": "State file", "ok": true, "detail": "exits=0, last=never" }
  ],
  "message": "All systems operational. Emergency exit pipeline ready."
}
```

**install-packs**

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts install-packs
```

```json
{"status":"ok","message":"No packs required. Depends on sbtc-proof-of-reserve (co-located)."}
```

**run**

```
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts run --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

```json
{
  "status": "success",
  "decision": "HOLD",
  "action": "HOLD — No HODLMM position found.",
  "data": {
    "reserve_audit": {
      "status": "ok",
      "score": 90,
      "risk_level": "low",
      "hodlmm_signal": "GREEN",
      "reserve_ratio": 1,
      "breakdown": {
        "price_deviation_pct": -0.76,
        "reserve_ratio": 1,
        "mempool_congestion": "low",
        "fee_sat_vb": 3,
        "stacks_block_height": 7410470,
        "btc_block_height": 942941,
        "sbtc_circulating": 4070.72074418,
        "btc_reserve": 4070.72079033,
        "signer_address": "bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x",
        "btc_price_usd": 67297,
        "sbtc_price_usd": 66784.06,
        "peg_source": "sbtc/pbtc-pool"
      },
      "recommendation": "Reserve health degraded — minor peg deviation 0.76%. Monitor closely.",
      "alert": false
    },
    "position_check": {
      "has_position": false,
      "in_range": null,
      "active_bin": 518,
      "user_bins": [],
      "user_bin_count": 0,
      "slippage_pct": 0,
      "slippage_ok": true
    },
    "exit_reason": null,
    "refusal_reasons": [],
    "mcp_commands": [],
    "cooldown_ok": true,
    "cooldown_remaining_min": 0,
    "gas_ok": true,
    "gas_estimated_stx": 0,
    "pool_id": "dlmm_1",
    "wallet": "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY",
    "confirm_required": false,
    "out_of_range_hours": null
  },
  "error": null
}
```

## Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array): `"defi, hodlmm, write, mainnet-only, safety, infrastructure"`
- `requires` quoted string: `"sbtc-proof-of-reserve"`
- `user-invocable` quoted `"true"`
- `entry` path is `hodlmm-emergency-exit/hodlmm-emergency-exit.ts` (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- **Write-capable** — generates `bitflow_hodlmm_remove_liquidity` MCP commands. Can only withdraw, never deposit or swap.
- **--confirm required** — without this flag, dry-run only (evaluates but outputs no executable commands).
- **30-minute cooldown** between exits prevents rapid-fire withdrawals from transient conditions.
- **50 STX gas cap** — refuses to execute if gas exceeds this limit.
- **Error = EXIT** — if reserve oracle or HODLMM API fails, defaults to EXIT. Never returns a false HOLD.
- State persisted in `~/.hodlmm-emergency-exit-state.json` — tracks exit history and out-of-range duration.

## Known constraints or edge cases

- Single pool per invocation — use `--pool-id` to specify. Defaults to `dlmm_1` (sBTC-USDCx).
- `in_range` returns `null` when no position found — distinguishes unchecked from out-of-range.
- Out-of-range grace period is 2 hours. Bins that drift back into range before 2h reset the timer.
- CoinGecko rate limit (via sbtc-proof-of-reserve import): handled with 1s retry on 429.
- MCP commands are output as JSON — the skill does NOT call Bitflow contracts directly. An orchestrator or human must execute the commands.
- Requires `sbtc-proof-of-reserve` co-located at `../sbtc-proof-of-reserve/` for the `runAudit()` import.

