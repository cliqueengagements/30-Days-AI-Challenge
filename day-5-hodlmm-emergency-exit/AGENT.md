---
name: hodlmm-emergency-exit
skill: hodlmm-emergency-exit
description: "Autonomous capital protection agent for HODLMM LP positions. Evaluates sBTC reserve health and bin range status, then executes emergency liquidity withdrawal when conditions are unsafe. Write-capable with strict safety gates."
---

# HODLMM Emergency Exit — Agent Safety Rules

## Identity
- Name: hodlmm-emergency-exit
- Role: Autonomous HODLMM capital protection — evaluate and execute emergency LP withdrawal
- Network: Mainnet only

## Guardrails

- **Withdrawal only.** This skill can only remove liquidity. It cannot add liquidity, swap tokens, or move funds to other addresses.
- **--confirm required.** Without the `--confirm` flag, the skill evaluates but does NOT output executable MCP commands. Dry-run by default.
- **30-minute cooldown.** After any exit, the skill refuses to execute again for 30 minutes. Prevents rapid-fire exits from transient conditions.
- **50 STX gas cap.** Refuses to execute if estimated gas exceeds 50 STX.
- **0.01 STX minimum balance.** Refuses to execute if wallet STX balance is insufficient for gas.
- **Error = RED.** If the reserve oracle or position API fails, the decision defaults to EXIT with `status: "error"`. Never returns a false HOLD when data is unavailable.

**Call breakdown per `run`:**
1. sbtc-proof-of-reserve `runAudit()` — 5-6 network calls (Hiro, mempool.space, Bitflow, CoinGecko)
2. Bitflow HODLMM pools API — pool stats and active bin
3. Bitflow HODLMM bins API — active bin verification
4. Bitflow HODLMM user positions API — user's bin positions
5. Hiro fees API — gas estimate
6. Total: 9-10 network calls per run

---

## Decision order

### Autonomous actions (always allowed)
- Fetch public API data (Bitflow, Hiro, mempool.space, CoinGecko) — read-only
- Run sbtc-proof-of-reserve audit — read-only
- Compute exit decision (HOLD/WARN/EXIT) — local computation
- Output JSON result with breakdown — always allowed
- Write state to `~/.hodlmm-emergency-exit-state.json` — local file only

### Actions requiring --confirm flag
- **Output executable MCP withdrawal commands** — only when `--confirm` is passed AND all safety gates pass (cooldown, gas cap, position exists)

### Actions requiring human approval
- **Actual execution of MCP commands** — the skill outputs commands, but a human or orchestrator must execute them. The skill itself does not call Bitflow contracts directly.

---

## Guardrails — Refusal Conditions

Refuse to output executable MCP commands if ANY of the following are true:

1. **--confirm not passed** — dry-run only, no executable output
2. **Cooldown active** — less than 30 minutes since last exit
3. **Gas exceeds cap** — estimated gas > 50 STX
4. **No position found** — nothing to withdraw
5. **Invalid wallet address** — does not match STX address pattern

In all refusal cases, `status: "blocked"` is returned with `refusal_reasons` listing every gate that failed.

---

## HODLMM Safety Thresholds

The exit decision is derived from the sBTC reserve signal and bin position:

| Reserve Signal | Bins In Range | Decision | Action |
|---------------|---------------|----------|--------|
| GREEN | Yes | HOLD | Position safe. Do nothing. |
| GREEN | No (<2h) | WARN | Monitor. Bins drifting. |
| GREEN | No (>2h) | EXIT | Out of range too long. Withdraw. |
| YELLOW | Any | WARN | Peg degraded. Do not add liquidity. |
| RED | Any | EXIT | Peg unsafe. Withdraw immediately. |
| DATA_UNAVAILABLE | Any | EXIT | Cannot verify safety. Withdraw. |

---

## Output Contract

Always return strict JSON. Never return partial JSON or plain text.

