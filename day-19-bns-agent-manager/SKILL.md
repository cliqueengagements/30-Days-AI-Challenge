---
name: bns-agent-manager
description: "Autonomous BNS .btc name registration, transfer, and sniper — agents can claim, manage, and trade on-chain identities."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent #77) — microbasilisk.btc"
  user-invocable: "false"
  arguments: "doctor | search | portfolio | register | transfer | snipe | install-packs"
  entry: "bns-agent-manager/bns-agent-manager.ts"
  requires: "wallet, signing, settings"
  tags: "write, infrastructure, mainnet-only, requires-funds, l2"
---

# BNS Agent Manager

## What it does
Gives agents full lifecycle management of BNS .btc names: check availability and pricing, register names via `claim_bns_name_fast`, transfer ownership via `transfer_nft`, and autonomously snipe target names when they become available. Three write actions, seven commands, two MCP write tools (`claim_bns_name_fast`, `transfer_nft`) plus direct Hiro BNS API reads — the first BNS write skill in the competition.

## Why agents need it
Every AIBTC agent operates with a bare Stacks address. A .btc name is the on-chain identity primitive — `microbasilisk.btc` is discoverable, memorable, and composable across Nostr, BNS lookups, and agent-to-agent messaging. Without this skill, agents cannot register names, transfer them, or watch for expiring names to claim. This unlocks identity as a first-class agent capability.

## Safety notes
- **Writes to chain**: `register` burns STX to mint a BNS V2 NFT. `transfer` moves the NFT to another address. Both are irreversible.
- **--confirm gate**: Every write requires an explicit confirmation token (`--confirm=REGISTER`, `--confirm=TRANSFER`, `--confirm=SNIPE`). Without it, the command runs as a dry-run preview.
- **--max-price cap**: Registration refuses if the name price exceeds the configured max (default 50 STX). Prevents overspending on premium short names.
- **Gas reserve**: Always retains 2 STX for future transactions. Blocks registration if balance would drop below reserve.
- **Cooldown**: 5-minute cooldown between registrations to prevent rapid-fire spending.
- **Mainnet only**: BNS V2 is deployed on Stacks mainnet.
- **State persisted**: Watchlist targets, cooldown timestamps, and registration history are saved to `~/.bns-agent-manager.json`.

## Commands

### doctor
Check wallet configuration, Hiro API access, BNS API access, STX balance, and gas adequacy. Read-only, safe to run anytime.
```bash
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts doctor
```

### search
Check availability and registration price for one or more BNS names. Read-only.
```bash
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts search --names "agent77,microbasilisk,coolname"
```

### portfolio
List all BNS names owned by the wallet, with expiry and NFT token details. Read-only.
```bash
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts portfolio
```

### register
Register a .btc name. Checks availability, price gate, gas reserve, and cooldown. Dry-run by default.
```bash
# Dry-run (preview)
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts register --name myagent

# Execute on-chain
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts register --name myagent --max-price 10 --confirm=REGISTER
```

### transfer
Transfer a .btc name to another Stacks address. Verifies ownership and resolves NFT token ID. Dry-run by default.
```bash
# Dry-run (preview)
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts transfer --name myagent --to SP3ABC...

# Execute on-chain
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts transfer --name myagent --to SP3ABC... --confirm=TRANSFER
```

### snipe
Autonomous name sniper. Manage a watchlist of target names and auto-register when they become available.
```bash
# Add targets to watchlist
bun run bns-agent-manager/bns-agent-manager.ts snipe --add "agent77,coolbot" --max-price 10

# List watchlist
bun run bns-agent-manager/bns-agent-manager.ts snipe --list

# Scan targets (dry-run)
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts snipe

# Scan + auto-register first available
STX_ADDRESS=SP... bun run bns-agent-manager/bns-agent-manager.ts snipe --confirm=SNIPE

# Remove targets
bun run bns-agent-manager/bns-agent-manager.ts snipe --remove "agent77"
```

### install-packs
No external packs required. Returns success immediately.
```bash
bun run bns-agent-manager/bns-agent-manager.ts install-packs --pack all
```

## Output contract

All outputs are JSON to stdout. Logs go to stderr.

**Doctor success:**
```json
{ "status": "success", "action": "doctor", "data": { "checks": { "wallet_configured": true, "hiro_api": "ok", "bns_api": "ok", "stx_balance_stx": 38, "gas_reserve_ok": true, "can_register": true, "snipe_targets": 0, "registration_history": 0 } }, "error": null }
```

**Search result:**
```json
{ "status": "success", "action": "search", "data": { "total": 2, "available": 1, "taken": 1, "names": [{ "name": "coolname", "full_name": "coolname.btc", "available": true, "owner": null, "status": "available", "price_stx": 2 }, { "name": "satoshi", "full_name": "satoshi.btc", "available": false, "owner": "SP3BB8...", "status": "name-transfer", "price_stx": 2 }] }, "error": null }
```

**Register dry-run:**
```json
{ "status": "success", "action": "register", "data": { "mode": "dry_run", "name": "myagent.btc", "price_stx": 2, "stx_balance": 38, "after_balance_stx": 36, "instruction": "Add --confirm=REGISTER to execute on-chain", "mcp_preview": { "tool": "claim_bns_name_fast", "params": { "name": "myagent.btc" } } }, "error": null }
```

**Register execute:**
```json
{ "status": "success", "action": "execute_mcp", "data": { "action": "register", "name": "myagent.btc", "price_stx": 2, "mcp": { "tool": "claim_bns_name_fast", "params": { "name": "myagent.btc" } }, "next_steps": ["Agent runtime executes claim_bns_name_fast", "Tx broadcasts to Stacks mainnet", "Name minted as BNS V2 NFT to wallet", "Run 'portfolio' to verify after confirmation (~1 min)"] }, "error": null }
```

**Blocked:**
```json
{ "status": "blocked", "action": "register", "data": { "name": "myagent.btc", "price_stx": 640, "max_price_stx": 50 }, "error": "Price 640 STX exceeds max 50 STX. Use --max-price to increase." }
```

**Error:**
```json
{ "status": "error", "action": "register", "data": null, "error": "No STX_ADDRESS configured." }
```

## Known constraints
- Mainnet only — BNS V2 is not deployed on testnet
- Hiro BNS API may not list BNS V2 names in the v1 endpoint; skill cross-references NFT holdings
- Name pricing endpoint may return estimates for some names; length-based fallback pricing is used
- Transfer requires NFT token ID resolution — if portfolio lookup fails to resolve the token ID, transfer is blocked with guidance
- Snipe command runs a single scan per invocation; for continuous sniping, schedule via cron or agent loop
- Registration confirmation takes ~5 seconds (1 Stacks block post-Nakamoto)
- BNS V2 contract address is configurable but defaults to the canonical deployment
