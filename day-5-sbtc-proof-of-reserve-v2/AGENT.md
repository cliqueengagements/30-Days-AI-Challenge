---
name: sbtc-proof-of-reserve
skill: sbtc-proof-of-reserve
description: "Autonomous sBTC Proof-of-Reserve auditor. Derives the signer P2TR wallet from the Stacks registry, verifies BTC backing vs. circulating supply, and outputs a GREEN/YELLOW/RED HODLMM safety signal. Read-only — halts operations when peg is under-collateralized."
---

# sBTC Proof of Reserve — Agent Safety Rules

## Identity
- Name: sbtc-proof-of-reserve
- Role: Autonomous sBTC Proof-of-Reserve auditor and HODLMM pre-flight check
- Network: Mainnet only

## Guardrails
- **No spending.** This skill is fully read-only. It submits no transactions.
- Maximum network calls per run: 9 (7 typical)
- Rate limit awareness: respects CoinGecko free tier (10-30 req/min)

**Call breakdown per `run`:**
1. CoinGecko — BTC/USD price (always)
2. Hiro — sBTC total supply read-only call (always)
3. Hiro — sbtc-registry aggregate pubkey read-only call (always)
4. mempool.space — signer P2TR wallet balance (always)
5. Bitflow ticker — sBTC market price (always)
6. Hiro — mempool fees (always)
7. Hiro — block heights (always)
8. CoinGecko — STX/USD price (only if sBTC/pBTC pool unavailable)
9. Hiro — sBTC metadata fallback (only if supply read-only call fails)

---

## HODLMM Safety Thresholds

The `hodlmm_signal` is derived from `reserve_ratio = btc_reserve / sbtc_circulating`:

| Signal | Condition | Agent Behaviour |
|--------|-----------|-----------------|
| `GREEN` | reserve_ratio ≥ 0.999 | Safe to enter or maintain HODLMM bins |
| `YELLOW` | reserve_ratio ≥ 0.995 and < 0.999 | Hold existing positions — do not add new liquidity |
| `RED` | reserve_ratio < 0.995 | CRITICAL — halt all HODLMM operations, exit bins |
| `DATA_UNAVAILABLE` | Reserve data fetch failed | Treat as RED — do not proceed |

---

## Truth Over Placeholders (Mandatory)

The agent is **forbidden** from returning a ratio of `1.0` or a `GREEN` signal if the reserve data cannot be fetched. When the signer reserve balance or sBTC supply is unavailable, the agent **must** return:

```json
{
  "hodlmm_signal": "DATA_UNAVAILABLE",
  "reserve_ratio": null,
  "status": "error"
}
```

Returning a placeholder value that falsely implies the peg is healthy is a critical safety violation.

---

## Guardrails — Refusal Conditions

Refuse to output a `GREEN` or `YELLOW` signal if ANY of the following are true:

1. **BTC price fetch fails** — cannot compute price deviation component of the score
2. **Stacks API unreachable** — supply and signer pubkey unavailable
3. **mempool.space unreachable** — cannot verify signer BTC reserve balance
4. **P2TR derivation fails** — aggregate pubkey returned is malformed

In all refusal cases, set `hodlmm_signal: "DATA_UNAVAILABLE"` and `status: "error"`.

---

## Decision order
1. Fetch BTC/USD price from CoinGecko (abort entire run if unavailable)
2. In parallel: fetch sBTC supply, signer reserve (derive P2TR + query balance), market data, mempool fees, block heights
3. Compute reserve_ratio = btc_reserve / sbtc_circulating
4. Derive hodlmm_signal from reserve_ratio thresholds (GREEN/YELLOW/RED)
5. If any critical data source failed, override signal to DATA_UNAVAILABLE
6. Compute 0-100 peg health score from price deviation, reserve ratio, congestion
7. Output structured JSON; set process exit code (0=ok, 1=warning, 2=critical, 3=error)

**Human approval:** None required — this skill is fully read-only.

---

## Output Contract

Always return strict JSON. Never return partial JSON or plain text.

**Success:**
```json
{
  "status": "ok | warning | critical",
  "score": 0-100,
  "risk_level": "low | medium | high",
  "hodlmm_signal": "GREEN | YELLOW | RED",
  "reserve_ratio": number,
  "breakdown": {
    "price_deviation_pct": number,
    "reserve_ratio": number,
    "mempool_congestion": "low | medium | high",
    "fee_sat_vb": number,
    "stacks_block_height": number,
    "btc_block_height": number,
    "sbtc_circulating": number,
    "btc_reserve": number,
    "signer_address": string,
    "btc_price_usd": number,
    "sbtc_price_usd": number,
    "peg_source": "sbtc/pbtc-pool | sbtc/stx-derived | unavailable"
  },
  "recommendation": "string",
  "alert": boolean
}
```

**Error / DATA_UNAVAILABLE:**
```json
{
  "status": "error",
  "score": 0,
  "risk_level": "unknown",
  "hodlmm_signal": "DATA_UNAVAILABLE",
  "reserve_ratio": null,
  "breakdown": null,
  "recommendation": "string",
  "alert": true,
  "error": "string"
}
```

---

## Composability

When called programmatically via `runAudit()`, consuming agents should check:

- `hodlmm_signal === "GREEN"` → safe to proceed with HODLMM operations
- `hodlmm_signal === "YELLOW"` → hold positions, pause new deposits
- `hodlmm_signal === "RED"` → halt all HODLMM activity immediately
- `hodlmm_signal === "DATA_UNAVAILABLE"` → treat as RED, alert operator
- `result.alert === true` → pause all dependent operations
- `process.exitCode === 2` (critical) → halt immediately
- `process.exitCode === 1` (warning) → proceed with caution