**Success (HOLD/WARN):**
```json
{
  "status": "success",
  "decision": "HOLD | WARN",
  "action": "human-readable action string",
  "data": {
    "reserve_audit": { "...AuditResult..." },
    "position_check": {
      "has_position": true,
      "in_range": true,
      "active_bin": 518,
      "user_bins": [516, 518, 520],
      "user_bin_count": 3
    },
    "exit_reason": null,
    "refusal_reasons": [],
    "mcp_commands": [],
    "cooldown_ok": true,
    "cooldown_remaining_min": 0,
    "gas_ok": true,
    "gas_estimated_stx": 0.0002,
    "pool_id": "dlmm_1",
    "wallet": "SP...",
    "confirm_required": false,
    "out_of_range_hours": null
  },
  "error": null
}
```

**EXIT (with executable commands):**
```json
{
  "status": "success",
  "decision": "EXIT",
  "action": "EXIT — Reserve signal RED — sBTC peg unsafe (reserve_ratio: 0.993, score: 0)",
  "data": {
    "reserve_audit": { "status": "critical", "score": 0, "hodlmm_signal": "RED", "reserve_ratio": 0.993, "..." : "..." },
    "position_check": {
      "has_position": true,
      "in_range": true,
      "active_bin": 518,
      "user_bins": [500, 504, 508],
      "user_bin_count": 3
    },
    "exit_reason": "Reserve signal RED — sBTC peg unsafe",
    "refusal_reasons": [],
    "mcp_commands": [
      {
        "step": 1,
        "tool": "bitflow_hodlmm_remove_liquidity",
        "description": "EMERGENCY EXIT: Remove all liquidity from dlmm_1 bins [500, 504, 508]",
        "params": { "poolId": "dlmm_1", "binIds": [500, 504, 508] }
      }
    ],
    "cooldown_ok": true,
    "cooldown_remaining_min": 0,
    "gas_ok": true,
    "gas_estimated_stx": 0.0002,
    "pool_id": "dlmm_1",
    "wallet": "SP...",
    "confirm_required": false,
    "out_of_range_hours": null
  },
  "error": null
}
```

**Blocked:**
```json
{
  "status": "blocked",
  "decision": "EXIT",
  "action": "EXIT BLOCKED — Exit cooldown active (15 min remaining)",
  "data": {
    "reserve_audit": { "status": "critical", "score": 0, "hodlmm_signal": "RED", "..." : "..." },
    "position_check": { "has_position": true, "in_range": true, "..." : "..." },
    "exit_reason": "Reserve signal RED — sBTC peg unsafe",
    "refusal_reasons": ["Exit cooldown active (15 min remaining)"],
    "mcp_commands": [],
    "cooldown_ok": false,
    "cooldown_remaining_min": 15,
    "gas_ok": true,
    "gas_estimated_stx": 0.0002,
    "pool_id": "dlmm_1",
    "wallet": "SP...",
    "confirm_required": false,
    "out_of_range_hours": null
  },
  "error": null
}
```

**Error:**
```json
{
  "status": "error",
  "decision": "EXIT",
  "action": "ERROR — EVALUATION_FAILED: message. Treat as EXIT — do not proceed with HODLMM operations.",
  "data": {
    "reserve_audit": null,
    "position_check": null,
    "exit_reason": "EVALUATION_FAILED: message",
    "refusal_reasons": [],
    "mcp_commands": [],
    "cooldown_ok": false,
    "cooldown_remaining_min": 0,
    "gas_ok": false,
    "gas_estimated_stx": 0,
    "pool_id": "dlmm_1",
    "wallet": "SP...",
    "confirm_required": false,
    "out_of_range_hours": null
  },
  "error": "descriptive message"
}
```

---

## Composability

When called programmatically via `evaluateExit()`, consuming agents should check:

- `result.decision === "HOLD"` → safe to proceed with HODLMM operations
- `result.decision === "WARN"` → hold positions, pause new deposits
- `result.decision === "EXIT"` → execute `result.data.mcp_commands` to withdraw
- `result.status === "blocked"` → exit needed but safety gate prevents it
- `result.status === "error"` → treat as EXIT, alert operator
- `process.exitCode === 2` → EXIT condition
- `process.exitCode === 1` → WARN condition
