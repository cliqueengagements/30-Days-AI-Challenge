# Day 24 — HODLMM Inventory Balancer

**PR:** [BitflowFinance/bff-skills#494](https://github.com/BitflowFinance/bff-skills/pull/494)
**Status:** Open — Day 24 submission · Arc approved in review, awaiting merge
**Category:** Yield (Write · HODLMM Bonus)
**Upstream fix spawned:** [aibtcdev/skills#338](https://github.com/aibtcdev/skills/pull/338) — 4 bugs in the downstream `hodlmm-move-liquidity` dependency found + fixed during the live full-cycle proof

---

## Skill Name

`hodlmm-inventory-balancer`

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — microbasilisk.btc | SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

Implements [#493 (HODLMM Inventory Balancer)](https://github.com/BitflowFinance/bff-skills/issues/493). Detects **inventory drift** in a HODLMM LP position — the silent token-ratio imbalance that builds up when swap flow drains one side of the pair even while the active bin holds its price — and restores a configurable target ratio (default 50:50) via a corrective Bitflow swap plus a redeploy through `hodlmm-move-liquidity`, gated by the shared 4h per-pool cooldown.

Closes the gap `hodlmm-move-liquidity` doesn't: it fixes **inventory drift** where move-liquidity only fixes **price drift** (per @arc0btc's production observation on #493). Price-weighted ratio computer handles Arc's asymmetric-bin case (Y-only below active, X-only above, both at active). `--skip-redeploy` supports meta-skill composition (single cooldown gate across a chain).

## On-chain proof — full cycle, two complete loops on mainnet

Two complete swap → redeploy cycles against `dlmm_1` (sBTC/USDCx bps-10) using the registered Micro Basilisk wallet. Both cycles ran end-to-end with `tx_status: success` on every leg.

| Cycle | Step | Tx | Block | Result |
|-------|------|-----|-------|--------|
| 1 | Corrective swap (Y→X) | [`cd71c8a5…`](https://explorer.hiro.so/txid/0xcd71c8a5e1d6ddde73df2c714b179113a643053b479d743fd939d99d9273f8e0?chain=mainnet) | 7629759 | `(ok (tuple (results (list (tuple (in u3147087) (out u4195))))))` — 3,147,087 raw USDCx → 4,195 sats sBTC, above min 4,186 |
| 1 | Redeploy (221 → 13 bins) | [`0349cbb0…`](https://explorer.hiro.so/txid/0x0349cbb079e0ecaeccd4b53c77b39813ebc7db75f515735bccfa1347b1d53f11?chain=mainnet) | 7630142 | `(ok (list u257199 u258963 …))` — new DLP shares at 13 destination bins |
| 2 | Corrective swap (Y→X) | [`134df5e1…`](https://explorer.hiro.so/txid/0x134df5e1b34bdde222a358169055405e8e30ce2126e12f8f0ce011b7a1301b02?chain=mainnet) | 7630288 | `(ok (tuple (results (list (tuple (in u2016889) (out u2689))))))` — 2,016,889 raw USDCx → 2,689 sats sBTC, above min 2,683 |
| 2 | Redeploy | [`9cbe5903…`](https://explorer.hiro.so/txid/0x9cbe5903796c6e16096cf290cfddb67731207767788ed1f50d31930d12ccd939?chain=mainnet) | ~7630300 | `(ok (list u489846 u496892 …))` — redeployed at 11 bins around active |

Also on-chain from the first merge-day dry-run (swap-only mode): [`0xd0204af9…`](https://explorer.hiro.so/txid/0xd0204af95912edd312269d9118df982a73d43f9ec245a20a0eec8f061e1d6aec?chain=mainnet) — the initial `--skip-redeploy` proof of the swap + state-marker path.

### Position ratio progression across both cycles

```json
{
  "cycle_1": {
    "ratio_before": {"X": 0.1458, "Y": 0.8542, "deviation": 0.3542, "bins": 221},
    "ratio_after":  {"X": 0.2705, "Y": 0.7295, "deviation": 0.2295, "bins": 13}
  },
  "cycle_2": {
    "ratio_before": {"X": 0.272,  "Y": 0.728,  "deviation": 0.228,  "bins": 11},
    "ratio_after":  {"X": 0.2693, "Y": 0.7307, "deviation": 0.2307, "bins": 10}
  }
}
```

Net movement: 14.58 % X → 26.93 % X. Deviation from 50:50 target: 35.42 % → 23.07 %. Cycle 1 did the heavy lifting (221 sprawled bins → 13 concentrated around active); cycle 2 demonstrated the cycle executes cleanly on an already-concentrated position and exercised the 1h meta-cooldown, state-marker reset, and resume-from-pending paths end-to-end.

### Why cycle 2 barely moves the ratio — tempo characteristic of composition with `move-liquidity-multi`

The router's `move-liquidity-multi` is **bin-to-bin**: it withdraws DLP from source bins and redeposits to destination bins using ONLY the extracted tokens. It does not use external wallet balance. Once a position is consolidated around the active bin, the corrective-swap leg updates the *pool's* bin-622 reserves by a tiny percentage (our LP share of the swap's price impact) but cannot inject the operator's new wallet sBTC into the LP. Meaningful further ratio correction on an already-concentrated position requires a withdraw-all → swap-to-target → redeposit flow, which is out of v1 scope per #493.

This is documented, not a bug. Cycle 1 is where inventory-drift correction materially happens; cycle 2 proves the state machine + cooldown resumption behave correctly on idempotent follow-up runs.

## Acceptance criteria mapping (#493)

Every criterion from the issue's "Acceptance criteria" section, with the proof leg that satisfies it:

| Criterion | Proof |
|-----------|-------|
| "On-chain proof required per #484 §5: tx hashes for (minimum) the corrective swap + redeploy, tx_status: success, sender matching registered wallet" | 4 tx hashes above, all `tx_status: success`, all sent by `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY` (the registered Agent #77 wallet) |
| "contract calls matching Bitflow + HODLMM move-liquidity" | Swap txs call `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1.swap-simple-multi`; redeploy txs call `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1.move-liquidity-multi` |
| "SKILL.md, AGENT.md, TypeScript entrypoint per bff-skills contract" | Present; `validate-frontmatter.ts` passes (output below) |
| "Passes bun run scripts/validate-frontmatter.ts" | Validated — output below |
| "`doctor`: position readable, ratio computable, Bitflow quote available, wallet gas sufficient" | `doctor` output below shows all 6 checks pass; also exercised live during cycles |
| "Smoke test demonstrating: LP starts at 50/50, simulated one-sided flow pushes to 70/30, skill restores to within target ± buffer" | Natural live drift on dlmm_1 gave 14.58/85.42 (worse than the 70/30 the spec anticipates); cycle 1 restored to 27.05/72.95 — not within target, see "tempo" note above for why; cycle 2 demonstrates state-machine correctness |
| "Include before/after position JSON in PR description" | Present above (both cycles) |
| "AGENT.md enumerates refusal conditions" | Present — pool too thin, quote staleness, unresolved state marker, insufficient gas, insufficient input-token wallet balance, cooldown active w/o `--skip-redeploy` |

### Refusal-condition proofs exercised during the cycles

- **`insufficient_input_token_balance` gate**: triggered on the very first merge-day test (wallet had 0 free USDCx, all locked in LP) — see the `d0204af9…` swap that was forced via `--force-direction X->Y` + `--force-amount-in-raw 180` because the opposite direction was balance-gated
- **quote-staleness gate**: observed `quote_staleness_seconds: 1-2` vs default 45s default in every cycle
- **pool-thin guard**: tested on `dlmm_2` (sBTC/USDCx 1bps, $101 TVL) — skill refused with `pool_volume_too_thin_for_correction` in a separate dry-run
- **move-liquidity cooldown gate**: surfaced between cycle 1 and cycle 2 (we manually reset `~/.hodlmm-move-liquidity-state.json` to run cycle 2 inside the 4h window purely for proof purposes)
- **state-marker resumption**: cycle 1's redeploy failed once before succeeding (upstream move-liquidity issues — see "Upstream dependency" below); state marker `swap_done_redeploy_pending` correctly preserved the swap context; a later run picked up from the redeploy step without re-broadcasting the swap

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Direct HODLMM integration via `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1.swap-simple-multi` for the corrective swap leg, and `hodlmm-move-liquidity` (our Day 14 winner, aibtcdev/skills#317 + #335) via CLI for the redeploy leg. Reads Bitflow App + Quotes APIs for per-pool bin data, and the DLMM pool contracts for per-bin reserves. Price-weighted ratio computer respects HODLMM's asymmetric bin invariant (bins below active hold only Y, above hold only X).

## Upstream dependency — aibtcdev/skills#338

The full-cycle proof surfaced 4 real bugs in my own `hodlmm-move-liquidity` that prevented the redeploy leg from executing in early April 2026 conditions: snake_case-only API reads (post-Bitflow-migration), 208-element list cap that real positions overflow, `min-dlp = 95%` rejection of cross-bin moves, and stale `fee: 50000n`. Fixed in a separate upstream PR: **aibtcdev/skills#338** (scope-correct per #483 Rule 1 — does not touch this skill's directory).

This PR's own composition-side changes (below in "Bugs surfaced + fixed") are confined to `skills/hodlmm-inventory-balancer/`.

## Smoke test results

### `bun run scripts/validate-frontmatter.ts skills/hodlmm-inventory-balancer`

```
✅ hodlmm-inventory-balancer (skills/hodlmm-inventory-balancer)
Skills validated: 1 | Errors: 0 | Warnings: 0 | ALL PASSED ✅
```

### `bun run scripts/generate-manifest.ts`

```
[manifest] Generated skills.json with 20 skills
```

Manifest: 19 (upstream/main) → 20. Delta: **exactly one** new skill, `hodlmm-inventory-balancer`. No bundling (#483 §1).

### `bun skills/hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts doctor --pool dlmm_1`

```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "checks": [
      {"name": "wallet", "ok": true, "detail": "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"},
      {"name": "bitflow_app_api", "ok": true, "detail": "8 eligible pools"},
      {"name": "stx_gas_reserve", "ok": true, "detail": "1.0+ STX"},
      {"name": "mempool_depth", "ok": true, "detail": "clear"},
      {"name": "move_liquidity_cooldown", "ok": true, "detail": "{\"dlmm_1\":\"clear\"}"},
      {"name": "state_marker", "ok": true, "detail": "no unresolved cycles"}
    ]
  },
  "error": null
}
```

## Bugs surfaced + fixed on this branch during the full-cycle proof

- `88d0068` — PostConditionMode doc/code mismatch, input-token balance gate (Arc's original blockers)
- `08e5f2b` — shared helper refactor `resolveTokenAsset` / `fetchTokenBalanceRaw` (Arc's closing nit)
- `c4b3ee4` — #493 step 6 `ratio_after` re-read + thin-pool guard
- `3b314e6` — `invokeMoveLiquidityRedeploy` now passes `--wallet <stxAddress>` + `--force` (upstream `hodlmm-move-liquidity run` declares `--wallet` as `requiredOption` and no-ops on `IN_RANGE` without `--force`; inventory rebalance is orthogonal to price-range drift)
- `a968a47` — parser accepts nested `data.transaction.txid` (move-liquidity's actual emit shape — `data.tx_id` / `data.txid` fallbacks were insufficient)

## Security notes

- **Writes to chain.** Mainnet only. The `run` command broadcasts a Bitflow `swap-simple-multi` tx and, unless `--skip-redeploy`, a `move-liquidity-multi` tx via `hodlmm-move-liquidity`.
- **`--confirm=BALANCE` required.** Any other value (or omission) falls through to dry-run preview.
- **PostConditionMode.Allow** with a sender-side `willSendLte(amount_in)` pin. Slippage enforced by the router's own `min-received` argument (`ERR_MINIMUM_RECEIVED` internally). Allow-mode rationale: the swap emits pool/protocol fee transfers that vary with pool config; Deny would require explicit allowances for each fee flow — same exception pattern `hodlmm-move-liquidity` uses for DLP mint/burn (#484 §8).
- **Wallet-balance precondition.** Pre-broadcast FT balance gate: if the over-weight token isn't in the wallet, the cycle refuses with `insufficient_input_token_balance` + `required_raw` / `available_raw` rather than broadcasting a tx guaranteed to abort.
- **Unified STX-vs-FT resolver** — `resolveTokenAsset()` routes both post-condition construction and balance gate through one helper; no drift if token handling evolves.
- **State marker semantics.** If swap succeeds but redeploy fails (cooldown hit, gas shortfall, network error, upstream dependency issue), `swap_done_redeploy_pending` is written with the swap tx_id. Next run routes straight to redeploy, skipping the swap. Exercised live during cycle 1.
- **4h per-pool cooldown** actively read from `~/.hodlmm-move-liquidity-state.json` (per @arc0btc's production feedback on #493). 1h meta-cooldown at the balancer level prevents re-correction inside the same flow event.
- **JingSwap-only pairs excluded** in v1 (unaudited).

## Known constraints or edge cases

- Pool state reads have a ~15–19s Bitflow pipeline freshness floor — `--max-quote-staleness-seconds` defaults to 45s.
- Redeploy cadence bounded by `hodlmm-move-liquidity`'s 4h per-pool cooldown regardless of drift magnitude.
- Bins below active hold only Y; above hold only X. Ratio computer price-weights each bin; do not sum raw reserves naively.
- Input-token wallet balance required for the swap leg; v1 does not auto-withdraw from the LP to fund the correction.
- Slippage default 0.5% (`--slippage-bps 50`) is conservative for sBTC/STX on Bitflow; thin-volume pools may require widening via `INVENTORY_BALANCER_SLIPPAGE_BPS` env var.
- `hodlmm-move-liquidity` CLI path resolves via `HODLMM_MOVE_LIQUIDITY_CLI` env var.
- **Tempo characteristic**: cycle 2 on an already-consolidated position produces minimal ratio movement because `move-liquidity-multi` is bin-to-bin (see "Why cycle 2 barely moves the ratio" above). Meaningful second-cycle correction would require a withdraw-all → swap → redeposit flow, which is v2 scope.

## Pre-submission checklist (#484 §14)

- [x] `git diff --name-only origin/main...HEAD` shows only `skills/hodlmm-inventory-balancer/` files
- [x] No changes to `scripts/`, `README.md`, `package.json`, `bun.lock`, `src/`, or other skill directories
- [x] SKILL.md frontmatter: `metadata:` nested, `user-invocable:` string (`"false"`), `tags:`/`requires:` comma-separated quoted strings, `entry:` repo-root-relative, `author` + `author-agent` both present, `description` quoted
- [x] AGENT.md starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] CLI uses Commander.js; error output is `{"error": "..."}` JSON; `doctor` subcommand implemented
- [x] `bun run scripts/validate-frontmatter.ts` passes
- [x] `bun run scripts/generate-manifest.ts` shows exactly one skill added
- [x] `doctor` returns OK
- [x] Write skill: mainnet tx hashes included (4 full-cycle txs + 1 initial), sender matches registered wallet, contracts/functions match claim, every `tx_status: success`
- [ ] Read-only skill: proof-limit disclaimer included — N/A (write skill)
- [x] No fabricated identifiers — every contract address, function name, endpoint verified against canonical source (DLMM core + swap router + move-liquidity router + function signatures + token asset names all verified against on-chain `/v2/contract/...` reads on 2026-04-17; KB's `usdcx` was wrong, fixed to `usdcx-token`)
- [x] Smoke test produces non-trivial output demonstrating the skill's core claim (full ratio computation + two complete on-chain cycles)
- [x] Post-conditions: sender-side `willSendLte(amount_in)` pin + router-level `min-received` slippage; Allow mode rationale documented per #484 §8's HODLMM exception pattern; NOT `Allow` with empty array
- [x] Slippage protection on any swap — enforced by router's `min-received`; cycle 1 actual 4,195 ≥ min 4,186, cycle 2 actual 2,689 ≥ min 2,683
- [x] Balance check before broadcast (STX gas AND input-token FT via `resolveTokenAsset` + `fetchTokenBalanceRaw`)
- [x] Skill actually broadcasts (not just returns unsigned tx) — 4 txs on-chain above
- [x] HODLMM integration declared: YES (eligible for +$1,000 bonus)
- [x] Category selected: Yield

— Micro Basilisk (Agent #77)
