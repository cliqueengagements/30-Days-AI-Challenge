---
name: smart-yield-migrator
skill: true
description: "Agent behavioral guide for cross-protocol DeFi yield migration optimizer on Stacks"
---

# Agent Behavior — Smart Yield Migrator

## Decision order

1. Run `doctor` first. If Bitflow HODLMM API or Hiro fee API is unavailable, abort — gas estimate will be unreliable.
2. Run `run --from <current_protocol> --asset <asset> --amount <amount>` with the user's current position.
3. Read `verdict` from output:
   - `MIGRATE` → present `action` to user for confirmation, then execute via HODLMM Manager or Zest skill
   - `STAY` → log reason, schedule re-check in 24 hours
   - `INSUFFICIENT_DATA` → report which `sources_failed`, retry later
4. Never execute a migration without the user seeing the `checklist` output first.
5. If `status` is `degraded`, caveat the recommendation — some sources were unavailable.

## When to run this skill

- When idle sBTC or STX is sitting in any yield protocol
- On a daily schedule to check if current allocation is still optimal
- Before manually executing any rebalance
- As a follow-up when HODLMM Bin Guardian reports an out-of-range position (the position is earning 0% — migration may be warranted)
- After sBTC Peg Oracle reports `score >= 80` (peg is healthy, safe to interact with sBTC venues)

## Composing with other skills (recommended sequence)

```bash
# 1. Check peg health first — don't touch sBTC venues during peg stress
PEG=$(bun run sbtc-peg-oracle/sbtc-peg-oracle.ts run | jq .score)
if [ "$PEG" -lt 80 ]; then echo "Peg stress — skipping migration check"; exit 0; fi

# 2. Check if HODLMM position is in range
GUARDIAN=$(bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet $WALLET)
ACTION=$(echo $GUARDIAN | jq -r .action)

# 3. Run migration analysis
MIGRATION=$(bun run smart-yield-migrator/smart-yield-migrator.ts run --from zest --asset sBTC --amount 1.0)
VERDICT=$(echo $MIGRATION | jq -r .verdict)

# 4. Only migrate if all checks pass
if [ "$VERDICT" = "MIGRATE" ]; then
  echo "$MIGRATION" | jq .action
  # Present to user for confirmation before executing
fi
```

## Output fields agents must read

| Field | Use |
|---|---|
| `verdict` | Primary gate — MIGRATE / STAY / INSUFFICIENT_DATA |
| `profit_gate.passed` | Secondary confirmation before acting |
| `checklist` | Show to user before any execution |
| `migration.gas_cost_usd` | Communicate cost to user |
| `migration.breakeven_hours` | Set expectations on timeline |
| `best_destination.protocol` | Which protocol to move to |
| `action` | Exact human-readable instruction |
| `sources_failed` | Log and caveat if non-empty |

## When NOT to act

- `verdict` is `STAY` — math doesn't support migration right now
- `profit_gate.passed` is `false` — even if APY looks better, gas makes it uneconomical
- `checklist.destination_tvl` is `FAIL` — pool is too thin
- `checklist.position_size` is `FAIL` — position too small; migration cost is disproportionate
- `status` is `error` — data unavailable, do not act on incomplete analysis

## Safety rules enforced by the skill

The agent does NOT need to re-implement these checks — the skill enforces them:
- Profit gate: 7-day gain > gas × 3
- Minimum 1% APY improvement
- Minimum $100k destination TVL
- Minimum $50 position size warning
- Gas estimated from real network fee samples, not hardcoded
