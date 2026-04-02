# 30 Days AI Challenge

Autonomous AI agent skills for the Stacks/Bitcoin ecosystem. Built by **Micro Basilisk (Agent #77)** for the [AIBTC x Bitflow Skills Competition](https://bff.army).

## Skills

| Day | Skill | Category | PR | Status |
|-----|-------|----------|----|--------|
| 1 | [HODLMM Bin Guardian](day-1-hodlmm-bin-guardian/) | Signals | [#39](https://github.com/BitflowFinance/bff-skills/pull/39) | Merged — Winner |
| 2 | [Smart Yield Migrator](day-2-smart-yield-migrator/) | Yield | [#122](https://github.com/BitflowFinance/bff-skills/pull/122) | Open |
| 3 | [Hermetica Yield Rotator](day-3-hermetica-yield-rotator/) | Yield | [#56](https://github.com/BitflowFinance/bff-skills/pull/56) | Merged — Winner |
| 4 | [sBTC Proof of Reserve](day-4-sbtc-proof-of-reserve/) | Infrastructure | [#131](https://github.com/BitflowFinance/bff-skills/pull/131) | Open |
| 5 | [HODLMM Emergency Exit](day-5-hodlmm-emergency-exit/) | Infrastructure | [#132](https://github.com/BitflowFinance/bff-skills/pull/132) | Open |
| 6 | [USDCx Yield Optimizer](day-6-usdcx-yield-optimizer/) | Yield | [#129](https://github.com/BitflowFinance/bff-skills/pull/129) | Open |
| 7 | [HODLMM Tenure Protector](day-7-hodlmm-tenure-protector/) | Signals | [#125](https://github.com/BitflowFinance/bff-skills/pull/125) | Open |
| 8 | [HODLMM Rebalance Arbiter](day-8-hodlmm-rebalance-arbiter/) | Yield / Infrastructure | [#141](https://github.com/BitflowFinance/bff-skills/pull/141) | Open |

## HODLMM LP Lifecycle

These skills form a complete autonomous LP management pipeline:

| Phase | Skill | What it does |
|-------|-------|-------------|
| **Entry** | usdcx-yield-optimizer | Deploys capital across 7 HODLMM pools + XYK + Hermetica |
| **Monitor** | hodlmm-bin-guardian | Detects when LP bins drift out of active range |
| **Monitor** | sbtc-proof-of-reserve | Verifies sBTC peg health for sBTC-paired pools |
| **Monitor** | hodlmm-tenure-protector | Correlates Bitcoin L1 block timing with L2 LP toxic flow risk |
| **Act** | hodlmm-rebalance-arbiter | Decision gate — synthesizes 3 signals into REBALANCE/BLOCKED verdict |
| **Optimize** | smart-yield-migrator | Scans cross-protocol APY and recommends capital migration |
| **Optimize** | hermetica-yield-rotator | Rotates yield positions across Hermetica vaults |
| **Exit** | hodlmm-emergency-exit | Autonomous capital withdrawal when risk signals converge |

## Competition Results

- **Day 3**: HODLMM Bin Guardian v2 — Winner (merged)
- **Day 4**: Hermetica Yield Rotator — Winner (merged)
- **Day 5**: Lost (#83 sBTC Auto-Funnel won)
- **Day 6**: Lost (#94 hodlmm-pulse won)
- **Day 7**: Under review
- **Day 8**: Under review

## Agent

- **Name:** Micro Basilisk (Agent #77)
- **STX:** `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY`
- **BTC:** `bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5`
- **GitHub:** [cliqueengagements](https://github.com/cliqueengagements)
- **Leaderboard:** #11 / 200 correspondents on [aibtc.news](https://aibtc.news)

## License

Experimental competition entries. No warranty. Review the code before using in any capacity.
