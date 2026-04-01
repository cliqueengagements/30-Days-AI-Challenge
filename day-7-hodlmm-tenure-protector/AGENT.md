---
name: hodlmm-tenure-protector
skill: hodlmm-tenure-protector
description: "Agent behavioral rules for the Nakamoto tenure-aware HODLMM risk monitor — protects concentrated liquidity from stale-tenure toxic flow."
---

# hodlmm-tenure-protector — Agent Behavior Rules

## Decision order

1. Run `doctor` to verify all 5 data sources are reachable. If any source fails, treat as degraded and note in output.
2. Run `run` to get current tenure risk assessment. Read the `decision` field first.
3. If `decision` is `SAFE` — no action required. Current bin spreads are appropriate.
4. If `decision` is `CAUTION` — log the warning. Do not modify positions yet. Re-check in 2 minutes.
5. If `decision` is `WIDEN` — recommend widening bin spreads on pools where `spread_action` is `WIDEN` or `WIDEN_URGENT`. Prioritize pools with highest `toxic_flow_exposure`.
6. If `decision` is `SHELTER` — recommend moving all liquidity to outer bins or pausing new deployments. This is the emergency state.
7. After a `WIDEN` or `SHELTER` event, re-run when `tenure.risk_level` returns to `GREEN` to confirm the danger has passed before tightening spreads again.

## When to run this skill

- Before deploying new HODLMM liquidity (always check tenure is GREEN first)
- Every 2–5 minutes during active HODLMM position management
- Before executing any rebalance operation (stale tenure = stale prices = bad rebalance)
- When composing with other HODLMM skills (run this first as a safety gate)
- After detecting unusual price movements — check if tenure drift is the cause

## Output fields agents must read

| Field | Use |
|-------|-----|
| `decision` | Primary gate: SAFE / CAUTION / WIDEN / SHELTER |
| `tenure.risk_level` | Granular risk: GREEN / YELLOW / RED / CRITICAL |
| `tenure.tenure_age_s` | Seconds since last Bitcoin block — raw metric |
| `pools[].spread_action` | Per-pool instruction: HOLD / WIDEN / WIDEN_URGENT / EXIT_RISK |
| `pools[].toxic_flow_exposure` | Per-pool arb risk: LOW / MODERATE / HIGH / CRITICAL |
| `pools[].recommended_spread_bps` | Target bin width in basis points |
| `pools[].position_overlap` | (--wallet only) Bin overlap with active range: NONE/PARTIAL/FULL |
| `pools[].bin_price_deviation` | Active bin price deviation % — measures actual L2/L1 lag |
| `timing.avg_gap_s` | Recent average BTC block interval — context for predictions |
| `status` | Data health: ok / degraded / error |
| `exit code` | 0=safe, 1=widen, 2=shelter, 3=error |

## When NOT to act

- Do NOT widen spreads on `YELLOW` alone — it is informational, not actionable
- Do NOT tighten spreads immediately after a new Bitcoin block — wait for 2 consecutive GREEN readings to confirm stability
- Do NOT ignore a `SHELTER` decision — even if the pool has low volume, critically stale tenures can produce rapid price corrections
- Do NOT execute rebalances during `RED` or `CRITICAL` tenure — the rebalance itself may execute at stale prices
- Do NOT treat this skill's output as a trading signal — it is a risk management layer, not a directional indicator

## Guardrails

- **Fail-safe default:** All data failures default to CRITICAL/SHELTER (maximum caution)
- **Pool TVL gate:** Pools below $10,000 TVL are excluded from analysis
- **APR sanity cap:** Pools reporting >500% APR are excluded as data anomalies
- **Read-only guarantee:** The skill never constructs, signs, or broadcasts transactions
- **Spread multipliers capped:** RED = 2x current bin step, CRITICAL = 3x (hardcoded, not configurable)
- **No external dependencies:** All data from public Hiro and Bitflow APIs — no API keys, no third-party services

## Polling cadence

| Scenario | Recommended interval |
|----------|---------------------|
| Idle monitoring | Every 5 minutes |
| Active position management | Every 2 minutes |
| Pre-deployment check | Once, immediately before |
| During YELLOW | Every 2 minutes until GREEN or RED |
| During RED/CRITICAL | Every 60 seconds until resolved |

## Composability

```bash
# Gate a rebalance behind tenure check
RESULT=$(bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts run --pool dlmm_1)
DECISION=$(echo "$RESULT" | jq -r '.decision')

if [ "$DECISION" = "SAFE" ]; then
  bun run skills/hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet "$WALLET"
else
  echo "Tenure risk: $DECISION — skipping rebalance"
fi
```

```bash
# Compose with emergency exit
RISK=$(bun run skills/hodlmm-tenure-protector/hodlmm-tenure-protector.ts run)
if echo "$RISK" | jq -e '.decision == "SHELTER"' > /dev/null; then
  bun run skills/hodlmm-emergency-exit/hodlmm-emergency-exit.ts run --wallet "$WALLET" --confirm
fi
```

## Signal-to-action mapping

| tenure.risk_level | Pool volume | toxic_flow_exposure | spread_action | Agent action |
|-------------------|-------------|---------------------|---------------|--------------|
| GREEN | Any | LOW | HOLD | No action |
| YELLOW | High | MODERATE | HOLD | Monitor, re-check in 2m |
| YELLOW | Low | LOW | HOLD | No action |
| RED | High | HIGH | WIDEN_URGENT | Widen bins immediately |
| RED | Medium | MODERATE | WIDEN | Widen bins as precaution |
| RED | Low | LOW | HOLD | Low arb incentive, hold |
| CRITICAL | High/Med | CRITICAL | EXIT_RISK | Move to outer bins or pause |
| CRITICAL | Low | HIGH | WIDEN | Defensive widen |
