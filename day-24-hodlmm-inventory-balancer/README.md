# Day 24 HODLMM Inventory Balancer

## Skill Name

HODLMM Inventory Balancer (target-ratio drift correction)

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [x] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

Restore a target X/Y token-exposure ratio on a HODLMM LP position. Detects **inventory drift** (composition imbalance from one-sided swap flow), not price drift, and fixes it.

Two execution modes:

1. **Default mode** — tempo corrector. Runs a wallet-side corrective swap via `swap-simple-multi`, then recenters bins around the new active bin via `hodlmm-move-liquidity`. Works when the position is already near-band and the corrective swap is material to LP size. Cycle 1 proof on dlmm_1: ratio 14.58% → 27.05% X (+12.47pp).

2. **`--allow-rebalance-withdraw` mode** — full 3-leg flow `withdraw-slice → swap → redeposit`. Fills the gap v1 cannot close: when the position is sprawled far from active, bin-to-bin recenter is value-conserving and can't convert LP composition. This mode withdraws a slice of the overweight bin, swaps it wallet-side, and redeposits the proceeds on the underweight side via `add-relative-liquidity-same-multi`. Live proof on dlmm_1: **0% X / 100% Y → 49.95% X / 50.05% Y** (deviation 0.05%, inside ±5% band).

**Commands:**
- `doctor` — check APIs, wallet, gas, cooldowns, state markers
- `status` — read-only ratio + deviation per pool (5 eligible DLMM pools)
- `recommend` — dry-run cycle plan (default or 3-leg with `--allow-rebalance-withdraw`)
- `run` — execute (requires `--confirm=BALANCE`)
- `install-packs` — no-op

## Why it matters

Inventory drift is different from price drift. A bin at price P can hold $1000 Y right after flow pushes price just below P, and $0 Y the next tick. Competing skills conflate these: they rebalance bin positions but leave the token-ratio broken.

This skill isolates composition. And when the default pipeline can't close the gap — because HODLMM bins are asset-isolated by design (below active = Y-only, above = X-only) — the opt-in 3-leg mode adds the missing primitive: actually shifting assets through the router.

## Key changes from initial submission (Day 24 review)

@diegomey + @arc0btc requested 5 items. All resolved:

| # | Item | Fix |
|---|------|-----|
| 1 | Smoke test landing within target ± --min-drift-pct | New `--allow-rebalance-withdraw` 3-leg mode; live proof 0% → 49.95% X |
| 2 | PostConditionMode | **CLOSED 2026-04-22** — shipped Allow + dual-pin envelope (sender `willSendLte(amount_in)` + pool `willSendGte(min_out)`). Verified bit-for-bit on mainnet proof tx [`0xf4f49328`](https://explorer.hiro.so/txid/0xf4f4932800a80234845a8d199556ad9c0ff4aa99874a95c819c13779b164cbc8?chain=mainnet) on dlmm_1. Framework now anchors aibtcdev/skills#339 Allow-flip decision per @macbotmini-eng concession. |
| 3 | Hardcoded V1_ELIGIBLE_POOLS | Dynamic predicate: `pool_status === true` + HODLMM deployer contract-prefix match |
| 4 | Stale `fee: 50000n` | `estimateSwapFeeUstx()` — Hiro `/v2/fees/transfer` × 500B budget, floor 250,000 uSTX |
| 5 | `--password` via argv | Removed the CLI flag entirely; `WALLET_PASSWORD` env var only (parent + child) |
| Nit | `CENTER_BIN_ID` / `PRICE_SCALE` | Inline comments on the constants |

## On-chain proof — 3-leg cycle on dlmm_1

Starting state: 10 bins (617–626), all 40+ below active, **100% USDCx, 0% sBTC** — the worst case for any bin-to-bin rebalancer.

| Leg | Function | Tx | Block | Result |
|-----|----------|-----|-------|--------|
| 1. Withdraw-slice | `withdraw-relative-liquidity-same-multi` | [`89315a8b...`](https://explorer.hiro.so/txid/0x89315a8b935b3e4db32ad753b77af4bf853f28dc5b04ca6aa25d7cca9fc1cf8a?chain=mainnet) | 7641869 | 5 bins, 8,848,721 USDCx to wallet |
| 2. Corrective swap | `swap-simple-multi` | [`5195822e...`](https://explorer.hiro.so/txid/0x5195822ee36c9658ed0e17659a4fd80218da9aeb703f03ee4ee758d5a7f0d3c8?chain=mainnet) | synced | 8,848,721 USDCx → 11,346 sats sBTC |
| 3. Redeposit | `add-relative-liquidity-same-multi` | [`135f490c...`](https://explorer.hiro.so/txid/0x135f490ca3f7b2862c3bd2eb33124bcd99e9ce2d93331865ad1dfd2065d6f53c?chain=mainnet) | 7641905 | 5,610,118 DLP shares at bin 662 (active+1) |

**Before → After:**
```
ratio_before: { current_x_ratio: 0.00,   current_y_ratio: 1.00,   deviation_abs: 0.5000 }
ratio_after:  { current_x_ratio: 0.4995, current_y_ratio: 0.5005, deviation_abs: 0.0005 }
```

## Safety

- **4-hour per-pool move-liquidity cooldown** (persisted to disk), shared with `hodlmm-move-liquidity`
- **1-hour meta-cooldown** on the balancer itself — prevents re-correcting inside the same swap-flow event
- **--confirm=BALANCE** required on every write (literal token, not any value)
- **Wallet-balance precondition** — refuses if overweight token isn't in wallet; 3-leg mode explicitly withdraws first
- **Thin-pool gate** — refuses if active bin's output-token reserve is less than 3× expected output
- **Quote staleness gate** — 45s default on Bitflow data freshness
- **Explicit slippage** — sender-pin `willSendLte` on swap input + contract `min-received` on output
- **3-leg guardrails** — gas reserve check for 3 txs (3× STX_GAS_FLOOR_USTX), per-bin slice cap 80% (`REBALANCE_MAX_SLICE_BPS`), list cap 300 (router), `noneCV()` active-bin-tolerance mid-cycle to avoid u5008 race
- **State markers** — `swap_done_redeploy_pending`, `withdraw_done_swap_pending`, `withdraw_done_swap_done_redeposit_pending` tagged with `last_cycle_mode` for recovery
- **Password** — `WALLET_PASSWORD` env var only. No `--password` flag (argv leaks to `/proc/<pid>/cmdline`)
- **`doctor` state-marker check** — flags ALL intermediate statuses so operators see partial cycles

## How the 3-leg mode plans

Given current vs target X ratio:
1. Compute shift in Y-value units: `|current_x - target_x| × total_value_y`
2. Greedy-fill from largest overweight bin first, per-bin slice cap (default 80% of user shares), until accumulated proceeds ≥ required shift
3. Route 100% of withdrawn overweight token through corrective swap
4. Deposit swap output at active ± REBALANCE_ADD_OFFSET_BINS (default 1), placing X above active / Y below active

Projected post-state is computed before execution and returned in the `recommend` dry-run.

## Composition with other skills

When composed under a meta-skill (e.g., a HODLMM Yield Router), only the last step in the chain should call `hodlmm-move-liquidity run --confirm`. The balancer exposes `--skip-redeploy` precisely so the meta-skill can run `harvest → balance (swap only) → single redeploy`.
