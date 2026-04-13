# Day 7 — HODLMM Tenure Protector (DEPRECATED)

> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/125 (closed)

## Skill name

hodlmm-tenure-protector

## Category

- [ ] Trading
- [ ] Yield
- [x] Infrastructure
- [x] Signals

## Deprecation notice

This skill's core premise was flawed. Bitcoin L1 has no price awareness, so tenure staleness is not a valid safety signal for LP rebalancing. Identified by @JakeBlockchain in PR #125 review. The useful parts (decision gate architecture) were absorbed into [day-8-hodlmm-rebalance-arbiter](../day-8-hodlmm-rebalance-arbiter/).

## What it does

Monitors Bitcoin block tenure age and correlates it with HODLMM concentrated liquidity risk. Under Nakamoto, Stacks produces fast blocks (~5s) within a tenure anchored to each Bitcoin block. Between Bitcoin blocks, L2 prices can drift from L1 reality, creating a window where arbitrageurs exploit stale-priced HODLMM bins.

Outputs a four-level risk signal: GREEN (safe), YELLOW (caution), RED (widen spreads), CRITICAL (shelter).

## Safety notes

- **Read-only** — never executes transactions
- **Fail-safe default** — unreachable data sources default to CRITICAL/SHELTER
- **No API keys required** — all public endpoints
- **Pool TVL gate** — ignores pools below $10K TVL
- **APR sanity check** — rejects pools with >500% APR

## HODLMM integration

Directly monitors all active HODLMM DLMM pools with per-pool risk assessments. Designed as a pre-check before any HODLMM operation.

## Data sources

| Source | Data |
|--------|------|
| Hiro Node Info | Tenure height, burn block height |
| Hiro Blocks/Burn Blocks | Block timestamps, inter-block gaps |
| Bitflow HODLMM | Pool TVL, APR, volume, bin step |
| Bitflow Bin Quotes | Active bin price, deviation |
| Bitflow User Positions | LP bin overlap analysis |
| Hiro Fees | Gas costs for rebalance awareness |

## Known constraints

- Core premise invalidated — L1 has no price awareness, tenure age is not a valid LP risk signal
- Bitcoin block times are inherently unpredictable (1-60+ min)
- Read-only — cannot execute bin adjustments
- Kept as historical record only

## PR Description

## Author & Agent

- **Author:** cliqueengagements
- **Agent:** Micro Basilisk (Agent 77) — `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY` | `bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5`

## Category

- [ ] Trading
- [ ] Yield
- [ ] Infrastructure
- [x] Signals

## What it does

Nakamoto tenure-aware risk monitor that protects HODLMM concentrated liquidity positions from toxic arbitrage flow during stale Bitcoin block tenures. Under Nakamoto, Stacks produces fast blocks (~5s) within a "tenure" anchored to each Bitcoin block. Between Bitcoin blocks, L2 prices can drift from L1 reality: informed arbitrageurs exploit this gap to trade against HODLMM bins at stale prices.

The protector reads real-time Bitcoin block timing from Hiro APIs, computes tenure freshness, and assesses every active HODLMM pool for toxic flow exposure based on tenure age, pool volume, and bin width. Output is a four-level risk signal: GREEN/SAFE, YELLOW/CAUTION, RED/WIDEN, CRITICAL/SHELTER.

**Position-level analysis**: with `--wallet`, fetches the LP's actual bin positions and checks overlap with the active trading range. An LP in outer bins has zero toxic flow exposure regardless of tenure age. Also validates bin price deviation to confirm or deny the toxic flow thesis with real data rather than inference.

**The only skill in the competition that correlates Bitcoin L1 block timing with Stacks L2 LP risk.**

## HODLMM Integration

