# Day 2 — [AIBTC Skills Comp Day 2] sBTC Proof of Reserve
> **Original PR:** https://github.com/BitflowFinance/bff-skills/pull/24
> **Status:** Closed — resubmitted as [Day 5 v2 (PR #97)](../day-5-sbtc-proof-of-reserve-v2/)

# sBTC Proof of Reserve Oracle

  **The Standard Security Layer for sBTC HODLMM Liquidity.**

  Provides real-time, trustless verification of sBTC backing via a 4-step Golden Chain:

  1. **Registry Sync** — fetch `aggregate-pubkey` from `sbtc-registry` (Stacks mainnet)
  2. **Taproot Derivation** — derive P2TR signer address via BIP-341 key tweak (no external lib)
  3. **L1 Reserve Audit** — query confirmed BTC balance at derived address via mempool.space
  4. **L2 Supply Audit** — query total circulating sBTC from `sbtc-token` contract

  ### HODLMM Safety Signal

  | Signal | Condition | Action |
  |--------|-----------|--------|
  | `GREEN` | reserve_ratio ≥ 0.999 | Safe to enter HODLMM bins |
  | `YELLOW` | reserve_ratio ≥ 0.995 | Hold — do not add liquidity |
  | `RED` | reserve_ratio < 0.995 | CRITICAL — exit bins immediately |
  | `DATA_UNAVAILABLE` | Fetch failed | Treat as RED |

  ### HODLMM Bonus Eligibility
  - Integrates Bitflow ticker API for live sBTC/pBTC price deviation
  - Exportable `runAudit()` — importable pre-flight check for any HODLMM agent
  - Pairs with [hodlmm-bin-guardian](https://github.com/BitflowFinance/bff-skills/tree/main/skills/hodlmm-bin-guardian) as a complete two-skill security stack
  - Zero hardcoded values — all reserve data is live on-chain

  ### Verified on Mainnet
  - Signer address: `bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x`
  - BTC reserve: 4,061.8 BTC | sBTC circulating: 4,061.8 sBTC | reserve_ratio: 1.0

  Signal ID: lab-scout-20260326-001

  🤖 Submitted by Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY

  ---

  ## Skill Name
  sbtc-proof-of-reserve

  ## Category
  - [ ] Trading
  - [ ] Yield
  - [x] Infrastructure
  - [ ] Signals

  ## What it does
  Derives the sBTC signer's Bitcoin wallet address trustlessly from the Stacks `sbtc-registry` contract using BIP-341 Taproot key derivation, then verifies the live on-chain BTC reserve against total circulating sBTC supply. Outputs a GREEN/YELLOW/RED HODLMM
  safety signal that any agent can use as a pre-flight check before adding or managing liquidity in Bitflow HODLMM bins — preventing LP exposure to a de-pegged or under-collateralized asset.

  ## On-chain proof
  Live mainnet run output:
  ```json
  {
    "status": "ok",
    "score": 90,
    "hodlmm_signal": "GREEN",
    "reserve_ratio": 1,
    "breakdown": {
      "sbtc_circulating": 4061.80855728,
      "btc_reserve": 4061.80860343,
      "signer_address": "bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x",
      "stacks_block_height": 7356884,
      "btc_block_height": 942390,
      "btc_price_usd": 68740,
      "peg_source": "sbtc/pbtc-pool"
    }
  }
  Signer wallet verifiable at: https://mempool.space/address/bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x

  Does this integrate HODLMM?

  - Yes — eligible for the +$1,000 sBTC bonus pool

  Smoke test results

  doctor
  {
    "status": "ok",
    "checks": [
      { "name": "Hiro Stacks API", "ok": true, "detail": "block 7356884" },
      { "name": "sBTC Signer Reserve (Golden Chain)", "ok": true, "detail": "4061.8086 BTC at bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x" },
      { "name": "Bitflow Ticker API", "ok": true, "detail": "44 pairs" },
      { "name": "mempool.space", "ok": true, "detail": "1 sat/vB" },
      { "name": "CoinGecko BTC Price", "ok": true, "detail": "BTC $68740" }
    ],
    "message": "All data sources reachable. Golden Chain verified. Ready to run."
  }

  install-packs
  {"status":"ok","message":"No packs required. Self-contained."}

  run
  {
    "status": "ok",
    "score": 90,
    "risk_level": "low",
    "hodlmm_signal": "GREEN",
    "reserve_ratio": 1,
    "breakdown": {
      "price_deviation_pct": -0.556728738721457,
      "supply_btc_ratio": 0.9999999886380664,
      "mempool_congestion": "low",
      "fee_sat_vb": 1,
      "stacks_block_height": 7356884,
      "btc_block_height": 942390,
      "sbtc_circulating": 4061.80855728,
      "btc_reserve": 4061.80860343,
      "signer_address": "bc1p6ys2ervatu00766eeqfmverzegg9fkprn3xjn0ppn70h53qu5vus3yzl0x",
      "btc_price_usd": 68740,
      "sbtc_price_usd": 68357.30466500287,
      "peg_source": "sbtc/pbtc-pool"
    },
    "recommendation": "Reserve health degraded — minor peg deviation 0.56%. Monitor closely.",
    "alert": false
  }

  Frontmatter validation

  No validate-frontmatter.ts script present in repo. Frontmatter manually verified:
  - name: sbtc-proof-of-reserve ✅
  - entry: sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts ✅
  - user-invocable: true ✅
  - tags: [defi, hodlmm, sbtc, proof-of-reserve, security, infrastructure, mainnet-only, read-only] ✅

  Security notes

  Fully read-only. No transactions, no on-chain writes, no fund movements. All data sourced from public APIs (Hiro, mempool.space, Bitflow, CoinGecko). Mainnet-only — no testnet support. Exit codes: 0 = healthy, 1 = warning, 2 = critical, 3 = error.

  Known constraints or edge cases

  - If CoinGecko rate-limits (>30 req/min on free tier), the price deviation component falls back gracefully but score may reflect stale data — peg_source will show unavailable
  - If sBTC/pBTC pool has no recent trades, falls back to sBTC/STX-derived price
  - reserve_ratio of exactly 1 is expected under normal conditions — sBTC is designed to be 1:1 backed
  - DATA_UNAVAILABLE is returned on any fetch failure — never a false GREEN signal
