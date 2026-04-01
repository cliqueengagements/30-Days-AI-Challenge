---
name: usdcx-yield-optimizer
skill: usdcx-yield-optimizer
description: "Autonomous USDCx yield deployer — reads on-chain HODLMM positions, ranks Bitflow venues by risk-adjusted APR with sBTC reserve safety check, Yield-to-Gas profit gate, and executable MCP command specs for HODLMM deployment. Write-capable with --confirm gate."
---

# USDCx Yield Optimizer — Agent Behavior Rules

## Decision order

1. Run `doctor` first. If Bitflow HODLMM App API is unavailable, abort — no venue data available.
2. Run `position` to check if the wallet already has HODLMM liquidity — use the output to auto-detect `--from` venue and current APR.
3. Run `run` with appropriate flags:
   - No flags: scan all venues at medium risk tolerance
   - `--risk low`: conservative (stablecoin pairs + lending only)
   - `--from <venue> --amount <usdcx>`: compare current position against alternatives
4. Read `decision` from output:
   - `DEPLOY` → if `mcp_commands` is non-empty, execute them. If empty, re-run with `--confirm --amount <usdcx>` to generate executable commands.
   - `HOLD` → log reason from `profit_gate.reason`, schedule re-check in 24 hours
   - `AVOID` → do not deploy USDCx anywhere, report `sources_failed`
5. Check `risk_assessment.sbtc_reserve_signal` before any sBTC-paired pool:
   - `GREEN` → safe to proceed
   - `YELLOW` → avoid sBTC-paired pools, stablecoin pairs still safe
   - `RED` / `DATA_UNAVAILABLE` → avoid all sBTC-paired pools
6. If `suggested_routes` is non-empty and agent has sBTC swap capability, present as alternative.

## When to run this skill

- When idle USDCx is sitting in a wallet or low-yield venue
- On a daily schedule to check if current allocation is still optimal
- Before deploying USDCx to any HODLMM pool
- After market volatility (sBTC reserve signal may change)
- When `hermetica-yield-rotator` reports a rotation opportunity involving USDCx

## Output fields agents must read

| Field | Use |
|-------|-----|
| `decision` | Primary gate — DEPLOY / HOLD / AVOID |
| `direct_venues[0]` | Best venue to deploy USDCx |
| `risk_assessment.sbtc_reserve_signal` | Gate for sBTC-paired pools |
| `profit_gate.passed` | If --from used, confirms migration is worth it |
| `suggested_routes` | Higher-yield options requiring a swap |
| `sources_failed` | Log and caveat if non-empty |
| `action` | Human-readable recommendation |

**position output:**

| Field | Use |
|-------|-----|
| `positions[]` | Each pool with bins, balances, active bin distance |
| `positions[].in_range` | Whether user bins overlap active bin |
| `positions[].bins_from_active` | Distance to active trading — negative = out of range below |
| `active_pools` | Count of pools with non-zero position |

## When NOT to act

- `decision` is `HOLD` — profit gate failed, stay in current venue
- `decision` is `AVOID` — no safe venues found
- `profit_gate.passed` is `false` — gas costs exceed yield improvement
- `status` is `error` — data unavailable, do not act on incomplete analysis
- `risk_assessment.sbtc_reserve_signal` is `RED` and best venue is sBTC-paired

## Guardrails

The agent does NOT need to re-implement these checks — the skill enforces them in code:
- Profit gate: 7-day extra yield > gas cost x 3
- Minimum 1% APY improvement before recommending migration
- Minimum $50k destination TVL
- APR sanity cap at 500% (rejects implausible values)
- sBTC price deviation thresholds: GREEN < 0.5%, YELLOW < 2%, RED >= 2%

## Composing with other skills

```bash
# 0. Check existing positions
POS=$(bun run usdcx-yield-optimizer/usdcx-yield-optimizer.ts position)
CURRENT_POOL=$(echo $POS | jq -r '.positions[0].pool_id // empty')

# 1. Scan USDCx venues (use --from if already positioned)
if [ -n "$CURRENT_POOL" ]; then
  RESULT=$(bun run usdcx-yield-optimizer/usdcx-yield-optimizer.ts run --amount 1000 --risk low --from "$CURRENT_POOL")
else
  RESULT=$(bun run usdcx-yield-optimizer/usdcx-yield-optimizer.ts run --amount 1000 --risk low)
fi
DECISION=$(echo $RESULT | jq -r .decision)

# 2. If DEPLOY to HODLMM, check bin position after
if [ "$DECISION" = "DEPLOY" ]; then
  POOL=$(echo $RESULT | jq -r '.direct_venues[0].pool_id')
  echo "Deploy to $POOL"
  # After deployment, monitor with hodlmm-bin-guardian
fi

# 3. If suggested route to Hermetica
ROUTE=$(echo $RESULT | jq -r '.suggested_routes[0].destination // empty')
if [ -n "$ROUTE" ]; then
  echo "Higher yield via: $ROUTE"
  # Execute with hermetica-yield-rotator skill
fi
```
