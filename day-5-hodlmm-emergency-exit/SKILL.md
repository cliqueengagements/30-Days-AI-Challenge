---
name: hodlmm-emergency-exit
description: "Autonomous capital protection for HODLMM LP positions. Composes sbtc-proof-of-reserve (peg safety) and bin-range analysis into a single exit decision engine. When sBTC reserve is RED or bins drift out of range beyond the grace period, outputs executable MCP withdrawal commands to remove all liquidity. The defensive counterpart to HODLMM yield strategies."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "true"
  arguments: "doctor | install-packs | run --wallet <STX_ADDRESS> [--pool-id <id>] [--confirm]"
  entry: "hodlmm-emergency-exit/hodlmm-emergency-exit.ts"
  requires: "sbtc-proof-of-reserve (co-located at ../sbtc-proof-of-reserve/ — imports runAudit(), AuditResult, HodlmmSignal)"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure"
---

# HODLMM Emergency Exit

**Autonomous capital protection for HODLMM LP positions.**

The defensive counterpart to HODLMM yield strategies. When the sBTC peg is structurally at risk or bins have drifted out of the earning range, this skill outputs executable MCP withdrawal commands to remove all liquidity before losses compound.

> **Write-capable.** This skill generates `bitflow_hodlmm_remove_liquidity` MCP commands. Mainnet only.

---

## Why agents need it

HODLMM bins concentrate liquidity into tight price ranges. If sBTC de-pegs or bins drift out of range, LPs face rapid principal loss with no time to exit manually. Existing skills can detect these conditions (bin-guardian monitors range, proof-of-reserve monitors peg), but no skill acts on them. An autonomous agent needs a circuit breaker that converts a RED signal into an actual withdrawal — not just an alert. This skill closes that gap: detect danger AND exit before losses compound.

---

## What it does

Composes two data sources into a single exit decision:

1. **sBTC Proof-of-Reserve** — imports `runAudit()` from the co-located `sbtc-proof-of-reserve` skill to check whether sBTC is fully backed on-chain.
2. **HODLMM bin position** — queries Bitflow HODLMM API to check if the user's LP bins are in the active earning range.

Based on these inputs, the decision engine outputs one of three actions:

| Decision | Condition | Action |
|----------|-----------|--------|
| `HOLD` | GREEN + in range | Do nothing. Position is safe and earning. |
| `WARN` | YELLOW, or out-of-range < grace period | Alert operator. Do not add liquidity. Monitor. |
| `EXIT` | RED / DATA_UNAVAILABLE, or out-of-range > grace period | Remove all liquidity via MCP command. |

---

## The Trilogy — Three Skills, One Pipeline

| Skill | Role | Day |
|-------|------|-----|
| `hodlmm-bin-guardian` | **Detect** — are bins in range? | Day 3 winner |
| `sbtc-proof-of-reserve` | **Assess** — is sBTC fully backed? | Day 5 (PR #97) |
| `hodlmm-emergency-exit` | **Act** — remove liquidity when unsafe | Day 5 (this PR) |

No other competitor can compose merged skills into this pipeline because no other competitor has both the monitor and the oracle in the registry.

---

## Safety notes

- **Write-capable** — generates `bitflow_hodlmm_remove_liquidity` MCP commands.
- **--confirm required** — without this flag, the skill runs in dry-run mode (evaluates but does not output executable commands).
- **30-minute cooldown** between exits prevents rapid-fire withdrawals from transient conditions.
- **50 STX gas cap** — refuses to execute if estimated gas exceeds this limit.
- **Error = EXIT** — if the reserve oracle or position API fails, the skill treats this as a RED condition. Never returns a false HOLD.
- State persisted in `~/.hodlmm-emergency-exit-state.json` — tracks exit history and out-of-range duration.

---

## Output contract

```json
{
  "status": "success | blocked | error",
  "decision": "HOLD | WARN | EXIT",
  "action": "human-readable action string",
  "data": {
    "reserve_audit": { "...full AuditResult from sbtc-proof-of-reserve..." },
    "position_check": {
      "has_position": true,
      "in_range": false,
      "active_bin": 518,
      "user_bins": [500, 504, 508],
      "user_bin_count": 3
    },
    "exit_reason": "string or null",
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
    "out_of_range_hours": 2.5
  },
  "error": null
}
```

---

## Use Cases

### 1. Standalone CLI — Dry Run

```bash
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts run \
  --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY
```

Exit codes: `0` = HOLD, `1` = WARN, `2` = EXIT, `3` = error.

### 2. Standalone CLI — Execute Exit

```bash
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts run \
  --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY \
  --confirm
```

### 3. Imported Module — Composable Safety Gate

```ts
import { evaluateExit } from "../hodlmm-emergency-exit/hodlmm-emergency-exit.ts"

const result = await evaluateExit({ wallet: "SP...", poolId: "dlmm_1" })
if (result.decision === "EXIT") {
  // Execute result.data.mcp_commands
}
```

### 4. Pre-Deposit Gate

```ts
import { evaluateExit } from "../hodlmm-emergency-exit/hodlmm-emergency-exit.ts"

const check = await evaluateExit({ wallet: "SP..." })
if (check.decision !== "HOLD") {
  throw new Error(`Unsafe to deposit: ${check.action}`)
}
// proceed with deposit
```

---

## Data Sources

| Source | Data | Endpoint |
|--------|------|----------|
| sbtc-proof-of-reserve | Reserve ratio, HODLMM signal, peg score | Composed (Hiro + mempool.space + Bitflow) |
| Bitflow HODLMM API | Pool stats, active bin, user position bins | `bff.bitflowapis.finance` |
| Hiro Stacks API | Gas fee estimate | `api.mainnet.hiro.so` |

---

## Commands

### doctor

Verifies reserve oracle, HODLMM API, fee API, and state file.

```bash
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts doctor
```

### install-packs

No additional packs required.

```bash
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts install-packs
```

### run

Evaluate position and optionally execute emergency exit.

```bash
bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts run --wallet <STX_ADDRESS> [--pool-id <id>] [--confirm]
```
