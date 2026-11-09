# DTS bot: technical reference

Written for the starter kit v4; the bot adds /setup, the Telegram /start link and /check from Telegram (see the main README). Setting up through the Deploy to Cloudflare button replaces sections 3 and 4 below.

The first code of the DTS execution engine: Paradex signing in JavaScript, a
small Paradex client, a testnet check, and a staging Cloudflare Worker with a
Durable Object, a Telegram kill switch and an alert relay.

## What is already proven, and what is not

| Status | Item |
|---|---|
| Proven | Login and order message hashes are identical to those built by Paradex's official SDK, paradex-py (`npm test`, `test/sdk_oracle.py`), and signatures verify both ways against a Python reference |
| Proven | The Worker bundles: about 136 KB, 39 KB compressed (`npx wrangler deploy --dry-run`) |
| Proven | The testnet check's logic runs end to end against a simulated Paradex API |
| Proven | The Track A executor (taker and maker methods, flips, caps, fallbacks, empty book) against a simulated exchange **that delays every order and cancel by 300 ms, as Paradex Retail does**: `npm run test:executor`. The same delay test run against v3 reproduces review point D1 (3 orders, position 0.02 for a 0.01 target); v4 sends one order |
| Proven | An order whose POST fails with 5xx or a timeout is looked up by client id before any re-send: `npm run test:client` (mocked network) |
| **Not yet proven** | The Engine's guard, daily-loss halt, in-flight recovery and capped `/flatten` on the real testnet: these run only inside Cloudflare. Quant 2's acceptance tests, section 7 |
| Proven | The real testnet's public replies match the field names the client reads (`starknet_chain_id`, `price_tick_size`, `order_size_increment`, `min_notional`, `bid`, `ask`), checked on 3 Nov 2026. Its chain ids are `PRIVATE_SN_PARACLEAR_TESTNET` and `PRIVATE_SN_PARACLEAR_MAINNET` |
| Proven | A signed Retail login reached the real testnet and was answered on substance (`NOT_ONBOARDED` for a made-up account), so the request format is understood |
| **Not yet proven** | That the real testnet accepts our login and orders for a real account. That is `npm run check` |

## Layout

```
src/paradex-sign.js     signing: login and order hashes, signatures in Paradex's format
src/paradex-client.js   REST client: config, login, markets, best prices, orders, cancels
src/check.js            the testnet check, shared by the script and the Worker
src/executor.js         Track A: one signal -> orders (taker or maker method), flips split into reduce-only + open
src/worker.js           staging Worker: /health, /probe, /hello, /check, /alert, /signal, /engine, /telegram
test/executor.test.mjs  executor tests against a simulated exchange with Retail's 300 ms delay (test/fake-paradex.mjs)
test/client.test.mjs    client tests with a mocked network (order recovery by client id)
scripts/testnet-check.mjs   the check from your machine
test/                   cross-check against the Python oracle (vectors, oracle.py, oracle_out.json)
```

## 1. Install and test

```bash
npm install
npm test            # expect: All required checks passed, All client checks passed, All executor checks passed
```

