---
name: zbg-alpha-engine
description: "Cross-protocol yield executor for Zest, Granite, and HODLMM with sBTC Proof-of-Reserve verification and multi-gate safety pipeline"
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "scan --wallet <SP...> | deploy --wallet <SP...> --protocol <zest|granite|hodlmm> --amount <sats> | withdraw --wallet <SP...> --protocol <name> | rebalance --wallet <SP...> --pool-id <dlmm_N> | migrate --wallet <SP...> --from <protocol> --to <protocol> | emergency --wallet <SP...> | doctor"
  entry: "zbg-alpha-engine/zbg-alpha-engine.ts"
  requires: "wallet, signing, settings"
  tags: "defi, yield, hodlmm, zest, granite, sbtc, proof-of-reserve, rebalance, executor"
---

# ZBG Alpha Engine

## What it does

Cross-protocol yield executor for **sBTC, STX, and USDCx** across Zest v2, Granite, and HODLMM (Bitflow DLMM). Scans wallet balances and positions across all three protocols, compares yield options for each asset, verifies sBTC reserve integrity via BIP-341 P2TR derivation, checks market safety gates (slippage, volume, gas, cooldown), then executes deploy/withdraw/rebalance/migrate/emergency operations. Every write runs a mandatory 6-gate safety pipeline: Scout -> Reserve -> Guardian -> Executor. No bypasses.

**Asset coverage:**

| Asset | Scan | Deploy targets | Pools |
|-------|------|---------------|-------|
| sBTC | Wallet + Zest + Granite + HODLMM | Zest v2, Granite lending, HODLMM (sBTC-USDCx, STX-sBTC) | 3 protocols |
| STX | Wallet + HODLMM | HODLMM (STX-USDCx 10/4/1bps, STX-sBTC 15bps) | 4 pools |
| USDCx | Wallet + HODLMM | HODLMM one-sided below active bin (all USDCx-paired pools) | 5 pools |

## Why agents need it

Agents holding sBTC, STX, or USDCx currently have to manually check each protocol, compare yields across different assets, verify the sBTC peg is safe, and execute transactions one at a time. ZBG Alpha Engine does all of this in a single pipeline — scan 3 protocols in parallel for all three assets, verify reserves are cryptographically sound, check 6 market safety gates, then move capital to the highest-yielding opportunity. It also handles emergencies: if the sBTC peg breaks, one `emergency` command withdraws everything across all protocols. No other skill combines cross-protocol reads, writes, AND cryptographic reserve verification.

## Safety notes

- Every write command runs the full safety pipeline: Scout (read state) -> PoR (verify sBTC backing) -> Guardian (6 gates) -> Executor. No gate can be skipped or bypassed.
- PoR RED or DATA_UNAVAILABLE blocks ALL writes and suggests emergency withdrawal.
- PoR YELLOW blocks all writes (read-only mode).
- Guardian gates: slippage <=0.5%, 24h volume >=$10K, gas <=50 STX, 4h rebalance cooldown, price source availability.
- Crypto self-test failure (bech32m vectors or P2TR derivation) blocks ALL operations including reads.
- Post-conditions on all `call_contract` writes prevent unexpected token transfers.
- Deploy refuses to send more than wallet balance. Refuses 0% APY protocols unless explicitly forced.
- Emergency command bypasses Guardian (speed matters) but NEVER bypasses PoR.
- Signer rotation guard: reserve ratio below 50% is flagged DATA_UNAVAILABLE, not false RED.
- Engine outputs transaction instructions — does not hold keys or sign directly. Agent runtime executes via MCP.
- Granite collateral removal blocked by trait_reference. Workaround: `repay` drops LTV to 0.

## Output contract

All commands output JSON to stdout:

```json
{
  "status": "ok" | "refused" | "partial" | "error",
  "command": "scan" | "deploy" | "withdraw" | "rebalance" | "migrate" | "emergency",
  "scout": { "status", "wallet", "balances", "positions", "options", "best_move", "break_prices", "data_sources" },
  "reserve": { "signal": "GREEN|YELLOW|RED|DATA_UNAVAILABLE", "reserve_ratio", "score", "sbtc_circulating", "btc_reserve", "signer_address", "recommendation" },
  "guardian": { "can_proceed", "refusals", "slippage", "volume", "gas", "cooldown", "relay", "prices" },
  "action": { "description", "txids", "details": { "instructions": [...] } },
  "refusal_reasons": ["..."],
  "error": "..."
}
```

