# Day 15 Sbtc Capital Allocator

This skill is a submission for #Skill Idea 2 - sBTC Yield Maximizer

## Skill Name

sbtc-capital-allocator

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

Two-layer sBTC yield routing skill. Layer 1 (WHERE): compares real-time APY across HODLMM pools (7-day smoothed fees/TVL) and Zest lending (on-chain \`current-liquidity-rate\`) to pick the highest risk-adjusted yield. Layer 2 (HOW): determines whether to deploy via lump sum or DCA based on risk signals — Pyth oracle divergence, mempool whale activity, fee spikes, and pool risk scores. DCA is not a third yield protocol; it's an execution strategy that controls entry timing when conditions are volatile.

## On-chain proof

### Full decision chain: scan → recommend → execute → deploy

The skill recommended HODLMM dlmm_1. Capital was routed to HODLMM dlmm_1. Every step proven on mainnet.

**Step 1 — scan** (live APY comparison):
\`\`\`json
{
  "yields": [
    { "protocol": "hodlmm", "pool": "dlmm_1", "apy_pct": 12.84, "tvl_usd": 192915.88, "source": "bitflow_api_live", "fee_spike": false },
    { "protocol": "zest", "pool": "sbtc-lending", "apy_pct": 0.16, "source": "onchain_read", "fee_spike": false }
  ],
  "best": { "protocol": "hodlmm", "pool": "dlmm_1", "apy_pct": 12.84 }
}
\`\`\`

**Step 2 — recommend** (two-layer decision):
\`\`\`json
{
  "recommendation": {
    "target_protocol": "hodlmm",
    "target_pool": "dlmm_1",
    "target_apy_pct": 12.84,
    "action": "move",
    "execution_mode": "dca",
    "dca_intervals": 5,
    "dca_reason": "Risk signals detected: high risk pool (score 4/5). Splitting deployment into 5 intervals.",
    "reason": "No current position — deploy to hodlmm/dlmm_1 at 12.84% APY"
  }
}
\`\`\`

**Step 3 — execute --confirm** (emit MCP command):
\`\`\`json
{
  "target_protocol": "hodlmm",
  "target_pool": "dlmm_1",
  "execution_mode": "dca",
  "dca_per_interval_sats": 200,
  "mcp_commands": [{
    "tool": "call_contract",
    "params": {
      "contractAddress": "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD",
      "contractName": "dlmm-liquidity-router-v-1-1",
      "functionName": "add-relative-liquidity-multi",
      "functionArgs": [{ "type": "list", "value": [{ "type": "tuple", "value": {
        "active-bin-id-offset": { "type": "int", "value": 0 },
        "x-amount": { "type": "uint", "value": 200 },
        "min-dlp": { "type": "uint", "value": 190 },
        "max-x-liquidity-fee": { "type": "uint", "value": 10 },
        "max-y-liquidity-fee": { "type": "uint", "value": 10 }
      }}]}]
    }
  }],
  "decision_audit": { "oracle_verified": true }
}
\`\`\`

**Step 4 — agent calls MCP tool** (capital deployed):

| Route | Txid | Explorer |
|---|---|---|
| **HODLMM dlmm_1** (skill recommended) | \`1a4b7bb5c63f6de21608733fe825ec0757ecbc7d7e0dd362ea2d875dc7ad2bfe\` | [View](https://explorer.hiro.so/txid/1a4b7bb5c63f6de21608733fe825ec0757ecbc7d7e0dd362ea2d875dc7ad2bfe?chain=mainnet) |
| **Zest sBTC supply** (alternate route) | \`fca71f20091ad52f4bad69718f66deafa0cc4d3e39248722121e465af6df854e\` | [View](https://explorer.hiro.so/txid/fca71f20091ad52f4bad69718f66deafa0cc4d3e39248722121e465af6df854e?chain=mainnet) |

Both write routes proven on mainnet. Wallet: \`SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY\`

## Does this integrate HODLMM?

- [x] Yes — eligible for the HODLMM bonus

Reads all HODLMM sBTC pool data (TVL, fees, volume, APR) from Bitflow API. Computes 7-day smoothed APY, cross-validates against Bitflow's full-period \`apr\`. Filters micro-pools (<\$10K TVL). Detects fee spikes (1d > 3x 7d avg). Monitors LP range drift via active bin vs position bins. Execute emits \`call_contract\` with \`add-relative-liquidity-multi\` on the DLMM router — fully computed args including active bin offset, token traits, and 95%/5% slippage protection.

## Key features

- **Two-layer decision function** — separates allocation (WHERE: HODLMM vs Zest) from execution timing (HOW: lump_sum vs DCA). Most yield tools only answer "where." This skill also answers "when and how fast."
- **HODLMM write capability** — emits \`call_contract\` with fully computed \`add-relative-liquidity-multi\` args: active bin offset, token traits, min-dlp 95%, max-fee 5%. Proven on mainnet.
- **7-day smoothed APY** — \`(feesUsd7d / 7) / tvlUsd * 365\` avoids stale-TVL bias from 1-day snapshots, cross-validated against Bitflow's full-period \`apr\` at 30% divergence threshold
- **Zest on-chain rate** — reads \`current-liquidity-rate\` from \`pool-borrow-v2-3.get-reserve-state\` (1e6 precision, already annualized)
- **Pyth oracle two-tier gate** — >2% divergence = hard block, 1-2% = DCA mode. Checks both price divergence AND data freshness (>120s = stale)
- **Mempool whale tracking** — scans Stacks mempool via Hiro API for pending HODLMM liquidity moves, Zest supply/withdraw, and sBTC transfers. Detects repositioning BEFORE it settles on-chain
- **LP range drift monitor** — compares active bin to position bins, flags warning (within 3 bins of edge) or critical (out of range)
- **Fee spike detection** — 1-day fees > 3x 7-day daily average = hard block in both recommend and execute
- **TVL impact gate** — blocks execution if deploy amount exceeds 5% of pool TVL
- **DCA execution strategy** — triggered by 5 risk signals (whale pressure, oracle divergence, fee spikes, high-risk pool). Splits deployment into 5 intervals with per-interval sizing
- **Decision audit trail** — execute outputs full \`decision_audit\` block showing all yields, risk-adjusted rankings, and oracle verification timestamp
- **6 commands** — install-packs, doctor, scan, monitor, recommend, execute. Full progression from pre-flight to deployment

## Registry compatibility checklist

- [x] \`SKILL.md\` uses \`metadata:\` nested frontmatter (not flat keys)
- [x] \`AGENT.md\` starts with YAML frontmatter (\`name\`, \`skill\`, \`description\`)
- [x] \`tags\` and \`requires\` are comma-separated quoted strings, not YAML arrays
- [x] \`user-invocable\` is a quoted string (\`"false"\`)
- [x] \`entry\` path is repo-root-relative (no \`skills/\` prefix)
- [x] \`metadata.author\` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses \`{ "error": "descriptive message" }\` format

## Smoke test results

<details>
<summary>doctor output</summary>

\`\`\`json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "ready": true,
    "checks": [
      { "name": "wallet", "ok": true, "detail": "sBTC: 0.00185666, STX: 38.587744" },
      { "name": "bitflow_api", "ok": true, "detail": "3 sBTC HODLMM pools found" },
      { "name": "zest_onchain", "ok": true, "detail": "Supplied (zsBTC): 0 sBTC" },
      { "name": "pyth_oracle", "ok": true, "detail": "BTC: \$71256.19, age: 2s" },
      { "name": "mempool_whale_scan", "ok": true, "detail": "0 whale signals in mempool" }
    ],
    "wallet": "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY",
    "network": "mainnet"
  },
  "error": null
}
\`\`\`

</details>

<details>
<summary>execute dry-run (preview with risk check)</summary>

\`\`\`json
{
  "status": "success",
  "action": "execute_preview",
  "data": {
    "dry_run": true,
    "execution_mode": "dca",
    "dca_risk_signals": ["high risk pool (score 4/5)"],
    "dca_risk_checked": true,
    "max_per_execute_sats": 500000
  }
}
\`\`\`

</details>

## Frontmatter validation

- \`metadata:\` nested block with all values as quoted strings
- \`tags\` comma-separated string (\`"defi, write, mainnet-only, requires-funds"\`)
- \`requires\` comma-separated string (\`"wallet, signing, settings"\`)
- \`user-invocable\` quoted string (\`"false"\`)
- \`entry\` path repo-root-relative (\`sbtc-capital-allocator/sbtc-capital-allocator.ts\`)
- \`AGENT.md\` has YAML frontmatter with \`name\`, \`skill\`, \`description\`

## Security notes

- Write skill — emits \`call_contract\` for HODLMM and \`zest_supply\` for Zest, both with \`auto_execute: false\`
- \`--confirm\` required for writes, dry-run preview without it
- Oracle hard-block at >2% Pyth vs pool divergence or >120s stale
- Fee spike hard-block (1d fees > 3x 7d avg)
- TVL impact hard-block (deploy > 5% of pool TVL)
- HODLMM slippage: min-dlp >= 95%, max-fee <= 5% — enforced on-chain by the DLMM router
- 500K sats cap, 10K sats reserve, 30min cooldown — all as code constants
- Mempool whale scan via public Hiro API — no credentials needed
- Mainnet only

## On the "Three protocols" requirement

The skill idea specifies routing between HODLMM pools, Zest lending, and DCA. After thorough research across the Stacks sBTC ecosystem — including ALEX DEX (zero sBTC pool volume), JingSwap (swap protocol, no yield for depositors), Bitflow XYK (no public API), and Hermetica (USDh-denominated, not sBTC) — only HODLMM and Zest currently meet viability criteria for sBTC yield routing: real volume, real TVL, real on-chain rates.

Rather than fabricating a third yield source with hardcoded data, DCA is implemented as an execution strategy (HOW to deploy) layered on top of the allocation decision (WHERE to deploy). This separation is intentional — most yield tools only answer "where." This skill also answers "when and how fast" based on live risk signals.

The skill is architected to be modular: adding a third, fourth, or fifth protocol requires only a new entry in the yields array and an execute path. The decision function, risk scoring, DCA triggers, and safety gates apply automatically to any new protocol added. When a viable third sBTC yield source emerges on Stacks, it slots in without restructuring.

## Known constraints

- HODLMM APY uses 7-day smoothing — may lag sudden fee changes by up to a day
- Zest on-chain rate (0.16%) reflects current low utilization — not a bug, that's what the chain says
- Whale tracking via mempool: signal quality depends on mempool activity, quiet periods produce fewer signals
- DCA execution is stateless — agent schedules subsequent intervals
- Skill emits MCP commands but doesn't call contracts directly

🤖 Generated with [Claude Code](https://claude.com/claude-code)

