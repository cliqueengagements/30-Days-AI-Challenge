---
name: bns-agent-manager-agent
skill: bns-agent-manager
description: "Agent behavior rules for the BNS Agent Manager — autonomous .btc name registration, transfer, and sniper."
---

# Agent Behavior — BNS Agent Manager

## Decision order
1. Run `doctor` to verify wallet, Hiro API, BNS API, and STX balance.
2. If doctor reports `blocked`, surface the specific blockers and stop.
3. For name discovery: run `search --names <list>` to check availability and pricing.
4. For registration:
   a. Run `register --name <name>` as dry-run first.
   b. Verify the price is acceptable and balance is sufficient.
   c. Run `register --name <name> --confirm=REGISTER` to execute.
5. For transfer:
   a. Run `portfolio` to verify ownership and get NFT details.
   b. Run `transfer --name <name> --to <address>` as dry-run first.
   c. Run `transfer --name <name> --to <address> --confirm=TRANSFER` to execute.
6. For sniping:
   a. Add targets: `snipe --add <names> --max-price <stx>`.
   b. Scan: `snipe` (dry-run) to check current availability.
   c. Execute: `snipe --confirm=SNIPE` to auto-register the first available target.
7. After any write, run `portfolio` to verify the result after block confirmation.

## Guardrails
- **NEVER register without --confirm=REGISTER.** The confirmation token is a safety gate on real STX spending.
- **NEVER transfer without --confirm=TRANSFER.** Name transfers are irreversible.
- **NEVER snipe without --confirm=SNIPE.** Autonomous registration must be explicitly authorized.
- **NEVER exceed --max-price.** If a name costs more than the configured maximum, refuse and explain.
- **NEVER register if STX balance would drop below gas reserve (2 STX).** The wallet must retain funds for future operations.
- **NEVER bypass cooldown.** The 5-minute cooldown between registrations prevents rapid spending.
- **ALWAYS run doctor before first write** in a session to confirm API access and balance.
- **ALWAYS verify ownership before transfer** — run `portfolio` or check the `search` result.
- **ALWAYS prefer dry-run first** — show the user what will happen before executing.
- Never expose secrets or private keys in args or logs.

## Autonomous scheduling
```
1. Add target names to watchlist: snipe --add "name1,name2" --max-price 10
2. Schedule snipe scan every 5 minutes via cron or agent loop
3. On available target found → snipe --confirm=SNIPE
4. After registration → remove target from watchlist automatically
5. Run portfolio daily to audit name holdings
```

## Spending limits
- **Max price per name**: Configurable via `--max-price` (default 50 STX, recommended: 10 STX for most names)
- **Gas reserve floor**: 2 STX always retained
- **Cooldown**: 5 minutes between registrations
- **Max snipe targets**: 20 names in watchlist

## BNS pricing reference
| Name length | Estimated price |
|-------------|----------------|
| 1 character | ~640 STX |
| 2 characters | ~160 STX |
| 3 characters | ~40 STX |
| 4 characters | ~10 STX |
| 5+ characters | ~2 STX |

## On error
- Log the error payload with name and context to stderr
- Do not retry writes silently — each attempt may cost STX
- On `blocked`: read the specific reason (price, balance, cooldown, ownership)
- On API failure: wait and retry doctor before attempting writes

## On success
- Confirm the registered or transferred name
- Report the MCP tool call issued and expected tx result
- Update state file with registration history
- For snipe: remove the claimed name from watchlist

## Integration with other skills
- Compose with `stacks-wallet-sentinel` for balance monitoring before bulk registrations
- Names registered here can be used as identity across Nostr (`nostr-agent-broadcaster`), inbox messaging, and agent reputation
- Transfer capability enables secondary market trading of agent identities
