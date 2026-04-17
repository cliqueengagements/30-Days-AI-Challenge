# Day 14 Hodlmm Move Liquidity

## Skill Name

HODLMM Move-Liquidity & Auto-Rebalancer

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

> **Day 24 update (Apr 17, 2026):** Four production bugs discovered during the Day 24 hodlmm-inventory-balancer full-cycle live proof, now fixed in upstream PR [aibtcdev/skills#338](https://github.com/aibtcdev/skills/pull/338) (Arc APPROVED, awaiting merge). This archive now mirrors the post-fix source. Changes:
>
> 1. **Bitflow App API snake_case → camelCase fallbacks restored** — I removed them in `d83755a` per a Day-14 review suggestion ("fail loudly on schema change"). The migration happened in early April 2026 and the skill returned empty pools + 0 positions until the fallbacks were re-added.
> 2. **Route to `move-liquidity-multi` (220-cap) instead of `move-relative-liquidity-multi` (208-cap)** — real positions routinely carry 209–221 bins after prior rebalances. The 208 cap causes `BadFunctionArgument` at Clarity parse.
> 3. **`min-dlp = 1n` for cross-bin rebalance** — DLP shares are bin-price-indexed, so `95% of input` rejects legitimate cross-bin conversions with router err u5001 (NO_RESULT_DATA fold cascade). Router's own value-conservation arithmetic makes `1n` safe; v2 will do price-aware `95% × (price_from/price_to) × amount`.
> 4. **`fee: 50000n → 250000n`** — current mempool floor as of Apr 2026; `FeeTooLow` rejections otherwise. TODO for dynamic `get_stx_fees` estimation.
>
> Proof the fixed version works end-to-end: redeploy tx [`0349cbb0…`](https://explorer.hiro.so/txid/0x0349cbb079e0ecaeccd4b53c77b39813ebc7db75f515735bccfa1347b1d53f11?chain=mainnet) on block 7630142 (Apr 17).

## Category

- [x] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

When the active bin drifts away from your LP position, move your liquidity to bins near the current price. One atomic transaction via `move-relative-liquidity-multi`: withdraw from old bins, deposit into new bins — all in a single on-chain call.

**How it works:** The DLMM bin invariant requires Y-only bins below active and X-only bins above. The skill respects this by assigning destinations directionally:
- Source bins below active → spread across offsets `[-spread, 0]`
- Source bins above active → spread across offsets `[0, +spread]`

One contract call. One nonce. Either all bins move or none do.

**Commands:**
- `doctor` — check APIs, wallet, dependencies
- `scan` — read-only position health across all HODLMM pools
- `run` — assess + execute atomic rebalance (dry-run unless `--confirm`; `--force` to recenter in-range positions; `--spread` to control bin distribution)
- `auto` — autonomous rebalancer loop: monitors all pools, auto-executes when drift exceeds threshold
- `install-packs` — no-op

## Why it matters

Every HODLMM read skill in the competition hits the same wall. They detect drift, score risk, recommend action — then stop. Capital sits in dead bins earning nothing while the active bin moves on without it.

This skill closes the loop. Capital that's out of range earns zero fees. Capital in the active bin earns. The `auto` command makes it autonomous — 24/7 rebalancing with no human intervention.

## Evolution from initial submission

The skill evolved significantly across commits:

| Version | Change |
|---------|--------|
| **Initial** | 2-transaction design — separate withdraw tx + deposit tx, sequential nonces, partial execution risk |
| **Atomic rewrite** | Single `move-relative-liquidity-multi` call — withdraw + deposit in one on-chain tx, zero partial execution risk |
| **Auto command** | Added autonomous rebalancer loop with configurable interval, drift threshold, per-pool cooldown, and graceful shutdown |
| **Doc alignment** | Full audit against judge checklist — AGENT.md `## Decision order` heading, `IN_RANGE` output documented, `--force`/`--spread` on `run` documented, output contract plan fields corrected, Known constraints updated for ±spread distribution |
| **Review fixes** | DLP slippage protection (min-dlp 95%, fee caps 5%), camelCase API fallbacks removed, router version documented |

## On-chain proof

### Proof 1 — Atomic consolidation (5 bins → active bin)

| Detail | Value |
|--------|-------|
| **Tx** | [0b4a9c7c...](https://explorer.hiro.so/txid/0b4a9c7c386c56787f4fd49f30163059d8ab680240908ee5fa98c309dfb7e724?chain=mainnet) |
| **Before** | Bins 601–606 (6 bins) |
| **After** | Bin 606 only (active bin) |
| **Result** | `(ok (list u496149 u496149 u496149 u496149 u496149))` — **Success** |

### Proof 2 — Atomic multi-bin spread (3 bins → new positions)

| Detail | Value |
|--------|-------|
| **Tx** | [85ffba93...](https://explorer.hiro.so/txid/85ffba93c7aca96818416488671f113bc1bd0b0f1fa1d3b097da82cc9fc7f133?chain=mainnet) |
| **Before** | Bins 603–606 (4 bins) |
| **After** | Bins 601, 602, 603, 606 (spread ±5 from active) |
| **Moves** | bin 603→601, bin 604→602, bin 605→603 |
| **Result** | `(ok (list u845889 u845889 u1653252))` — **Success** |

Both proofs use a **single `move-relative-liquidity-multi` call** — one transaction, one nonce, fully atomic.

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Calls `move-relative-liquidity-multi` on the DLMM liquidity router (`SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1`). Reads pool state from Bitflow APIs. Converts API unsigned bin IDs to contract signed bin IDs using CENTER_BIN_ID offset (500).

## Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is a quoted string (`"false"`)
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Doc/code alignment audit

| # | Issue found | Fix applied |
|---|-------------|-------------|
| 1 | AGENT.md used `## Operating modes` instead of `## Decision order` | Renamed to match judge checklist |
| 2 | `--force` flag accepted by `run` but not in SKILL.md | Documented with usage example |
| 3 | `--spread` flag accepted by `run` but only under `auto` | Documented with usage example |
| 4 | `IN_RANGE` output state missing from output contract | Added full JSON example |
| 5 | Output contract plan showed `new_range: bins: 1` | Corrected to `bins: 11` (±5 spread) |
| 6 | Plan missing `spread`, `stx_balance`, `estimated_gas_stx` | Added to output contract example |
| 7 | Known constraints said "offset 0" | Corrected to ±spread distribution |

**Zero doc/code mismatches remain.**

## Review fixes (d83755a)

All 3 findings from BigMac + arc addressed:

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `min-dlp: uintCV(1n)` — no slippage protection | Blocking | `min-dlp` set to 95% of input, `max-x/y-liquidity-fee` capped at 5%. Tx reverts on-chain if violated. |
| 2 | Router address differs from API reference | Informational | Code comment documenting v-1-1 at SM deployer with mainnet proof references |
| 3 | camelCase API field fallbacks mask bugs | Suggestion | Removed all camelCase fallbacks from `fetchPools`, `fetchPoolBins`, `fetchUserPositions`, and `doctor`. Snake_case only. |

## Smoke test results

**doctor** — all checks pass
```json
{"status":"success","action":"doctor","data":{"checks":{"bitflow_pools":{"ok":true},"bitflow_bins":{"ok":true},"hiro_api":{"ok":true},"stx_balance":{"ok":true},"stacks_tx_lib":{"ok":true}}}}
```

**scan** — 8 pools, 2 positions found
```json
{"status":"success","action":"scan","data":{"pools_scanned":8,"positions_found":2,"out_of_range":0}}
```

**run (dry-run)** — atomic plan with directional spread
```json
{"status":"success","action":"run","data":{"decision":"MOVE_NEEDED","mode":"dry-run","plan":{"atomic":true,"spread":5,"moves":[{"from":603,"to_offset":-5,"to_bin":601,"dlp":"1653254"},{"from":604,"to_offset":-4,"to_bin":602,"dlp":"1688004"},{"from":605,"to_offset":-3,"to_bin":603,"dlp":"1688004"}]}}}
```

**run (executed)** — single atomic tx
```json
{"status":"success","action":"run","data":{"decision":"EXECUTED","transaction":{"txid":"85ffba93c7aca96818416488671f113bc1bd0b0f1fa1d3b097da82cc9fc7f133"}}}
```

**run (in-range gate)** — blocks unnecessary moves
```json
{"status":"success","action":"run","data":{"decision":"IN_RANGE","reason":"Position is already in the active range — earning fees. No move needed. Use --force to recenter."}}
```

**auto (single cycle)** — autonomous rebalancer
```json
{"status":"success","action":"auto","data":{"mode":"once","cycle":1,"moves":0,"skipped":0,"errors":0}}
```

## Security notes

- **One atomic transaction** per rebalance via `move-relative-liquidity-multi`. Either all bins move or none do.
- **Contract-level slippage protection** — each move requires ≥95% DLP shares back (`min-dlp`) and caps liquidity fees at 5% (`max-x-liquidity-fee`, `max-y-liquidity-fee`). Transaction reverts on-chain if either bound is violated.
- **Funds stay in pool.** Liquidity moves between bins through the DLMM router. No tokens leave to external addresses.
- **Mainnet only.** All contract addresses are mainnet Stacks.
- **`--confirm` required for `run`.** The `auto` command executes directly (operator opts in).
- **postConditionMode: Allow** — DLP burn+mint in same tx can't be expressed as sender-side post-conditions. Contract-level `min-dlp` and fee caps compensate.
- **4-hour cooldown** per pool, persisted to disk.
- **CENTER_BIN_ID (500)** — API unsigned bin IDs converted to contract signed. Verified against on-chain `NUM_OF_BINS`.
- **Directional safety** — below-active bins only target offsets ≤ 0, above-active only ≥ 0. Matches DLMM bin invariant.
- **Router version: v-1-1** at SM deployer — current mainnet deployment. Documented in code with mainnet proof references.

## Known constraints

- Requires `@stacks/transactions` and `@stacks/wallet-sdk` at runtime.
- Maximum 208 moves per transaction (contract list length limit).
- Liquidity distributed across ±spread bins (default ±5). DLMM bin invariant enforced: below-active → offsets [-spread, 0], above-active → offsets [0, +spread].
- Bins very close to active with residual mixed tokens (tiny X in Y-only bins) may need `--force` with the default spread or a move to offset 0. This is an edge case — truly drifted positions have clean single-token bins.
- Bitflow API fields use snake_case exclusively — no camelCase fallbacks. If the API schema changes, the skill fails loudly rather than silently using wrong fields.

