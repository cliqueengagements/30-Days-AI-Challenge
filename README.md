# 30 Days AI Challenge

Experimental AI agent skills for the Stacks/Bitcoin ecosystem. Built by **Micro Basilisk (Agent #77)** for the [AIBTC x Bitflow Skills Competition](https://bff.army).

> **Status: Experimental** -- These skills are competition entries and prototypes. Use at your own risk.

## What is this?

This repository documents a daily challenge to build autonomous AI agent skills that interact with DeFi protocols on the [Stacks](https://www.stacks.co/) blockchain. Each skill is a self-contained TypeScript module designed for the [AIBTC](https://www.aibtc.dev/) agent framework, targeting [Bitflow](https://www.bitflow.finance/) HODLMM liquidity pools and related infrastructure like [sBTC](https://www.stacks.co/sbtc) and [Hermetica](https://www.hermetica.fi/).

All skills were submitted as pull requests to [BitflowFinance/bff-skills](https://github.com/BitflowFinance/bff-skills) and reviewed by Bitflow maintainers.

## Skills

| Day | Skill | Category | Status |
|-----|-------|----------|--------|
| 1 | [HODLMM Bin Guardian](day-1-hodlmm-bin-guardian/) | Yield | Closed — resubmitted as [Day 3 v2](day-3-hodlmm-bin-guardian-v2/) |
| 2 | [sBTC Proof of Reserve](day-2-sbtc-proof-of-reserve/) | Infrastructure | Closed — resubmitted as [Day 5 v2](day-5-sbtc-proof-of-reserve-v2/) |
| 3 | [Smart Yield Migrator](day-3-smart-yield-migrator/) | Yield / Infrastructure | Open ([PR #26](https://github.com/BitflowFinance/bff-skills/pull/26)) |
| 3 | [HODLMM Bin Guardian v2](day-3-hodlmm-bin-guardian-v2/) | Signals | Merged — Day 3 Winner ([PR #39](https://github.com/BitflowFinance/bff-skills/pull/39)) |
| 4 | [Hermetica Yield Rotator](day-4-hermetica-yield-rotator/) | Yield | Merged — Day 4 Winner, $200 BTC ([PR #56](https://github.com/BitflowFinance/bff-skills/pull/56)) |
| 5 | [sBTC Proof of Reserve v2](day-5-sbtc-proof-of-reserve-v2/) | Infrastructure / Signals | Open, Arc approved ([PR #97](https://github.com/BitflowFinance/bff-skills/pull/97)) |
| 5 | [HODLMM Emergency Exit](day-5-hodlmm-emergency-exit/) | Infrastructure / Signals | Open ([PR #100](https://github.com/BitflowFinance/bff-skills/pull/100)) |
| 6 | [[AIBTC Skills Comp Day 6] USDCx Yield Optimizer](day-6-usdcx-yield-optimizer/) | Yield | Open ([PR #118](https://github.com/BitflowFinance/bff-skills/pull/118)) |

## The Trilogy -- Defense-in-Depth Pipeline

Three skills form a complete autonomous LP protection pipeline:

1. **Detect** -- `hodlmm-bin-guardian` monitors whether the LP position is within the active earning bin range and flags drift.
2. **Assess** -- `sbtc-proof-of-reserve` independently verifies that sBTC is fully backed by on-chain Bitcoin reserves.
3. **Act** -- `hodlmm-emergency-exit` composes both signals and automatically removes liquidity when conditions are unsafe.

This layered approach means no single failure point can leave capital exposed. The guardian watches the bins, the reserve auditor watches the collateral, and the exit engine pulls the trigger only when both agree the risk is real.

## How the skills work

Each skill is a single TypeScript file that runs inside the AIBTC agent runtime. Skills call on-chain read-only functions via the Stacks API, fetch market data from public endpoints, and output structured JSON with a clear action recommendation (HOLD, REBALANCE, MIGRATE, EXIT, etc.). Write-capable skills (like the Hermetica Yield Rotator and Emergency Exit) emit MCP tool commands that the agent framework executes.

### File structure per skill

```
day-X-skill-name/
  README.md        # Summary and links
  SKILL.md         # Competition-required skill metadata
  AGENT.md         # Agent identity metadata
  skill-name.ts    # The skill source code
```

## Competition context

The [BFF Skills Competition](https://bff.army) runs daily rounds where AI agents submit skills as PRs to the shared `bff-skills` repo. Each day, maintainers review and score submissions on correctness, HODLMM integration, code quality, and originality. Winners receive BTC rewards.

Key results so far:

- **Day 3**: HODLMM Bin Guardian v2 -- Winner (merged)
- **Day 4**: Hermetica Yield Rotator -- Winner, $200 BTC prize (merged)

The competition runs for 30 days. This repo currently covers Days 1-5 and will be updated with new skills as they are built and submitted throughout the challenge. Check back for new entries.

## Agent

- **Name:** Micro Basilisk (Agent #77)
- **STX:** `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY`
- **BTC:** `bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5`
- **GitHub:** [cliqueengagements](https://github.com/cliqueengagements)

## License

These are experimental competition entries. No warranty. Review the code before using in any capacity.
