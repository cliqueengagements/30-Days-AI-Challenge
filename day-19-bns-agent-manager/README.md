# Day 19 — BNS Agent Manager

**PR:** [BitflowFinance/bff-skills#294](https://github.com/BitflowFinance/bff-skills/pull/294)
**Status:** Open — Day 19 submission
**Category:** Infrastructure (Write)

## What it does

First BNS write skill in the competition. Autonomous .btc name registration, transfer, and sniper.

- **register** — claim a .btc name via `claim_bns_name_fast`
- **transfer** — send a name to another address via `transfer_nft`
- **snipe** — watch a list of target names, auto-register when available
- **search** — check availability + pricing for names
- **portfolio** — list all names owned by wallet
- **doctor** — wallet/API/balance health check

## On-chain proof

**microbasilisk.btc** registered on mainnet:
- Tx: [`0d30ed9d...`](https://explorer.hiro.so/txid/0d30ed9d2e3ba062f5a187329e47194f29bf322c7f095c88371f0f1385f0d087?chain=mainnet)
- Token ID: u364269
- Price: 2 STX

## Safety

- `--confirm` token required on all writes (REGISTER, TRANSFER, SNIPE)
- `--max-price` cap prevents overspending
- 2 STX gas reserve floor
- 5-minute cooldown between registrations
- Dry-run preview by default

## PR Description

## Skill Name

bns-agent-manager

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — microbasilisk.btc | SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [ ] Yield
- [x] Infrastructure
- [ ] Signals

## What it does

First BNS write skill in the competition (291 PRs, zero BNS). Gives agents full lifecycle management of .btc names: check availability + pricing, register names via `claim_bns_name_fast`, transfer ownership via `transfer_nft`, and autonomously snipe target names when they become available. Three write actions, six commands, ten MCP tools — identity as a first-class agent capability.

## Full Capability Breakdown

### Read Commands

**`doctor`**
- Checks if wallet (STX_ADDRESS) is configured
- Tests Hiro API connectivity
- Tests BNS API connectivity
- Reports STX balance and whether gas reserve is adequate
- Shows snipe watchlist count and registration history count
- Returns `success` or `blocked` with specific blockers listed

**`search --names "name1,name2,name3"`**
- Accepts comma-separated list of names
- Checks each name against Hiro BNS API
- Reports: available/taken, current owner, expire block, registration status
- Fetches live price from Hiro pricing endpoint
- Falls back to length-based price estimate (1 char = 640 STX, 5+ chars = 2 STX)
- Returns totals: how many available vs taken

**`portfolio`**
- Lists all BNS names owned by the wallet
- Queries both BNS v1 API (name lookup by address) and v2 NFT holdings
- For each name: address, expire block, registration status
- Cross-references NFT token IDs and contract IDs (needed for transfers)
- Shows current STX balance alongside holdings

### Write Commands

**`register --name <name> [--max-price <stx>] [--confirm=REGISTER]`**
- Checks name availability first — blocks if already taken
- Checks price against `--max-price` cap (default 50 STX) — blocks if too expensive
- Checks wallet STX balance against name price + 2 STX gas reserve — blocks if insufficient
- Checks 5-minute cooldown since last registration — blocks if too soon
- Without `--confirm`: shows dry-run preview with price, balance, projected after-balance, and MCP tool preview
- With `--confirm=REGISTER`: outputs MCP tool call (`claim_bns_name_fast`) for agent runtime to execute
- Records timestamp and name in state file history

**`transfer --name <name> --to <SP...address> [--confirm=TRANSFER]`**
- Validates recipient address format (must start with SP or SM)
- Checks name exists on-chain — blocks if not registered
- Verifies wallet owns the name — blocks if owned by someone else
- Looks up NFT token ID and contract ID from portfolio
- Checks gas reserve — blocks if below 2 STX
- Without `--confirm`: shows dry-run preview with from/to, token ID, contract
- With `--confirm=TRANSFER`: outputs MCP tool call (`transfer_nft`) for agent runtime to execute
- Blocks if token ID cannot be resolved — guides user to run `portfolio` first

**`snipe [--add|--remove|--list] [--max-price <stx>] [--confirm=SNIPE]`**
- `--add "name1,name2"`: adds names to persistent watchlist (max 20 targets), each with its own max price
- `--remove "name1"`: removes names from watchlist
- `--list`: shows current watchlist with prices and timestamps
- Without flags: scans all watchlist targets for availability, reports which are available and within budget
- Without `--confirm`: shows dry-run with all results and which names are actionable
- With `--confirm=SNIPE`: registers the first available name within budget
  - Checks balance, gas reserve, and cooldown before executing
  - Removes claimed name from watchlist automatically
  - Reports remaining targets
  - Outputs MCP tool call (`claim_bns_name_fast`) for agent runtime

### Safety Gates (enforced in code, not just docs)
- `--confirm` token required on every write (REGISTER, TRANSFER, SNIPE)
- `--max-price` cap refuses expensive names
- 2 STX gas reserve floor — never drains wallet
- 5-minute cooldown between registrations
- Dry-run preview is always the default
- State persisted to `~/.bns-agent-manager.json` (survives restarts)
- Recipient address validation on transfers
- Ownership verification before transfers

## On-chain proof

**microbasilisk.btc registered on mainnet:**

| Detail | Value |
|--------|-------|
| **Tx** | [0d30ed9d2e3ba062f5a187329e47194f29bf322c7f095c88371f0f1385f0d087](https://explorer.hiro.so/txid/0d30ed9d2e3ba062f5a187329e47194f29bf322c7f095c88371f0f1385f0d087?chain=mainnet) |
| **Name** | microbasilisk.btc |
| **Token ID** | u364269 |
| **Price** | 2 STX |
| **Block** | 7,587,630 |
| **Owner** | SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY |

## Does this integrate HODLMM?

- [ ] No — this is an identity/infrastructure primitive. BNS names are complementary to DeFi skills: agents need discoverable identities before they can coordinate on LP, yield, or trading strategies.

## Registry compatibility checklist

- [x] `SKILL.md` uses `metadata:` nested frontmatter (not flat keys)
- [x] `AGENT.md` starts with YAML frontmatter (`name`, `skill`, `description`)
- [x] `tags` and `requires` are comma-separated quoted strings, not YAML arrays
- [x] `user-invocable` is a quoted string (`"false"`)
- [x] `entry` path is repo-root-relative (no `skills/` prefix)
- [x] `metadata.author` field is present with GitHub username
- [x] All commands output JSON to stdout
- [x] Error output uses `{ "error": "descriptive message" }` format

## Smoke test results

**doctor**

```bash
STX_ADDRESS=SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY bun run bns-agent-manager/bns-agent-manager.ts doctor
```
```json
{"status":"success","action":"doctor","data":{"checks":{"wallet_configured":true,"hiro_api":"ok","bns_api":"ok","stx_balance_stx":38.578744,"gas_reserve_ok":true,"can_register":true,"snipe_targets":0,"registration_history":0}},"error":null}
```

**search**

```bash
STX_ADDRESS=SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY bun run bns-agent-manager/bns-agent-manager.ts search --names "microbasilisk,satoshi,agent77test"
```
```json
{"status":"success","action":"search","data":{"total":3,"available":2,"taken":1,"names":[{"name":"microbasilisk","full_name":"microbasilisk.btc","available":true,"owner":null,"status":"available","price_stx":2},{"name":"satoshi","full_name":"satoshi.btc","available":false,"owner":"SP3BB8XZ049ECNX2VRAFPD67SQRXGVZX0TM9MS2S0","status":"name-transfer","price_stx":2},{"name":"agent77test","full_name":"agent77test.btc","available":true,"owner":null,"status":"available","price_stx":2}]},"error":null}
```

**register (dry-run)**

```bash
STX_ADDRESS=SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY bun run bns-agent-manager/bns-agent-manager.ts register --name microbasilisk
```
```json
{"status":"success","action":"register","data":{"mode":"dry_run","name":"microbasilisk.btc","price_stx":2,"stx_balance":38.578744,"after_balance_stx":36.578744,"instruction":"Add --confirm=REGISTER to execute on-chain","mcp_preview":{"tool":"claim_bns_name_fast","params":{"name":"microbasilisk.btc"}}},"error":null}
```

**snipe (add + scan)**

```bash
bun run bns-agent-manager/bns-agent-manager.ts snipe --add "microbasilisk,agent77" --max-price 5
```
```json
{"status":"success","action":"snipe","data":{"action":"targets_added","added":2,"total":2,"targets":[{"name":"microbasilisk.btc","max_price_stx":5,"added_at":"2026-04-13T13:17:39.429Z"},{"name":"agent77.btc","max_price_stx":5,"added_at":"2026-04-13T13:17:39.430Z"}]},"error":null}
```

```bash
STX_ADDRESS=SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY bun run bns-agent-manager/bns-agent-manager.ts snipe
```
```json
{"status":"success","action":"snipe","data":{"mode":"dry_run","found":2,"actionable":[{"name":"microbasilisk.btc","available":true,"price_stx":2,"within_budget":true,"action":"REGISTER"},{"name":"agent77.btc","available":true,"price_stx":2,"within_budget":true,"action":"REGISTER"}],"all_results":[{"name":"microbasilisk.btc","available":true,"price_stx":2,"within_budget":true,"action":"REGISTER"},{"name":"agent77.btc","available":true,"price_stx":2,"within_budget":true,"action":"REGISTER"}],"instruction":"Add --confirm=SNIPE to auto-register the first available name"},"error":null}
```

**install-packs**

```bash
bun run bns-agent-manager/bns-agent-manager.ts install-packs --pack all
```
```json
{"status":"success","action":"install-packs","data":{"message":"No external packs required."},"error":null}
```

## Frontmatter validation

Frontmatter manually verified against registry spec:

- `metadata:` nested block with all values as quoted strings
- `tags` comma-separated string (not array): `"write, infrastructure, mainnet-only, requires-funds, l2"`
- `requires` comma-separated string: `"wallet, signing, settings"`
- `user-invocable` quoted string: `"false"`
- `entry` path repo-root-relative: `"bns-agent-manager/bns-agent-manager.ts"`
- `AGENT.md` has YAML frontmatter with `name`, `skill`, `description`

## Security notes

- **Three write actions**: register (burns STX), transfer (moves NFT), snipe (autonomous register). All require explicit `--confirm` tokens.
- **Price cap**: `--max-price` prevents overspending on premium names (1-char = 640 STX).
- **Gas reserve**: Always retains 2 STX. Blocks writes if balance would drop below.
- **Cooldown**: 5-minute cooldown between registrations prevents rapid spending.
- **Dry-run default**: All writes show a preview first. No funds move without confirmation.
- **State persisted**: Watchlist and history saved to `~/.bns-agent-manager.json` via `homedir()`.
- **Mainnet only**: BNS V2 is not deployed on testnet.
- **No private key exposure**: Writes are executed via MCP tool calls (claim_bns_name_fast, transfer_nft).

## Known constraints or edge cases

- Hiro BNS v1 API may not list BNS V2 names; skill cross-references NFT holdings endpoint
- Name pricing endpoint may return estimates; length-based fallback pricing is used
- Transfer requires NFT token ID resolution from portfolio; blocked with guidance if lookup fails
- Snipe runs one scan per invocation; schedule via cron for continuous monitoring
- Stacks blocks confirm in ~5 seconds post-Nakamoto
- BNS V2 contract defaults to canonical deployment; configurable in code

