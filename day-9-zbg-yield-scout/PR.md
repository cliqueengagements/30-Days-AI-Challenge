## Skill Submission

**Skill name:** zbg-yield-scout
**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5
**Category:** Yield
**HODLMM integration?** Yes — scans all 8 HODLMM pools, reads bin positions, calculates break prices from on-chain bin math

---

### What it does

Are your assets lying idle in your wallet and earning nothing? Let's fix that.

You just got paid in sBTC from signals, bounties, or competition prizes, or you have other assets lying idle somewhere. It's sitting in your wallet, losing value to fees and missed yield. You know you should put it to work, but Stacks DeFi has dozens of protocols and you don't know where to start.

**Start here.**

**ZBG** = the three largest sBTC yield protocols on Stacks:

| Protocol | TVL | How it works |
|----------|-----|-------------|
| **Zest** | $77.7M | Lending. Deposit sBTC, borrowers pay you interest. Like a savings account. No lockup. |
| **Bitflow** (HODLMM) | $1.1M | Liquidity provision. Place sBTC into trading bins, earn fees on every swap. Has a price range. |
| **Granite** | $25.9M | Lending with collateral. Higher rates — serves leveraged borrowers. Earn supply APY. |

Together, ZBG represents **over $100M in TVL** — the three places serious sBTC yield lives on Stacks today.

**One command. Five sections. No DeFi knowledge required.**

1. **What You Have** - Your sBTC, STX, and USDCx balances shown in dollars. No raw decimals, no hex — just what you own.
2. **Available ZBG Positions** - Checks all three protocols for active deposits. Scans all 8 HODLMM pools. If nothing deployed: "idle, earning nothing."
3. **Your Options** - Side-by-side yield comparison. APY, daily/monthly earnings, gas cost. Sorted best to worst.
4. **Best Safe Move** - One recommendation. Not five options to research — one clear next step. Shows exactly how much you're leaving on the table.
5. **Break Prices** - The sBTC price where things go wrong. Where your bins exit range. Where Granite liquidates. A plain dollar number.

**No transactions. No gas. No risk. Read-only.** First skill to read Granite on-chain.

**Built for:**
- The beginner who holds sBTC, STX, USDCx and doesn't know what DeFi is yet
- The agent that just earned their first 30,000 sats and wants it working, not sitting
- The LP who added liquidity three weeks ago and hasn't checked if their bins are still in range
- The builder who knows Clarity but not DeFi
- The fund manager who needs one dashboard across all three protocols before moving capital

---

### On-chain proof

> Live output from mainnet wallet `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY` - 11 data sources, real positions, real yield rates.

#### 1. What You Have (available in wallet)

| Token | Amount | USD |
|-------|-------:|----:|
| sBTC | 0.00165382 | $118.57 |
| STX | 39.582744 | $8.52 |
| USDCx | 19.614562 | $19.61 |
| **Wallet Total** | | **$146.70** |

#### 2. Available ZBG Positions (deployed capital)

| Protocol | Status | Detail | Value |
|----------|--------|--------|------:|
| Zest | No position | No sBTC supply position on Zest | — |
| Granite | No position | No supply position (supply APY: 3%, util: 89.08%) | — |
| HODLMM | **ACTIVE** | sBTC-USDCx-10bps — **IN RANGE** at bin 510, 221 bins (460–680) | $67.45 |
| **Deployed Total** | | | **$67.45** |

**Total portfolio: $214.15** (wallet: $146.70 + deployed: $67.45)

#### 3. ZBG Smart Options (sorted by APY)

| # | Protocol | Pool | APY | Daily | Monthly | Gas | Note |
|---|----------|------|----:|------:|--------:|----:|------|
| 1 | HODLMM | sBTC-USDCx-10bps | 44.3% | $0.1439 | $4.32 | 0.05 STX | Fee-based - varies with swap volume. TVL: $44,191 |
| 2 | HODLMM | sBTC-USDCx-1bps | 23.05% | $0.0749 | $2.25 | 0.05 STX | Fee-based - varies with swap volume. TVL: $82 |
| 3 | HODLMM | STX-sBTC-15bps | 3.92% | $0.0127 | $0.38 | 0.05 STX | Fee-based - varies with swap volume. TVL: $21,971 |
| 4 | Granite | sBTC Supply | 3.00% | $0.0097 | $0.29 | 0.05 STX | Lending yield - 89.08% util, borrow APR 3.37%. Max LTV 50% |
| 5 | HODLMM | STX-USDCx-10bps | 1.02% | $0.0002 | $0.01 | 0.05 STX | Fee-based - varies with swap volume. TVL: $1,116,178 |
| 6 | Zest | sBTC Supply | 0.00% | $0.00 | $0.00 | 0.03 STX | APY currently 0% - check zest.fi for latest rates |

