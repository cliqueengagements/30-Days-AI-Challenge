# Day 5 — feat(sbtc-proof-of-reserve): v2 added fixes
> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/97 (closed — archived here)

## Skill Name

sbtc-proof-of-reserve

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [ ] Yield
- [x] Infrastructure
- [x] Signals

## What it does

Read-only, trustless sBTC Proof-of-Reserve auditor. Derives the signer P2TR wallet address directly from the Stacks `sbtc-registry` contract (no hardcoded addresses), queries the confirmed BTC balance at that address via mempool.space, fetches total circulating sBTC supply from `sbtc-token`, and computes a live reserve ratio. Outputs a `GREEN`/`YELLOW`/`RED`/`DATA_UNAVAILABLE` HODLMM safety signal and a 0-100 peg health score as structured JSON. The exported `runAudit()` function makes it importable as a shared security module by any other skill.

## On-chain proof

Read-only skill — no on-chain transactions submitted. Live mainnet output below. Signer address `bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x` matches the known sBTC signer, independently verifying the BIP-341 P2TR derivation is correct.

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Outputs `hodlmm_signal` (GREEN/YELLOW/RED/DATA_UNAVAILABLE) as a pre-flight safety gate for any HODLMM deposit, rebalance, or yield action. Designed to pair with `hodlmm-bin-guardian` — together they cover both risk vectors for HODLMM LPs: asset risk (is sBTC backed?) and position risk (are bins in range?).

## v2 Changelog (all fixes from @arc0btc review on PR #73)

| # | Issue | Fix |
|---|-------|-----|
| 1 | `status: "ok"` could coexist with `hodlmm_signal: "RED"` | Signal-floor clamp: RED → score 0/critical, YELLOW → score ≤50/warning. `status` now always agrees with `hodlmm_signal`. |
| 2 | Sequential BTC price fetch blocked parallel batch | `fetchBtcPrice()` now in `Promise.all` with supply, reserve, mempool, heights. ~200ms faster. |
| 3 | `Number()` precision risk on large supply values | Fallback path uses `BigInt` intermediate. |
| 4 | `supply_btc_ratio` duplicated `reserve_ratio` (reciprocal) | Removed. Single `reserve_ratio` field (btc/sbtc, ≥1.0 = healthy). |
| 5 | CoinGecko 429 with no retry | `fetchJson` retries once on 429 after 1s backoff. |

## The Trilogy — Three Skills, One Pipeline

This skill is part of the Micro Basilisk "Defense-in-Depth" strategy:

| Skill | Role | Status |
|-------|------|--------|
| `hodlmm-bin-guardian` | **Detect** — are bins in range? | Day 3 winner (bff-skills PR #39, merged; registry PR [aibtcdev/skills#265](https://github.com/aibtcdev/skills/pull/265)) |
| `sbtc-proof-of-reserve` | **Assess** — is sBTC fully backed? | This PR (#97, Arc approved) |
| `hodlmm-emergency-exit` | **Act** — remove liquidity when unsafe | PR #100 (Day 5 submission) |

Together, these three skills form a complete autonomous LP protection pipeline: **detect → assess → act**. The emergency exit skill (PR #100) imports `runAudit()` from this skill to trigger withdrawals when the reserve signal is RED.

## Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is a quoted string (`"true"`)
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results

**doctor**

```
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts doctor
```

```json
{
  "status": "ok",
  "checks": [
    { "name": "Hiro Stacks API", "ok": true, "detail": "block 7409844" },
    { "name": "sBTC Signer Reserve (Golden Chain)", "ok": true, "detail": "4070.7208 BTC at bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x" },
    { "name": "Bitflow Ticker API", "ok": true, "detail": "44 pairs" },
    { "name": "mempool.space", "ok": true, "detail": "1 sat/vB" },
    { "name": "CoinGecko BTC Price", "ok": true, "detail": "BTC $67890" }
  ],
  "message": "All data sources reachable. Golden Chain verified. Ready to run."
}
```

**install-packs**

```
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts install-packs
```

```json
{"status":"ok","message":"No packs required. Self-contained."}
```

**run**

```
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run
```

```json
{
  "status": "ok",
  "score": 90,
  "risk_level": "low",
  "hodlmm_signal": "GREEN",
  "reserve_ratio": 1,
  "breakdown": {
    "price_deviation_pct": -0.7621983494171425,
    "reserve_ratio": 1,
    "mempool_congestion": "low",
    "fee_sat_vb": 1,
    "stacks_block_height": 7409844,
    "btc_block_height": 942933,
    "sbtc_circulating": 4070.72074418,
    "btc_reserve": 4070.72079033,
    "signer_address": "bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x",
    "btc_price_usd": 67890,
    "sbtc_price_usd": 67372.54354058071,
    "peg_source": "sbtc/pbtc-pool"
  },
  "recommendation": "Reserve health degraded — minor peg deviation 0.76%. Monitor closely.",
  "alert": false
}
```

## Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array): `"defi, read-only, mainnet-only, l1, l2, infrastructure"`
- `requires` empty quoted string: `""`
- `user-invocable` quoted `"true"`
- `entry` path is `sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts` (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- Read-only — no transactions submitted, no funds moved.
- Mainnet only. All endpoints target Bitcoin and Stacks mainnet production infrastructure.
- Returns `DATA_UNAVAILABLE` (treated as RED) if any data source is unreachable — never returns a false `GREEN`.
- `status` field guaranteed to agree with `hodlmm_signal` via signal-floor clamp (v2 fix #1).
- CoinGecko used only for BTC/USD display — core reserve ratio computed from on-chain data only.
- CoinGecko 429 rate limit handled with 1s retry backoff (v2 fix #5).

## Known constraints or edge cases

- `reserve_ratio` returns `0` (not `null`) when sBTC supply is 0 — triggers `RED` signal (safe default).
- CoinGecko free tier: 10-30 req/min. In multi-agent hot-loop scenarios, the 429 retry handles rate limits but sustained abuse will degrade to `DATA_UNAVAILABLE`.
- Bitflow sBTC/pBTC pool is the preferred price source. If unavailable, falls back to sBTC/STX derived via CoinGecko STX/USD — slightly less accurate.
- `import.meta.main` guard means importing `runAudit()` as a module does not trigger CLI side effects.

## PR Description

## Skill Name

sbtc-proof-of-reserve

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [ ] Yield
- [x] Infrastructure
- [x] Signals

## What it does

Read-only, trustless sBTC Proof-of-Reserve auditor. Derives the signer P2TR wallet address directly from the Stacks `sbtc-registry` contract (no hardcoded addresses), queries the confirmed BTC balance at that address via mempool.space, fetches total circulating sBTC supply from `sbtc-token`, and computes a live reserve ratio. Outputs a `GREEN`/`YELLOW`/`RED`/`DATA_UNAVAILABLE` HODLMM safety signal and a 0-100 peg health score as structured JSON. The exported `runAudit()` function makes it importable as a shared security module by any other skill.

## On-chain proof

Read-only skill — no on-chain transactions submitted. Live mainnet output below. Signer address `bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x` matches the known sBTC signer, independently verifying the BIP-341 P2TR derivation is correct.

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Outputs `hodlmm_signal` (GREEN/YELLOW/RED/DATA_UNAVAILABLE) as a pre-flight safety gate for any HODLMM deposit, rebalance, or yield action. Designed to pair with `hodlmm-bin-guardian` — together they cover both risk vectors for HODLMM LPs: asset risk (is sBTC backed?) and position risk (are bins in range?).

## v2 Changelog (all fixes from @arc0btc review on PR #73)

| # | Issue | Fix |
|---|-------|-----|
| 1 | `status: "ok"` could coexist with `hodlmm_signal: "RED"` | Signal-floor clamp: RED → score 0/critical, YELLOW → score ≤50/warning. `status` now always agrees with `hodlmm_signal`. |
| 2 | Sequential BTC price fetch blocked parallel batch | `fetchBtcPrice()` now in `Promise.all` with supply, reserve, mempool, heights. ~200ms faster. |
| 3 | `Number()` precision risk on large supply values | Fallback path uses `BigInt` intermediate. |
| 4 | `supply_btc_ratio` duplicated `reserve_ratio` (reciprocal) | Removed. Single `reserve_ratio` field (btc/sbtc, ≥1.0 = healthy). |
| 5 | CoinGecko 429 with no retry | `fetchJson` retries once on 429 after 1s backoff. |

## The Trilogy — Three Skills, One Pipeline

This skill is part of the Micro Basilisk "Defense-in-Depth" strategy:

| Skill | Role | Status |
|-------|------|--------|
| `hodlmm-bin-guardian` | **Detect** — are bins in range? | Day 3 winner (bff-skills PR #39, merged; registry PR [aibtcdev/skills#265](https://github.com/aibtcdev/skills/pull/265)) |
| `sbtc-proof-of-reserve` | **Assess** — is sBTC fully backed? | This PR (#97, Arc approved) |
| `hodlmm-emergency-exit` | **Act** — remove liquidity when unsafe | PR #100 (Day 5 submission) |

Together, these three skills form a complete autonomous LP protection pipeline: **detect → assess → act**. The emergency exit skill (PR #100) imports `runAudit()` from this skill to trigger withdrawals when the reserve signal is RED.

## Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is a quoted string (`"true"`)
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results

**doctor**

```
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts doctor
```

```json
{
  "status": "ok",
  "checks": [
    { "name": "Hiro Stacks API", "ok": true, "detail": "block 7409844" },
    { "name": "sBTC Signer Reserve (Golden Chain)", "ok": true, "detail": "4070.7208 BTC at bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x" },
    { "name": "Bitflow Ticker API", "ok": true, "detail": "44 pairs" },
    { "name": "mempool.space", "ok": true, "detail": "1 sat/vB" },
    { "name": "CoinGecko BTC Price", "ok": true, "detail": "BTC $67890" }
  ],
  "message": "All data sources reachable. Golden Chain verified. Ready to run."
}
```

**install-packs**

```
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts install-packs
```

```json
{"status":"ok","message":"No packs required. Self-contained."}
```

**run**

```
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run
```

```json
{
  "status": "ok",
  "score": 90,
  "risk_level": "low",
  "hodlmm_signal": "GREEN",
  "reserve_ratio": 1,
  "breakdown": {
    "price_deviation_pct": -0.7621983494171425,
    "reserve_ratio": 1,
    "mempool_congestion": "low",
    "fee_sat_vb": 1,
    "stacks_block_height": 7409844,
    "btc_block_height": 942933,
    "sbtc_circulating": 4070.72074418,
    "btc_reserve": 4070.72079033,
    "signer_address": "bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x",
    "btc_price_usd": 67890,
    "sbtc_price_usd": 67372.54354058071,
    "peg_source": "sbtc/pbtc-pool"
  },
  "recommendation": "Reserve health degraded — minor peg deviation 0.76%. Monitor closely.",
  "alert": false
}
```

## Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array): `"defi, read-only, mainnet-only, l1, l2, infrastructure"`
- `requires` empty quoted string: `""`
- `user-invocable` quoted `"true"`
- `entry` path is `sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts` (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- Read-only — no transactions submitted, no funds moved.
- Mainnet only. All endpoints target Bitcoin and Stacks mainnet production infrastructure.
- Returns `DATA_UNAVAILABLE` (treated as RED) if any data source is unreachable — never returns a false `GREEN`.
- `status` field guaranteed to agree with `hodlmm_signal` via signal-floor clamp (v2 fix #1).
- CoinGecko used only for BTC/USD display — core reserve ratio computed from on-chain data only.
- CoinGecko 429 rate limit handled with 1s retry backoff (v2 fix #5).

## Known constraints or edge cases

- `reserve_ratio` returns `0` (not `null`) when sBTC supply is 0 — triggers `RED` signal (safe default).
- CoinGecko free tier: 10-30 req/min. In multi-agent hot-loop scenarios, the 429 retry handles rate limits but sustained abuse will degrade to `DATA_UNAVAILABLE`.
- Bitflow sBTC/pBTC pool is the preferred price source. If unavailable, falls back to sBTC/STX derived via CoinGecko STX/USD — slightly less accurate.
- `import.meta.main` guard means importing `runAudit()` as a module does not trigger CLI side effects.


