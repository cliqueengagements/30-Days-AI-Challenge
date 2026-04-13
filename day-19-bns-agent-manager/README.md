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