- `status: "ok"` — operation completed or instructions ready
- `status: "refused"` — safety gate blocked the write, `refusal_reasons` explains why
- `status: "error"` — invalid input or system failure
- `doctor` outputs `{ "status": "ok"|"degraded"|"critical", "checks": [...], "message" }`
- Error output: `{ "status": "error", "error": "descriptive message" }`

## Architecture

| Module | Source | Role |
|--------|--------|------|
| **Scout** | zbg-yield-scout (PR #191) | Wallet scan, positions, yields, break prices |
| **Reserve** | sbtc-proof-of-reserve (PR #131) | P2TR derivation, BTC balance, GREEN/YELLOW/RED signal |
| **Guardian** | hodlmm-bin-guardian (PR #39, Day 3 winner) | Slippage, volume, gas, cooldown, relay, price gates |
| **Executor** | New | deploy, withdraw, rebalance, migrate, emergency |

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `scan` | read | Full report: wallet, positions, yields, break prices, PoR status, guardian gates |
| `deploy` | write | Deploy idle sBTC to highest-APY protocol |
| `withdraw` | write | Pull capital from a specific protocol |
| `rebalance` | write | Withdraw out-of-range HODLMM bins, re-add centered on active bin |
| `migrate` | write | Cross-protocol capital movement (withdraw A + deposit B) |
| `emergency` | write | Withdraw ALL positions across all protocols (bypasses guardian) |
| `doctor` | read | 10 self-tests: crypto vectors, data sources, PoR, on-chain reads |

## Write Paths

| Protocol | Deposit | Withdraw | Method |
|----------|---------|----------|--------|
| Zest v2 | `zest_supply` | `zest_withdraw` | MCP native |
| Granite | `call_contract` -> `liquidity-provider-v1.deposit` | `.withdraw` / `.redeem` | No trait_reference needed |
| HODLMM | `bitflow add-liquidity-simple` | `bitflow withdraw-liquidity-simple` | Bitflow skill |

## Safety Pipeline (every write)

1. **Scout** reads wallet + 3 protocols + yields + prices
2. **Reserve (PoR)** verifies sBTC is fully backed by real BTC
3. **Guardian** checks 6 gates: slippage (<=0.5%), volume (>=$10K), gas (<=50 STX), cooldown (4h), relay health, price sources
4. All pass -> **Executor** outputs transaction instructions
5. Any fail -> refuse with specific reasons, no transaction

### PoR Signal Thresholds

| Reserve Ratio | Signal | Engine Action |
|---------------|--------|---------------|
| >= 99.9% | GREEN | Execute writes normally |
| 99.5-99.9% | YELLOW | Read-only, refuse all writes |
| < 99.5% | RED | Emergency withdrawal recommended |
| < 50% | DATA_UNAVAILABLE | Likely signer key rotation, not real shortfall |

## Emergency Exit Coverage

| Risk | Detection | Exit Path | Limitation |
|------|-----------|-----------|------------|
| HODLMM out of range | Guardian: active bin vs user bins | `withdraw-liquidity-simple` | None |
| sBTC peg break | PoR: reserve ratio < 99.5% | Withdraw all 3 protocols | None |
| Granite liquidation | Scout: LTV approaching 65% | `borrower-v1.repay` (LTV -> 0) | Cannot remove collateral directly |
| Break price approaching | Scout: current price vs bin edges | Withdraw before breach | None |
| Zest rate drops | Scout: live `get-utilization` read | `zest_withdraw` + redeploy | None |
| Signer key rotation | PoR: ratio < 50% | DATA_UNAVAILABLE (not false RED) | Cannot distinguish from exploit below 50% |

## Known Limitations

### Granite Collateral Removal (Partial Gap)
Granite `borrower-v1.remove-collateral` requires `trait_reference` encoding not yet supported by MCP `call_contract`. **Workaround:** `repay` drops LTV to 0, achieving equivalent safety. Granite supply/withdraw work fully. Alpha Engine scope is yield optimization, not leveraged borrowing.

### No PnL Tracking
Reports current on-chain position value, not deposit cost basis. Profit/loss tracking requires transaction history indexing.

### Non-Atomic Rebalance
HODLMM rebalance is 2 transactions (withdraw + re-add). If tx 1 confirms but tx 2 fails, capital sits safely in wallet. Engine retries tx 2.

### Signer Rotation Edge Case
If sBTC signer aggregate pubkey rotates and BTC has not fully migrated to the new P2TR address, PoR may read near-zero reserves. Guard: ratio below 50% is flagged as `DATA_UNAVAILABLE` rather than `RED`.

## Data Sources (11 live reads)

| Source | Data | Endpoint |
|--------|------|----------|
| Hiro Stacks API | STX balance, contract reads | `api.mainnet.hiro.so` |
| Tenero API | sBTC/STX prices | `api.tenero.io` |
| Zest v2 Vault | Supply position, utilization, interest rate | On-chain `v0-vault-sbtc` |
| Granite Protocol | Supply/borrow/IR params, user position | On-chain `state-v1`, `linear-kinked-ir-v1` |
| HODLMM Pool | User bins, balances, active bin | Direct pool reads (8 pools) |
| Bitflow App API | HODLMM APR, TVL, volume, token prices | `bff.bitflowapis.finance` |
| DLMM Core | Bin price calculations | On-chain `dlmm-core-v-1-1` |
| mempool.space | BTC balance at signer P2TR address | `mempool.space/api` |
| sbtc-registry | Signer aggregate pubkey | On-chain Stacks contract |
| sbtc-token | Total sBTC supply | On-chain Stacks contract |

## Dependencies

- `commander` (CLI parsing, registry convention)
- `tiny-secp256k1` (BIP-341 elliptic curve point addition — see note below)
- Node.js built-ins: `crypto` (SHA-256), `os`/`path`/`fs` (cooldown state) — same pattern as Day 3 winner hodlmm-bin-guardian
- All bech32m encoding is hand-rolled (no external bech32 library)

### Why `tiny-secp256k1`?

The sBTC Proof-of-Reserve module derives the signer's Bitcoin P2TR address from the aggregate pubkey registered on Stacks. This requires a BIP-341 Taproot key tweak: `output_key = internal_key + H_TapTweak(internal_key) * G`. The tweak operation is elliptic curve point addition on secp256k1 — Node.js/Bun `crypto` module supports ECDSA signing and ECDH key agreement but does **not** expose raw EC point addition. This single operation cannot be implemented without either:

1. An EC library (`tiny-secp256k1`, `@noble/secp256k1`), or
2. Hand-rolling secp256k1 field arithmetic (~400 lines, security anti-pattern for production crypto)

`tiny-secp256k1` is the same library used by `bitcoinjs-lib`, `@scure/btc-signer`, and the Bitcoin ecosystem at large. It provides exactly one function we need: `xOnlyPointAddTweak()`. The alternative `@noble/secp256k1` (pure JS, no native bindings) is a drop-in replacement if preferred.

## Doctor Self-Tests (10 checks)

1. BIP-350 bech32m test vectors
2. P2TR derivation from known G point
3. Hiro Stacks API
4. Tenero Price Oracle
5. Bitflow HODLMM API
6. mempool.space
7. sBTC Proof of Reserve (full golden chain)
8. Zest v2 sBTC Vault
9. Granite Protocol
10. HODLMM Pool Contracts

If crypto self-tests (1-2) fail, engine refuses all operations.

## x402 Paid Endpoints

ZBG Alpha Engine is free to run directly from the registry. For agents that want instant results without running their own node or waiting for 11 API calls, paid x402 endpoints are available:

| Endpoint | What you get | Price | Pays back in |
|----------|-------------|-------|-------------|
| `/scan` | Full 7-section report: wallet, positions, yields, PoR, break prices, safety gates | 500 sats | ~5 min of yield difference |
| `/reserve` | sBTC Proof-of-Reserve check: GREEN/YELLOW/RED signal with reserve ratio | 100 sats | Avoiding one bad trade |
| `/break-prices` | HODLMM range exit prices + safety buffer | 200 sats | One rebalance save |
| `/guardian` | 6-gate pre-flight safety check | 100 sats | One blocked bad tx |

All endpoints return the same JSON output as the CLI. x402 protocol shows price before payment — no surprises.

## Disclaimers

### Financial Disclaimer
ZBG Alpha Engine provides data-driven yield analysis for informational purposes only. This is not financial advice. Users are solely responsible for their own investment decisions. Past yields do not guarantee future returns. Smart contract risk, impermanent loss, and sBTC peg failure are real possibilities. Always verify on-chain data independently before acting.

### Accuracy Disclaimer
Data is live but not guaranteed. Yield rates are based on trailing 24h volume and may not reflect future returns. Position values use Bitflow-reported TVL which may lag real-time. PoR checks confirmed UTXO balances only — pending transactions are not reflected. Signer key rotation may cause temporary false readings. The engine reads 11 data sources; if any are unavailable, output may be incomplete (status: "degraded").
