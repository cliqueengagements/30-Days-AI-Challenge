---
name: sbtc-proof-of-reserve
description: "Real-time sBTC Proof-of-Reserve auditor. Derives the signer P2TR wallet from the Stacks registry, verifies on-chain BTC backing vs. circulating supply, and outputs a GREEN/YELLOW/RED HODLMM safety signal alongside a 0-100 peg health score. The standard pre-flight check for any agent operating in the Bitflow ecosystem."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "true"
  arguments: "doctor | install-packs | run [--threshold <0-100>]"
  entry: "sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l1, l2, infrastructure"
---

# sBTC Proof of Reserve

**The Standard Security Layer for sBTC HODLMM Liquidity.**

A professional-grade, read-only Proof-of-Reserve auditor that provides real-time cross-chain verification of sBTC backing. Designed to be the pre-flight check for any autonomous agent engaging in Bitflow HODLMM yield strategies — and importable as a shared security module across the entire bff-skills ecosystem.

> **Mainnet only.** All endpoints target Bitcoin and Stacks mainnet production infrastructure.

---

## What it does

Derives the sBTC signer wallet address trustlessly from the Stacks registry (no hardcoding), queries the confirmed BTC balance at that P2TR address via mempool.space, fetches total circulating sBTC supply from the `sbtc-token` contract, and computes a live reserve ratio. Outputs a `GREEN`/`YELLOW`/`RED`/`DATA_UNAVAILABLE` HODLMM safety signal and a 0-100 peg health score as structured JSON. The `runAudit()` export makes it importable as a shared security module by any other skill.

---

## Why agents need it

HODLMM bins concentrate liquidity into tight price ranges. If sBTC de-pegs, LPs face rapid principal loss with no time to exit manually. This skill gives autonomous agents a real-time, trustless answer to "Is sBTC fully backed right now?" before any HODLMM deposit, rebalance, or yield action — acting as a circuit breaker that halts operations when the peg is structurally under-collateralized.

---

## Safety notes

- **Read-only.** No transactions are submitted. No funds are moved.
- **Mainnet only.** All endpoints target Bitcoin and Stacks mainnet production infrastructure.
- Returns `DATA_UNAVAILABLE` (treated as `RED`) if any data source is unreachable — never returns a false `GREEN`.
- Refuses to output `GREEN` or `YELLOW` if BTC reserve balance or sBTC supply cannot be fetched.
- CoinGecko is used only for BTC/USD price display — the core reserve ratio is computed from on-chain data only.

---

## Why This Skill Exists

HODLMM bins concentrate liquidity into tight price ranges. If sBTC de-pegs due to a reserve imbalance, LPs face rapid principal loss with no time to exit manually. No existing skill in the ecosystem monitors peg health as a standalone, autonomous signal.

This oracle solves that by answering one question before any HODLMM action: **"Is sBTC fully backed right now?"**

---

## The "Golden Chain" — Trustless Verification in 4 Steps

This skill achieves trustless, on-chain verification without relying on any third-party oracle or price feed for its core reserve check:

```
1. Registry Sync     →  Fetch aggregate-pubkey from sbtc-registry (Stacks)
2. Taproot Derivation →  Derive the P2TR (bc1p...) BTC address via BIP-341 tweak
3. L1 Reserve Audit  →  Query confirmed BTC balance at that address (mempool.space)
4. L2 Supply Audit   →  Query total circulating sBTC supply (sbtc-token contract)
```

The reserve ratio `btc_reserve / sbtc_circulating` is computed from live on-chain data — not a price feed, not an estimate.

---

## HODLMM Safety Signal

The core output for agents is the `hodlmm_signal` field:

| Signal | Condition | Action |
|--------|-----------|--------|
| `GREEN` | reserve_ratio ≥ 0.999 | Safe to enter or maintain HODLMM bins |
| `YELLOW` | reserve_ratio ≥ 0.995 and < 0.999 | Monitor closely — do not add new liquidity |
| `RED` | reserve_ratio < 0.995 | CRITICAL — stop all HODLMM activity, exit bins |
| `DATA_UNAVAILABLE` | Reserve data could not be fetched | Treat as RED — do not proceed |

A `GREEN` signal means every sBTC in circulation is backed by at least 0.999 BTC on-chain. A `RED` means the peg is structurally under-collateralized and LP positions are at risk.

---

## Output contract