#### 4. Best Safe Move

> Active position on HODLMM (1 pool in range). You also have **$146.70 idle** in wallet. Best option for idle funds: **HODLMM sBTC-USDCx-10bps at 44.3% APY** (~$0.178/day missed).

| Metric | Value |
|--------|------:|
| Idle in wallet | $146.70 |
| Opportunity cost | $0.178/day |

#### 5. Break Prices

| Trigger | sBTC Price |
|---------|----------:|
| HODLMM range exit (low) | **$63,600.23** |
| Current sBTC price | $71,692.50 |
| HODLMM range exit (high) | **$79,242.05** |
| Granite liquidation | N/A (no position) |

> Your position is safe — **$8,092** above low exit, **$7,550** below high exit.

`Data sources: 11 live reads | Status: ok`

---

### Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is the string `"false"`, not a boolean
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

---

### Smoke test results

<details>
<summary><strong>doctor</strong></summary>

```json
{
  "status": "ok",
  "checks": [
    { "name": "Hiro Stacks API", "ok": true, "detail": "tip: 7456450, burn: 943518" },
    { "name": "Tenero Price Oracle", "ok": true, "detail": "sBTC: $71692.5" },
    { "name": "Granite Protocol (on-chain)", "ok": true, "detail": "get-lp-params readable" },
    { "name": "HODLMM Pool Contracts", "ok": true, "detail": "sBTC-USDCx-10bps active bin: 510" },
    { "name": "Bitflow HODLMM API", "ok": true, "detail": "dlmm_1 TVL: $44,191, APR: 44.30%" },
    { "name": "DLMM Core (bin-price)", "ok": true, "detail": "get-bin-price callable" }
  ],
  "message": "All 6 data sources reachable. Ready to scout."
}
```

</details>

<details>
<summary><strong>run</strong></summary>

```json
{
  "status": "ok",
  "wallet": "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY",
  "what_you_have": {
    "sbtc": { "amount": 0.00165382, "usd": 118.57 },
    "stx": { "amount": 39.582744, "usd": 8.52 },
    "usdcx": { "amount": 19.614562, "usd": 19.61 }
  },
  "zbg_positions": {
    "zest": { "has_position": false, "detail": "No sBTC supply position on Zest" },
    "granite": { "has_position": false, "detail": "No supply position on Granite", "supply_apy_pct": 3, "borrow_apr_pct": 3.37, "utilization_pct": 89.08, "max_ltv_pct": 50, "liquidation_ltv_pct": 65 },
    "hodlmm": { "has_position": true, "pools": [{ "pool_id": 1, "name": "sBTC-USDCx-10bps", "in_range": true, "active_bin": 510, "user_bins": { "min": 460, "max": 680, "count": 221 }, "dlp_shares": "99661451", "estimated_value_usd": 67.45 }] }
  },
  "smart_options": [
    { "protocol": "HODLMM", "pool": "sBTC-USDCx-10bps", "apy_pct": 44.3, "daily_usd": 0.1439, "monthly_usd": 4.32, "gas_to_enter_stx": 0.05, "note": "Fee-based yield — varies with swap volume. TVL: $44,191." },
    { "protocol": "HODLMM", "pool": "sBTC-USDCx-1bps", "apy_pct": 23.05, "daily_usd": 0.0749, "monthly_usd": 2.25, "gas_to_enter_stx": 0.05, "note": "Fee-based yield — varies with swap volume. TVL: $82." },
    { "protocol": "HODLMM", "pool": "STX-sBTC-15bps", "apy_pct": 3.92, "daily_usd": 0.0127, "monthly_usd": 0.38, "gas_to_enter_stx": 0.05, "note": "Fee-based yield — varies with swap volume. TVL: $21,971." },
    { "protocol": "Granite", "pool": "sBTC Supply", "apy_pct": 3, "daily_usd": 0.0097, "monthly_usd": 0.29, "gas_to_enter_stx": 0.05, "note": "Lending yield — 89.08% utilization, borrow APR 3.37%. Max LTV 50%." },
    { "protocol": "HODLMM", "pool": "STX-USDCx-10bps", "apy_pct": 1.02, "daily_usd": 0.0002, "monthly_usd": 0.01, "gas_to_enter_stx": 0.05, "note": "Fee-based yield — varies with swap volume. TVL: $1,116,178." },
    { "protocol": "Zest", "pool": "sBTC Supply", "apy_pct": 0, "daily_usd": 0, "monthly_usd": 0, "gas_to_enter_stx": 0.03, "note": "sBTC supply APY currently 0% — check zest.fi for latest rates." }
  ],
  "best_move": { "recommendation": "Active position on HODLMM (1 pool in range). You also have $146.7 idle in wallet. Best option for idle funds: HODLMM sBTC-USDCx-10bps at 44.3% APY (~$0.178/day missed).", "idle_capital_usd": 146.7, "opportunity_cost_daily_usd": 0.178 },
  "break_prices": { "hodlmm_range_exit_low_usd": 63600.23, "hodlmm_range_exit_high_usd": 79242.05, "granite_liquidation_usd": null, "current_sbtc_price_usd": 71692.5 },
  "data_sources": [ "hiro-balances", "tenero-sbtc-price", "tenero-stx-price", "zest-on-chain", "granite-on-chain", "hodlmm-pool-1", "granite-apy", "bitflow-hodlmm-apr", "zest-apy", "hodlmm-bin-price-low", "hodlmm-bin-price-high" ],
  "error": null
}
```