`npm test` FAILS if `test/sdk_out.json` (hashes built by Paradex's official SDK) is missing. Regenerate both
oracle files yourself rather than trusting the ones shipped:
`pip install paradex-py starknet-py starknet-crypto-py`, then
`python3 test/sdk_oracle.py test/vectors.json > test/sdk_out.json` and `python3 test/oracle.py test/vectors.json > test/oracle_out.json`.

## 2. Testnet check from your machine

Create `.env.local` (never committed; see `.env.local.example`):

```
PARADEX_ENV=testnet
PARADEX_ACCOUNT=0x...           # main testnet account address
PARADEX_PRIVATE_KEY=0x...       # the trade-only subkey's private key
MARKET=BTC-USD-PERP
```

```bash
npm run check
```

Use an account created in Paradex's testnet web app: that onboards it. A login answered with
`NOT_ONBOARDED` means the account has never been onboarded.

It reads the chain id, logs in, reads the market's tick and size step, places one
tiny post-only bid 10% below the best bid (it cannot fill), reads it back, cancels it
and reads it back again. It stops at the first failure and prints Paradex's reply.

Login follows the official SDK exactly: it signs a `Request` for `/v1/auth` and posts it to
`/auth/{public key of the signing key}`, which works the same for a main key and a subkey.
If step 2 still fails, send the full output for review.

## 0. First, before anything else: can Cloudflare reach Paradex?

Deploy the Worker with no secrets at all and open `/probe`. It shows Cloudflare's outgoing
IP and location, and the HTTP status of Paradex's public endpoints on testnet and production.
Anything other than 200 (for example 403) means Paradex blocks Cloudflare's addresses, and the
hosting plan must change before more work is done.

## 3. Staging Worker

```bash
npx wrangler login
npx wrangler secret put PARADEX_ACCOUNT        # and the other secrets listed in wrangler.toml
npx wrangler deploy
npx wrangler tail                              # live logs in another terminal
curl https://<worker>.workers.dev/health
curl https://<worker>.workers.dev/hello        # the counter goes up on each call
curl -H "x-admin-token: <ADMIN_TOKEN>" https://<worker>.workers.dev/check
```

## 4. Telegram

1. In BotFather: `/revoke` the old token if it was ever shared, or `/newbot` for a new bot.
2. Send any message to the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates`
   and read `message.chat.id`. That is `TELEGRAM_CHAT_ID`.
3. Register the webhook (one time):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>.workers.dev/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>`
4. In the chat: `/status`, then the kill-switch drill with a test order resting on the testnet:
   - `/killall` sets a persistent HALT flag, cancels all orders, then re-reads the open orders up to
     three times and reports whether any remain. Positions are not touched.
   - `/flatten` (only while halted) closes each open position with a reduce-only IOC **limit** order at most
     `FLATTEN_CAP_BPS` (default 1%) beyond the touch, then re-reads the positions and reports what is left.
     Never a market order. Test it on the testnet before relying on it.
   - `/resume` clears the HALT flag. The Engine reads the flag before **every** order.
   - `PARADEX_KILL_PRIVATE_KEY`: a second trade-only subkey used only by the kill switch, so it still works if
     the engine's key is revoked. **Required on prod**: the Engine refuses to trade there without it.
5. Commands are accepted only from `TELEGRAM_CHAT_ID` **and** from a sender listed in `TELEGRAM_USER_IDS`
   (comma-separated; read `message.from.id` in `getUpdates`). Someone added to the chat cannot command the bot.

## 5. A TradingView or MMT test alert

Webhook URL: `https://<worker>.workers.dev/alert`. Message:

```json
{"secret": "<ALERT_SECRET>", "ts": "{{timenow}}", "source": "tradingview", "price": {{close}}}
```

Numeric placeholders such as `{{close}}` go **without** quotes, or the JSON breaks.
TradingView and MMT cannot set custom headers, which is why the secret rides in the body.
`ts` is required (seconds, milliseconds or an ISO time; for MMT use the event's unix time) and the
alert is refused if it is more than 30 seconds old or if `ALERT_SECRET` is not set. Secrets are
compared in constant time.

## 6. Track A: executing directional signals

`POST /signal` with:

```json
{"secret": "<SIGNAL_SECRET>", "ts": "{{timenow}}", "id": "ema14-{{ticker}}-{{time}}", "side": "long", "price": {{close}}}
```

- `side` is `long`, `short` or `flat`; the position size comes from `ORDER_SIZE` (or an optional `size`, refused
  above `MAX_POSITION`).
- `id` must be unique per signal (1 to 48 letters, digits, `.`, `_`, `:` or `-`). The same id twice does
  nothing, so a repeated alert is harmless. Strip characters outside that set from `{{time}}`, or build the
  id in the script that sends the alert.
- `price` is the reference for the slippage cap; without it, the mid price at arrival is used.

The Worker hands the signal to the market's Engine (a Durable Object), which executes in its alarm, one
signal at a time. If several arrive while one runs, only the latest is executed.

Safety rules of the Engine (Quant 2's review of v3):
- **Final state before the next decision.** Retail delays every order and cancel by 300 ms. The executor waits
  until an order is `CLOSED` before deciding anything else, and sizes the next order from the position at
  Paradex as well as from the fills. An order whose state stays unknown for 5 s stops the leg.
- **Guard before every order:** the HALT flag, then the daily loss. `MAX_DAILY_LOSS` is the drop in
  `account_value` since the day's first reading (00:00 UTC); reaching it sets HALT and alerts once. It is also
  checked every minute with no signal. A deposit or withdrawal moves the number too: halt before moving funds.
- **`MAX_POSITION`** caps the target and is re-checked before every opening order.
  The Engine refuses to trade if `MAX_POSITION` or `MAX_DAILY_LOSS` is missing.
- **No lost signal.** A signal moves from the queue to an in-flight marker in one write. If it cannot start
  (for example the HALT read fails) it is put back and retried up to 3 times, with a Telegram message. If an
  execution is cut off (deploy, eviction), the next alarm resumes it once under new client ids, unless a newer
  signal is waiting.
- **No blind re-send.** After a 5xx or a timeout on an order, the client asks Paradex for the order by client id
  before sending it again.
- Idempotency keys (`seen:`) are pruned after 7 days; the Paradex client and its login token live in the
  Engine's memory.

| Variable (`wrangler.toml`) | Meaning |
|---|---|
| `EXEC_MODE` | `taker` (first): IOC at the cap, with a Retail token (`PARADEX_INTERACTIVE = "true"`): zero fees, RPI liquidity. `maker`: post-only at the touch, re-posted, then IOC fallback |
| `ORDER_SIZE` | Position size per signal |
| `MAX_SLIPPAGE_BPS` | Cap around the reference price: no buy above, no sell below |
| `TAKER_ATTEMPTS` | IOC attempts per leg |
| `MAKER_WINDOW_MS`, `MAKER_REPOSTS` | Patience of the maker method, and how many re-posts it gets |
| `MAX_POSITION` | Hard cap on the absolute position (required) |
| `MAX_DAILY_LOSS` | Account-value drop in USD since 00:00 UTC that halts the engine (required) |
| `FLATTEN_CAP_BPS` | `/flatten` price cap beyond the touch, in basis points (default 100) |

A flip (long to short) is two legs: a reduce-only close, then the opening order. Every order's client id
is built from the signal id. Each execution reports to Telegram:
- fills, with their method and slippage in basis points;
- the position before and after;
- any gap, and why it remains (for example "best price beyond cap" or "no sellers in the book").

Every minute, the Engine compares the position at Paradex with the last target and alerts once per gap.
`GET /engine` (header `x-admin-token`) shows the last report, the target and the queue. `/status` in
Telegram summarises them.

**The testnet book is thin.** On 3 Nov 2026, BTC-USD-PERP showed no sellers at all. Taker tests may simply
not fill, which the executor reports rather than chasing. Pick a market with both sides present for stage A1.

## 7. Acceptance tests on the testnet (Quant 2)

Before any signal runs on the testnet, and again before A2 (real money):
1. `/signal` with a size above `MAX_POSITION`: refused (HTTP 400).
2. `/killall`, then a signal: refused, "HALTED". `/resume`.
3. A taker signal on a market with both sides present: Telegram shows ONE order per fill, position = target.
4. Set `MAX_DAILY_LOSS` to 0.01, deploy, send a signal: HALT on the first order's guard. Restore the value.
5. A maker signal, then `npx wrangler deploy` while it rests: the next alarm says "interrupted ... resuming".
6. Open a small position, `/killall`, `/flatten`: "Positions left: none".
7. A command from a Telegram account not in `TELEGRAM_USER_IDS`: ignored.

## Rules

- No key in code, commits, logs or chats. Keys live in a password manager and as Worker secrets.
- `main` changes only through a reviewed pull request.
- The check refuses to run against production.
- Exits must round sizes DOWN (`floorToStep`) and asks round prices UP (`ceilToTick`).
- Network calls time out after 5 s; only safe calls are retried (GET, DELETE, or an order with a
  client id), and only on HTTP 429, 5xx or a timeout. Login tokens refresh every 3 minutes and once on 401.
