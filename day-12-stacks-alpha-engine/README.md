# Day 12 — Stacks Alpha Engine

> **PR:** https://github.com/BitflowFinance/bff-skills/pull/213 (open — approved by arc0btc)
> **Supersedes:** PR #196 (zbg-alpha-engine, closed — Granite aeUSDC bug)

## Skill name

stacks-alpha-engine

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

**HODLMM integration?** Yes — all 8 pools scanned with YTG ratios

## What it does

Cross-protocol yield executor covering all 4 major Stacks DeFi protocols — Zest v2, Hermetica, Granite, and HODLMM. Scans 6 tokens (sBTC, STX, USDCx, USDh, sUSDh, aeUSDC), maps yield opportunities into 3 tiers with YTG (Yield-to-Gas) profitability ratios, verifies sBTC reserve via BIP-341 P2TR derivation, checks 6 market safety gates, then executes deploy/withdraw/rebalance/migrate/emergency operations.

Every write runs: **Scout -> Reserve -> Guardian -> YTG -> Executor**. No bypasses.

### Protocol coverage

| Protocol | Token(s) | Deposit | Withdraw | Method |
|----------|---------|---------|----------|--------|
| Zest v2 | sBTC | `zest_supply` | `zest_withdraw` | MCP native |
| Hermetica | USDh/sUSDh | `staking-v1.stake` | `staking-v1.unstake` + `silo.withdraw` | call_contract |
| Granite | aeUSDC | `lp-v1.deposit` | `lp-v1.redeem` (ERC-4626) | call_contract |
| HODLMM | per pool pair | `add-liquidity-simple` | `withdraw-liquidity-simple` | Bitflow skill |

### YTG (Yield-to-Gas) profit gate

Every yield option gets a YTG ratio: `7-day projected yield / gas cost`. Below 3x, the deploy is blocked — gas would eat more than a third of the first week's yield.

### 3-tier yield mapping

| Tier | Description | Example |
|------|-------------|---------|
| Deploy Now | Hold the token, one tx | sBTC -> Zest supply |
| Swap First | Bitflow swap, then deploy | sBTC -> USDh -> Hermetica stake |
| Acquire to Unlock | Don't have the token | Need aeUSDC for Granite LP |

## Why agents need it

No other skill covers all 4 Stacks DeFi protocols with working read and write paths. The YTG profit gate prevents agents from burning gas on unprofitable moves. The 3-tier mapping shows swap routes and acquisition paths, not just flat lists.

## On-chain proof

- **Zest sBTC supply**: [`b8ec03c3...`](https://explorer.hiro.so/txid/b8ec03c3ba85c40840cdc933b61a14faf2a9516e1ce1314d9768228f3328803f?chain=mainnet) — 14,336 zsBTC shares received
- **HODLMM add-liquidity**: [`f2ffb41e...`](https://explorer.hiro.so/txid/f2ffb41e1f29a5c5ee5fa0df628a700e21bf14a4aabbd334b5f49b98bab9e315?chain=mainnet) — dlmm-liquidity-router
- **Granite aeUSDC (failed)**: [`dd4061b3...`](https://explorer.hiro.so/txid/dd4061b3fe418a0dfda273fd5bccc07ebd905146966ce622d516f64c75272e50?chain=mainnet) — proves pool only accepts aeUSDC, not sBTC

## Safety notes

- **Safety pipeline enforced on every write**: Scout -> PoR -> Guardian -> YTG -> Executor
- **PoR RED/DATA_UNAVAILABLE blocks ALL writes** — suggests emergency withdrawal
- **PoR YELLOW blocks ALL writes** — read-only until reserve recovers
- **Emergency bypasses Guardian only** — never bypasses PoR
- **Post-conditions on all call_contract writes** — prevents unexpected token transfers
- **All write commands require `--confirm`** — dry-run preview without it
- **YTG gate** — blocks deploys where 7d yield < 3x gas cost
- **Granite routes aeUSDC** — the bug that killed PR #196 is fixed
- **Hermetica correct functions** — `unstake` + `silo.withdraw` (not wrong `initiate-unstake` from PR #56)
- **BIP-350 + P2TR self-tests** — crypto failure blocks ALL operations
- **4h rebalance cooldown**, slippage cap 0.5%, volume floor $10K, gas cap 50 STX
- **No private keys** — outputs instructions, MCP runtime executes

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `doctor` | read | 11 self-tests: crypto vectors, data sources, PoR, all protocol reads |
| `scan` | read | Full report: 6 tokens, 4 protocols, 3-tier yields with YTG, PoR, safety gates |
| `deploy` | write | Deploy capital to a protocol |
| `withdraw` | write | Pull capital from a protocol |
| `rebalance` | write | Re-center HODLMM bins on active bin |
| `migrate` | write | Cross-protocol capital movement |
| `emergency` | write | Withdraw ALL positions across all 4 protocols |
| `install-packs` | setup | Install tiny-secp256k1 for BIP-341 PoR |

## HODLMM integration

All 8 HODLMM pools scanned with YTG ratios per pool. Reads user positions via `get-user-bins`, `get-overall-balance`, `get-active-bin-id`. Calculates break prices via DLMM Core `get-bin-price`. Generates `add-liquidity-simple` and `withdraw-liquidity-simple` instructions.

## Data sources (12+ live reads)

| Source | Data |
|--------|------|
| Hiro Stacks API | STX + 5 FT balances, contract reads |
| Tenero API | sBTC/STX prices |
| Bitflow HODLMM API | Pool APR, TVL, volume |
| mempool.space | BTC balance at signer P2TR address |
| Zest v2 Vault | Supply position, utilization |
| Hermetica staking-v1 | Exchange rate, staking status |
| Granite state-v1 | LP params, user position |
| HODLMM Pool Contracts | User bins, balances, active bin (8 pools) |
| sbtc-registry/sbtc-token | Signer pubkey, sBTC supply |
| DLMM Core | Bin price calculations |

## Known constraints

1. **Granite borrower path blocked** — `add-collateral` needs `trait_reference`. Uses LP deposit (aeUSDC supply) instead.
2. **Hermetica minting blocked** — `request-mint` needs 4x `trait_reference`. Workaround: Bitflow swap sBTC -> USDh, then stake.
3. **Hermetica 7-day cooldown** — unstaking creates a claim in staking-silo-v1-1.
4. **Non-atomic multi-step** — swap-then-deploy = 2 txs. Capital safe in wallet if tx 2 fails.
5. **Signer rotation** — ratio < 50% flagged DATA_UNAVAILABLE (not false RED).
6. **YTG blocks small positions** — use `--force` to override.
