# Day 8 — HODLMM Rebalance Arbiter

> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/141 (closed — superseded by PR #213)

## Skill name

hodlmm-rebalance-arbiter

## Category

- [ ] Trading
- [x] Yield
- [x] Infrastructure

**HODLMM integration?** Yes

## What it does

Answers one question for HODLMM liquidity providers: **"Should I rebalance right now, or wait?"**

Consumes 2 independent signals — bin drift and sBTC peg health — to produce a single REBALANCE, BLOCKED, or IN_RANGE verdict. Running monitoring skills independently gives you separate signals but no verdict. The arbiter encodes the operational logic into a single decision gate.

| Scenario | Decision |
|---|---|
| All GREEN | **REBALANCE** — safe to move |
| Reserve YELLOW | **REBALANCE** — acceptable risk |
| Any RED | **BLOCKED** — specific reason provided |
| Any ERROR | **DEGRADED** — fix data sources first |
| Bins in range | **IN_RANGE** — no rebalance needed |

## Why agents need it

Monitoring without a decision layer is noise. bin-guardian says REBALANCE, but is the sBTC peg healthy enough to move capital? The arbiter fills the gap between monitoring and action in the HODLMM LP lifecycle.

v2 note: The original submission included a third signal (Bitcoin tenure timing) which was removed after community review identified a flawed premise. Two rock-solid signals beat three with a weak link.

## Safety notes

- **Read-only** — never executes transactions, never moves funds
- **Fail-safe default** — missing or stale data pushes toward WAIT or DEGRADED, never toward REBALANCE
- **Double YELLOW = WAIT** — one caution signal is acceptable; two simultaneous caution signals defer action
- **Silence locks the gate** — 2 positive signals required to unlock REBALANCE
- **No API keys required** — all data from public endpoints
- **Structured exit codes** — 0 (rebalance/in_range), 1 (blocked), 3 (degraded/error)
- **BIP-341 PoR derivation** — full Golden Chain (aggregate pubkey -> P2TR -> BTC balance) for sBTC reserve verification
- **Bech32m self-test** — crypto failure blocks all operations

## HODLMM integration

Decision layer in the HODLMM LP lifecycle:

| Phase | Skill | Role |
|-------|-------|------|
| Entry | usdcx-yield-optimizer | Where to deploy capital |
| Monitor | bin-guardian, sbtc-reserve | Watch for drift and peg health |
| **Act** | **rebalance-arbiter** | **Should I rebalance now?** |
| Optimize | smart-yield-migrator | Move between protocols |
| Exit | hodlmm-emergency-exit | Get out when things break |

## Data sources

| Source | Signal |
|--------|--------|
| Bitflow Quotes/App/Bins API | bin_guardian — pool discovery, TVL, active bin |
| Bitflow User Positions | bin_guardian — LP bin positions |
| Hiro Node Info | sbtc_reserve — block heights |
| sBTC Contract | sbtc_reserve — circulating supply |
| sBTC Registry | sbtc_reserve — signer pubkey |
| mempool.space | sbtc_reserve — BTC reserve balance |

## Known constraints

- Read-only — outputs a decision but cannot execute the rebalance itself
- sBTC reserve uses full Golden Chain derivation; sbtc-registry pubkey format changes would fail gracefully
- Requires `--wallet` — cannot decide without knowing which bins the LP holds
- Superseded by stacks-alpha-engine (PR #213) which includes this logic in its Guardian module

## PR Description

## Skill Name

hodlmm-rebalance-arbiter

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [x] Yield
- [x] Infrastructure
- [ ] Signals

## What it does

The decision gate that fills the Act phase in the HODLMM LP lifecycle. Answers one question for HODLMM LPs: **"Should I rebalance right now, or wait?"**

Running 3 monitoring skills independently gives you bin drift, tenure timing, and sBTC peg health — but no verdict. The arbiter synthesizes these into a single decision using a priority matrix:

| Scenario | Decision |
|---|---|
| All GREEN | **REBALANCE** — safe to move |
| One YELLOW, rest GREEN | **REBALANCE** — acceptable risk |
| Two+ YELLOW | **BLOCKED** — environment degrading on multiple fronts |
| Any RED | **BLOCKED** — specific reason provided |
| Any ERROR | **DEGRADED** — fix data sources first |
| Bins in range | **IN_RANGE** — no rebalance needed |

Key insight: sometimes the most profitable move is doing nothing. During stale tenures or peg instability, executing a rebalance at bad prices costs more than earning zero fees in a safe position.

## On-chain proof

Read-only skill — live mainnet data verified against wallet `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY`:

- **HODLMM position read**: 221 bins (460–680) on dlmm_1 (sBTC/USDCx), active bin 509, APR 30.36%
- **sBTC reserve derived via Golden Chain**: aggregate pubkey from `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry` → P2TR signer `bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x` → 4071.08 BTC confirmed via mempool.space
- **sBTC supply read**: `sbtc-token.get-total-supply` → 4071.08 sBTC, reserve ratio 1.0
- **Tenure read**: Hiro `/v2/info` + `/extended/v2/burn-blocks` → block 943300, tenure age real-time

**Verdict: IN_RANGE** — position in range at active bin 509, earning 30.36% APR. No rebalance needed. All 3 signals GREEN — tenure fresh (53s), sBTC fully backed, bins in range.

Full smoke test output below.

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

The arbiter is the decision layer in the HODLMM LP lifecycle. It consumes data from Bitflow HODLMM APIs (pools, bins, user positions) and correlates with Bitcoin block timing and sBTC reserve health to determine if a rebalance is safe to execute. It fills the gap between monitoring (bin-guardian, tenure-protector, sbtc-proof-of-reserve) and action — the "Act" phase that was previously missing.

| Phase | Skill | Role |
|-------|-------|------|
| Entry | usdcx-yield-optimizer | Where to deploy capital |
| Monitor | bin-guardian, tenure-protector, sbtc-reserve | Watch for drift, timing risk, peg health |
| **Act** | **hodlmm-rebalance-arbiter** | **Should I rebalance now? GO or BLOCKED** |
| Optimize | smart-yield-migrator, hermetica-yield-rotator | Move between protocols |
| Exit | hodlmm-emergency-exit | Get out when things break |

## Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is the string `"true"`, not a boolean
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results

**doctor**

```bash
$ bun run skills/hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts doctor
```
```json
{
  "status": "ok",
  "checks": [
    { "name": "Bitflow Quotes API", "ok": true, "detail": "8 pools" },
    { "name": "Bitflow App API", "ok": true, "detail": "8 pools with stats" },
    { "name": "Bitflow Bins API", "ok": true, "detail": "active_bin=520, 1001 bins" },
    { "name": "Hiro Stacks API", "ok": true, "detail": "stacks=7439381, btc=943300" },
    { "name": "Hiro Burn Blocks", "ok": true, "detail": "latest: 943300" },
    { "name": "sBTC Supply Contract", "ok": true, "detail": "contract callable" },
    { "name": "mempool.space", "ok": true, "detail": "reachable" }
  ],
  "message": "All 7 data sources reachable. Arbiter ready — all 3 signals operational."
}
```

**install-packs**

```bash
$ bun run skills/hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts install-packs
```
```json
{"status":"ok","message":"No packs required. Uses native fetch for Bitflow, Hiro, and mempool.space APIs."}
```

**run — wallet with active HODLMM position (IN_RANGE)**

```bash
$ bun run skills/hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts run --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY --pool dlmm_1
```
```json
{
  "status": "ok",
  "decision": "IN_RANGE",
  "reason": "Position in range at active bin 509. No rebalance needed. APR: 30.36%.",
  "signals": {
    "bin_guardian": {
      "color": "GREEN",
      "needs_rebalance": false,
      "active_bin": 509,
      "user_bin_range": { "min": 460, "max": 680, "count": 221 },
      "in_range": true,
      "slippage_pct": 0.2928,
      "volume_24h_usd": 383882,
      "apr_24h_pct": 30.36,
      "pool_id": "dlmm_1",
      "pair": "sBTC/USDCx"
    },
    "tenure_protector": {
      "color": "GREEN",
      "tenure_age_s": 53,
      "risk_level": "GREEN",
      "burn_block_height": 943302,
      "predicted_next_block_s": 899,
      "stacks_tip_height": 7439502
    },
    "sbtc_reserve": {
      "color": "GREEN",
      "reserve_ratio": 1,
      "score": 100,
      "hodlmm_signal": "GREEN",
      "sbtc_circulating": 4071.07747203,
      "btc_reserve": 4071.0775182,
      "signer_address": "bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x",
      "recommendation": "sBTC fully backed. Safe for HODLMM operations."
    }
  },
  "blockers": [],
  "retry_after": null,
  "pool_id": "dlmm_1",
  "wallet": "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY",
  "timestamp": "2026-04-02T02:19:45.358Z",
  "error": null
}
```

All 3 signals GREEN — fresh Bitcoin block (53s), position in range (bins 460–680 covering active bin 509), sBTC fully backed (4071 BTC / 4071 sBTC). Verdict: IN_RANGE at 30.36% APR.

**run — wallet with no position**

```bash
$ bun run skills/hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts run --wallet SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9 --pool dlmm_1
```
```json
{
  "status": "ok",
  "decision": "IN_RANGE",
  "reason": "No HODLMM position found for this wallet on pool dlmm_1. Deploy liquidity first."
}
```

## Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array): `"defi, read-only, mainnet-only, infrastructure"`
- `requires` empty quoted string
- `user-invocable` quoted string `"true"`
- `entry` path repo-root-relative: `"hodlmm-rebalance-arbiter/hodlmm-rebalance-arbiter.ts"`
- `AGENT.md` has YAML frontmatter with `name`, `skill` (string), `description`
- `author: "cliqueengagements"` (quoted)
- `author-agent` uses em dash `—` (not double dash)

## Security notes

- **Read-only** — never constructs transactions, never moves funds, never accesses private keys
- **Fail-safe** — missing/stale/malformed data always pushes toward BLOCKED or DEGRADED, never REBALANCE
- **Double YELLOW = BLOCKED** — one caution signal is tolerable; two simultaneous means environment is degrading
- **Silence locks the gate** — 3 positive signals required to unlock REBALANCE
- **No credentials** — all data from public endpoints (Bitflow, Hiro, mempool.space)
- **30s timeout** on all API calls with AbortController

## Known constraints or edge cases

- Cannot execute rebalances — outputs a decision for a human or executor skill to act on
- Bitcoin block times are inherently unpredictable; tenure-based BLOCKED decisions are probabilistic
- Wallet with no position returns IN_RANGE with clear "deploy liquidity first" message
- sBTC Golden Chain derivation (aggregate pubkey → P2TR → BTC balance) will fail gracefully if sbtc-registry changes pubkey format
- CoinGecko rate limits may affect reserve signal; retries once on 429 with 1.5s backoff
- `--wallet` is required — arbiter cannot decide without knowing which bins the LP holds

