# DTS bot

Your TradingView alerts, executed on Paradex by a bot that runs in **your own Cloudflare account**, with **your own keys**. You follow it, and stop it, from Telegram.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thenkinet/dts-bot)

> **Status: early, on the real Paradex at minimum size.** Paradex's testnet could not fund new accounts in November 2026, so this repository's settings point at the real network with tiny limits (orders of about $12, position at most about $25, $10 daily loss). It only trades when a signal arrives. Use an account holding only what you accept to lose, and run the drills in `docs/TECHNICAL.md`, section 7, before connecting signals.

## What the button does

1. Copies this code into your GitHub account and creates the bot in your Cloudflare account (Workers Paid plan, $5 a month).
2. Asks for five secrets, each pasted from Apple Passwords:

| Secret | What it is |
| --- | --- |
| `PARADEX_ACCOUNT` | Your Paradex account address (`0x...`). Type `later` if you don't have it yet |
| `PARADEX_PRIVATE_KEY` | A Paradex **trade-only subkey**, which can trade but never withdraw. Type `later` if not ready |
| `TELEGRAM_BOT_TOKEN` | The token BotFather gave you |
| `SIGNAL_SECRET` | A random password TradingView sends with every alert |
| `ADMIN_TOKEN` | A random password: your master key to the bot |

3. Redeploys automatically whenever a change is merged on GitHub.

## After the button

1. Open `https://dts-bot.<your-subdomain>.workers.dev/setup`, paste your admin token: Telegram is linked.
2. Send `/start` to your bot. It replies with two numbers; Claude adds them to `wrangler.toml` by pull request, and you merge it.
3. `/status`, `/check`, `/killall`, `/flatten` and `/resume` then work, from your account only.

## Safety rules built in

- Secrets are compared in constant time; alerts older than 30 seconds are refused; a repeated alert does nothing.
- The engine checks the halt switch, the daily loss and the maximum position before **every** order, and refuses to trade without these limits.
- `/killall` halts and cancels every order; `/flatten` closes positions with capped reduce-only orders, never market orders.
- `/health` shows which secrets are set, by name only, never their values.
- `PARADEX_KILL_PRIVATE_KEY` (a second trade-only subkey for the kill switch) is required before real money.

Not built yet: a reduce-only disaster stop resting at Paradex for every position. Required before real money.

## Tests

```bash
npm install
npm test   # signing against Paradex's official SDK, client, executor (300 ms Retail delay), worker routes
```

The signing tests use a throwaway test key in `test/vectors.json`; it holds no funds and is not a secret.

## Licence

Apache 2.0. The trading engine's plumbing is open; strategies, tuning and indicators are not part of this repository.