- [x] **Direct HODLMM integration**: monitors all 4 active DLMM pools (dlmm_1 sBTC/USDCx, dlmm_3 STX/USDCx, dlmm_6 STX/sBTC, dlmm_7 aeUSDC/USDCx)
- Per-pool toxic flow exposure assessment based on tenure age × volume
- Position-level bin overlap analysis via `/app/v1/users/{addr}/positions/{pool}/bins`
- Bin price validation via `/quotes/v1/bins/{pool_id}` to measure actual L2/L1 deviation
- Spread recommendations: current bps vs recommended bps with specific multipliers (2x RED, 3x CRITICAL)
- Composable gate: other HODLMM skills should run `assessTenureRisk()` before executing

## Smoke test results

### `doctor` — 5/5 sources green
```json
{
  "status": "ok",
  "checks": {
    "hiro_node_info": "ok",
    "hiro_blocks": "ok",
    "hiro_burn_blocks": "ok",
    "bitflow_pools": "ok",
    "hiro_fees": "ok"
  },
  "message": "All 5 data sources reachable. Tenure protector ready."
}
```

### `run` — pool-level assessment (live)
```json
{
  "status": "ok",
  "decision": "SAFE",
  "action": "Tenure fresh (4m). All HODLMM positions safe at current spreads. No action required.",
  "tenure": {
    "burn_block_height": 943252,
    "tenure_age_s": 259,
    "risk_level": "GREEN",
    "risk_description": "Tenure fresh (4.3m). Bitcoin block recent — L2 prices aligned with L1."
  },
  "pools": [
    {
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx",
      "tvl_usd": 191057.51,
      "apr": 48.42,
      "volume_24h_usd": 352239.4,
      "spread_action": "HOLD",
      "toxic_flow_exposure": "LOW"
    }
  ],
  "sources_used": ["hiro-node-info", "hiro-blocks", "hiro-burn-blocks", "bitflow-hodlmm", "hiro-fees"],
  "sources_failed": []
}
```

### `run --wallet` — position-level assessment (live)
```json
{
  "status": "degraded",
  "decision": "SAFE",
  "pools": [
    {
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx",
      "toxic_flow_exposure": "LOW",
      "rationale": "Tenure fresh — normal spreads safe. [Position override: wallet bins are outside active trading range — zero toxic flow exposure.]",
      "position_overlap": {
        "total_bins": 221,
        "active_bins": 0,
        "bins_in_active_range": 0,
        "overlap_ratio": 0,
        "position_exposure": "NONE"
      }
    }
  ]
}
```

## Registry compatibility checklist

- [x] SKILL.md has nested `metadata:` block with quoted strings
- [x] AGENT.md has YAML frontmatter with `name`, `skill`, `description`
- [x] Entry path is repo-root-relative: `hodlmm-tenure-protector/hodlmm-tenure-protector.ts`
- [x] `user-invocable: "true"` (string, not boolean)
- [x] Tags: `"defi, read-only, mainnet-only, infrastructure"` (allowed values only)
- [x] `author: "cliqueengagements"` (quoted)
- [x] `author-agent` with em dash
- [x] Commander.js for argument parsing
- [x] `import.meta.main` guard
- [x] `## Guardrails` section in AGENT.md
- [x] Exports `assessTenureRisk()` for composability

## Security notes

- **Read-only**: never constructs, signs, or broadcasts transactions
- **Fail-safe**: all data failures default to CRITICAL/SHELTER (maximum caution)
- **Graceful degradation**: new endpoints (bin positions, bin quotes) fail silently and fall back to pool-level assessment
- **No API keys**: all sources are public Hiro and Bitflow endpoints
- **No secrets**: no passwords, mnemonics, or credentials in code
- **No filesystem writes**: pure computation, no state files
- **Pool gates**: TVL minimum ($10K), APR sanity cap (500%)

## Known constraints / edge cases

- Bitcoin block times are inherently unpredictable (1–60+ min). Skill provides probabilistic guidance, not guarantees.
- `dynamicFee` is currently 0 on all HODLMM pools. If Bitflow enables dynamic fees, spread recommendations should account for automatic fee widening.
- Bin position endpoints may return partial data for wallets with no active positions: handled via graceful degradation.
- Tenure age depends on system clock accuracy: NTP-synced hosts recommended.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

