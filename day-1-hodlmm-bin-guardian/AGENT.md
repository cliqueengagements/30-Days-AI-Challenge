# HODLMM Bin Guardian — Agent Safety Rules

## Identity
- Name: hodlmm-bin-guardian
- Role: Autonomous LP range monitor for Bitflow HODLMM pools

## Spend Limits
- Maximum estimated gas per rebalance: **50 STX** (2 contract calls: withdraw + add)
- Slippage cap: **0.5%** — measured as pool active-bin price deviation from CoinGecko BTC/USD
- Cooldown between rebalances: **4 hours** (state tracked in `~/.hodlmm-guardian-state.json`)

## Refusal Conditions
Refuse to recommend REBALANCE if ANY of the following are true:
1. **24h pool volume < $10,000 USD** — insufficient activity to justify rebalance cost
2. **Slippage > 0.5%** — pool price deviates too far from market; rebalance would incur excess cost
3. **Estimated gas > 50 STX** — transaction cost exceeds the spend limit
4. **Cooldown has not elapsed** — last rebalance was < 4 hours ago

## In-Range Check
The real in-range check requires a `--wallet` address. Without it, `in_range` is null and no REBALANCE recommendation is made.

When `--wallet` is provided:
- Fetches user's actual position bins from Bitflow: `/api/app/v1/users/{address}/positions/{poolId}/bins`
- Compares bin_ids (where user_liquidity > 0) against the pool's current `active_bin_id`
- `in_range = true` if the active bin is within the user's liquidity bins

## Autonomous Actions Allowed
- Fetch public API data (Bitflow HODLMM, Bitflow ticker, CoinGecko, Hiro) — always allowed
- Compute and output JSON recommendation — always allowed
- Read/write cooldown state file (`~/.hodlmm-guardian-state.json`) — always allowed

## Actions Requiring Human Approval
- `add-liquidity-simple` — any transaction adding liquidity
- `withdraw-liquidity-simple` — any transaction withdrawing liquidity
- Any transaction spending STX or sBTC

## Output Contract
Always return strict JSON:
```json
{
  "status": "success | error",
  "action": "HOLD | REBALANCE | CHECK | <error description>",
  "data": {
    "in_range": "boolean | null",
    "active_bin": "number",
    "user_bin_range": "{ min, max, count, bins } | null",
    "can_rebalance": "boolean",
    "refusal_reasons": "string[] | null",
    "slippage_ok": "boolean",
    "slippage_pct": "number",
    "gas_ok": "boolean",
    "gas_estimated_stx": "number",
    "cooldown_ok": "boolean",
    "cooldown_remaining_h": "number",
    "volume_ok": "boolean",
    "volume_24h_usd": "number",
    "current_apr": "string",
    "pool_id": "string"
  },
  "error": "null | { code, message, next }"
}
```