```json
{
  "status": "ok | warning | critical | error",
  "score": 95,
  "risk_level": "low | medium | high | unknown",
  "hodlmm_signal": "GREEN | YELLOW | RED | DATA_UNAVAILABLE",
  "reserve_ratio": 1.0002,
  "breakdown": {
    "price_deviation_pct": -0.12,
    "reserve_ratio": 1.0002,
    "mempool_congestion": "low",
    "fee_sat_vb": 2,
    "stacks_block_height": 7352346,
    "btc_block_height": 942340,
    "sbtc_circulating": 4062.003,
    "btc_reserve": 4062.004,
    "signer_address": "bc1p...",
    "btc_price_usd": 84000,
    "sbtc_price_usd": 83899,
    "peg_source": "sbtc/pbtc-pool"
  },
  "recommendation": "Peg is healthy. HODLMM entry is safe.",
  "alert": false
}
```

---

## Use Cases

### 1. Standalone CLI — Instant Health Check

Run directly to get a live peg snapshot:

```bash
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run
```

With a custom alert threshold:

```bash
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run --threshold 90
```

Exit codes: `0` = healthy, `1` = warning, `2` = critical, `3` = error.

---

### 2. Imported Module — Shared Security Layer

Any other skill can import `runAudit()` directly:

```ts
import { runAudit } from "../sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts"

const audit = await runAudit()

if (audit.hodlmm_signal !== "GREEN") {
  console.log("Peg unsafe — skipping operation")
  process.exit(1)
}
```

This is the recommended pattern for any skill that touches sBTC liquidity.

---

### 3. Pre-Flight Check Before HODLMM Rebalance

Pair with `hodlmm-bin-guardian` to gate all rebalance decisions behind a live reserve check:

```bash
# Step 1: Verify sBTC reserve is healthy
SIGNAL=$(bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run | jq -r .hodlmm_signal)

if [ "$SIGNAL" != "GREEN" ]; then
  echo "Reserve signal: $SIGNAL — rebalance blocked"
  exit 1
fi

# Step 2: Safe to proceed — check bin position
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run
```

---

### 4. Pre-Flight Check Before Bitflow Deposit

Gate any `bitflow:hodlmm-deposit` call:

```ts
import { runAudit } from "../sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts"

const audit = await runAudit()
if (audit.hodlmm_signal === "RED" || audit.hodlmm_signal === "DATA_UNAVAILABLE") {
  throw new Error(`sBTC reserve unsafe (${audit.hodlmm_signal}) — deposit blocked`)
}
// proceed with deposit
```

---

### 5. Composable Agent Pipeline

Any agent in the bff-skills ecosystem can wire this oracle into a decision tree:

```ts
import { runAudit } from "../sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts"

const { hodlmm_signal, score, reserve_ratio, breakdown } = await runAudit()

switch (hodlmm_signal) {
  case "GREEN":
    // full yield strategy — enter bins, compound rewards
    break
  case "YELLOW":
    // hold existing position, pause new deposits
    break
  case "RED":
  case "DATA_UNAVAILABLE":
    // emergency exit — close bins, alert operator
    break
}
```

---

## Pairing With hodlmm-bin-guardian

| Skill | Role |
|-------|------|
| `sbtc-proof-of-reserve` | **Security layer** — verifies sBTC is fully backed before any action |
| `hodlmm-bin-guardian` | **Position layer** — checks if LP bins are in the active earning range |

Used together, these two skills cover both risk vectors for HODLMM LPs:
- **Asset risk** (is sBTC safe?) → `sbtc-proof-of-reserve`
- **Position risk** (are my bins earning?) → `hodlmm-bin-guardian`

Neither skill replaces the other. Run the oracle first, then the guardian.

---

## Data Sources

| Source | Data | Endpoint |
|--------|------|----------|
| Hiro Stacks API | sBTC circulating supply, signer aggregate pubkey, block heights | `api.mainnet.hiro.so` |
| mempool.space | Signer P2TR wallet BTC balance, fee environment | `mempool.space/api` |
| Bitflow Ticker API | sBTC/pBTC price ratio (or sBTC/STX fallback) | `bitflow-sdk-api-gateway-*.uc.gateway.dev` |
| CoinGecko | BTC/USD spot price | `api.coingecko.com` |

All endpoints are **mainnet production**. No testnet support.

---

## Commands

### doctor

Verifies all four data sources are reachable and the P2TR derivation succeeds.

```bash
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts doctor
```

### install-packs

No additional packs required — fully self-contained.

```bash
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts install-packs
```

### run

Fetch live data, compute reserve ratio and peg score, output JSON.

```bash
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run
bun run sbtc-proof-of-reserve/sbtc-proof-of-reserve.ts run --threshold 90
```