</details>

---

### Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array)
- `requires` empty quoted string
- `user-invocable` quoted string `"false"`
- `entry` path repo-root-relative (no `skills/` prefix)
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

---

### Security notes

- **Read-only — zero fund movement.** No transactions submitted, no gas spent, no signing, no private keys accepted or requested. The `--wallet` flag takes a public STX address only.
- **Mainnet-only.** All on-chain reads target Stacks mainnet via Hiro API (`api.mainnet.hiro.so`). No testnet fallback, no devnet.
- **Direct on-chain reads for protocol state.** Granite params and HODLMM bin positions are read directly from on-chain contracts via Hiro `call_read_only_function` — no third-party aggregator. HODLMM APR and TVL come from Bitflow API (first-party, same team that deploys the pools). Zest position checked on-chain first, with Hiro token balance fallback.
- **sBTC pricing, not BTC L1.** Break prices and USD conversions use on-chain sBTC price from Tenero (Stacks-native analytics). sBTC can depeg from BTC during stress — the skill reflects what the protocols actually see.
- **BigInt for all Clarity values.** HODLMM bin balances and Granite IR params are uint128. Parsed with `BigInt` from big-endian hex — never uses JavaScript `Number` for on-chain values above 2^53. No precision loss.
- **30-second AbortController timeout on every HTTP call.** If any source hangs, it aborts cleanly and the skill reports `"degraded"` status — remaining sections still render.
- **No caching.** Every invocation reads fresh on-chain state. No stale data carried between runs.
- **Input validation.** Wallet address is regex-validated (`/^SP[A-Z0-9]{30,}$/i`) before any network call. Invalid input returns an error JSON immediately — no partial execution.
- **Failure isolation per section.** If Zest reads fail, Granite and HODLMM sections still populate. If Bitflow API is down, HODLMM APR is omitted but positions and break prices still work. No single source failure crashes the report.

---

### Known constraints and edge cases

- **HODLMM yield is fee-based, not a fixed APY.** The `apr24h` from Bitflow API reflects trailing 24-hour swap fees annualized — it swings with volume. Displayed as-is with a note so users understand this is variable income, not a guaranteed rate.
- **Zest sBTC supply APY currently reads 0%.** On-chain read returns 0% for sBTC supply. This reflects current protocol state (low borrowing demand), not a data error. Displayed as-is with a note to check zest.fi.
- **Tenero dependency for USD prices.** sBTC and STX prices come from Tenero API (Stacks-native analytics). If Tenero is unreachable, sBTC USD defaults to 0 and STX to 0.216. Break prices still calculate from on-chain bin math — only USD context is lost.
- **HODLMM position value uses TVL share ratio.** Reading all 221 per-bin balances would be too slow. Instead, `dlpShares / totalSupply * poolTVL` from Bitflow API gives the USD estimate. If Bitflow API is down, `estimated_value_usd` returns `null` but bin range and in-range status still work (those come from on-chain reads).
- **Granite liquidation price is null for supply-only.** The `liquidator-v1.account-health` call needs a `trait_reference` arg (not encodable via Hiro API). For borrowers, liquidation threshold is derivable from `max_ltv_pct` (50%) and `liquidation_ltv_pct` (65%) read from `get-collateral`. For supply-only positions (no debt), there is no liquidation risk — `granite_liquidation_usd` correctly returns `null`.
- **Gas cost estimates are fixed approximations.** All options show 0.05 STX (0.03 for Zest) — typical transaction overhead, not measured per-call.
- **8 HODLMM pools scanned sequentially.** Each pool requires 3-4 on-chain reads. Worst case with positions in all 8 pools: ~15-20 seconds total scan time.

