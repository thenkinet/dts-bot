// DTS bot Worker. Routes:
//   GET  /health     liveness, plus which secrets are set (names only, never values)
//   GET  /probe      can Cloudflare reach Paradex? No key needed (answers review point F5)
//   GET  /setup      one-time page: links Telegram to this bot (asks for the admin token)
//   GET  /check      the Paradex testnet check (header x-admin-token required)
//   POST /alert      relays a TradingView/MMT test alert to Telegram (secret + fresh ts in the body)
//   POST /signal     Track A: a directional signal {id, side: long|short|flat, price?, size?} for the Engine
//   GET  /engine     the Engine's state: last report, target, queue (header x-admin-token required)
//   POST /telegram   Telegram webhook, allowed chat only:
//                    /status, /killall (halt + cancel all + verify), /flatten (capped reduce-only IOC, needs halt), /resume
//                    (allowed chat AND allowed sender ids)
import { DurableObject } from 'cloudflare:workers';
import { Paradex, BASES } from './paradex-client.js';
import { runCheck } from './check.js';
import { executeSignal, signedPosition, DEFAULTS } from './executor.js';
import { toInt8, fromInt8, floorToStep, floorToTick, ceilToTick } from './paradex-client.js';

// ---------- small helpers ----------
const enc = new TextEncoder();
// Constant-time comparison; false when either side is missing or empty.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
// Accepts seconds, milliseconds or an ISO string; returns milliseconds or NaN.
function toMs(ts) {
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === 'string' && /^\d+$/.test(ts)) return toMs(Number(ts));
  return Date.parse(ts);
}
const MAX_ALERT_AGE_MS = 30_000;

// ---------- Durable Objects ----------
// One Control object per account: the persistent HALT flag. Any engine must read
// it before EVERY order, and a halted engine places nothing until /resume.
export class Control extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/halt' && !(await this.ctx.storage.get('halted'))) {
      await this.ctx.storage.put('halted', { at: Date.now(), by: url.searchParams.get('by') || 'telegram' });
    }
    if (url.pathname === '/resume') await this.ctx.storage.delete('halted');
    return Response.json({ halted: (await this.ctx.storage.get('halted')) || null });
  }
}
// Track A engine: one per market. Signals are queued by fetch and executed one at a time
// in the alarm handler (alarms never overlap). Latest signal wins: older queued signals are
// skipped, because the strategy only cares about the position it should hold now.
const execConfig = (env) => ({
  market: env.MARKET,
  mode: env.EXEC_MODE || DEFAULTS.mode,
  size: env.ORDER_SIZE || DEFAULTS.size,
  maxPosition: env.MAX_POSITION,
  maxSlippageBps: Number(env.MAX_SLIPPAGE_BPS || DEFAULTS.maxSlippageBps),
  takerAttempts: Number(env.TAKER_ATTEMPTS || DEFAULTS.takerAttempts),
  makerWindowMs: Number(env.MAKER_WINDOW_MS || DEFAULTS.makerWindowMs),
  makerReposts: Number(env.MAKER_REPOSTS || DEFAULTS.makerReposts),
  pollMs: DEFAULTS.pollMs,
});
const RECONCILE_MS = 60_000;
const RETRY_MS = 10_000;              // a signal that could not start is retried this soon
const MAX_START_TRIES = 3;
const SEEN_TTL_MS = 7 * 86_400_000;   // idempotency keys kept 7 days

// Settings the Engine refuses to trade without (review D2, D6).
function missingSettings(env) {
  const miss = [];
  if (!(Number(env.MAX_POSITION) > 0)) miss.push('MAX_POSITION');
  if (!(Number(env.MAX_DAILY_LOSS) > 0)) miss.push('MAX_DAILY_LOSS');
  if (env.PARADEX_ENV === 'prod' && !env.PARADEX_KILL_PRIVATE_KEY) miss.push('PARADEX_KILL_PRIVATE_KEY (required on prod)');
  return miss;
}

export class Engine extends DurableObject {
  // One Paradex client per Engine instance, so its login token is reused (review D8).
  px() {
    if (!this._px) this._px = paradex(this.env);
    return this._px;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const st = this.ctx.storage;
    if (url.pathname === '/signal') {
      const sig = await request.json();
      if (await st.get(`seen:${sig.id}`)) return Response.json({ duplicate: true, id: sig.id });
      const queue = (await st.get('queue')) || [];
      queue.push({ ...sig, receivedAt: Date.now() });
      await st.put({ [`seen:${sig.id}`]: Date.now(), queue });   // one atomic write
      await st.setAlarm(Date.now());
      return Response.json({ queued: true, id: sig.id }, { status: 202 });
    }
    if (url.pathname === '/state') {
      return Response.json({
        target: await st.get('target'), last: await st.get('last'), queue: (await st.get('queue')) || [],
        inflight: (await st.get('inflight')) || null, day: (await st.get('day')) || null,
      });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    try {
      await this.step();
    } catch (e) {
      console.log(JSON.stringify({ event: 'engine.alarm_failed', error: String(e.message || e) }));
      await telegram(this.env, `ENGINE ERROR: ${String(e.message || e).slice(0, 300)}`).catch(() => {});
    } finally {
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + RECONCILE_MS);
    }
  }

  async step() {
    const st = this.ctx.storage, env = this.env;

    // A signal still marked in flight means the last execution was cut off (deploy, eviction).
    // Execution is target-based (it starts from the position at Paradex), so it is resumed once,
    // under new client ids, unless a newer signal is waiting.
    const inflight = await st.get('inflight');
    if (inflight) {
      await st.delete('inflight');
      const waiting = (await st.get('queue')) || [];
      if (!waiting.length && (inflight.resumes || 0) < 1) {
        await st.put('queue', [{ ...inflight, resumes: (inflight.resumes || 0) + 1 }]);
        await telegram(env, `Signal ${inflight.id} was interrupted mid-execution: resuming it once from the current position.`);
      } else {
        await telegram(env, `Signal ${inflight.id} was interrupted mid-execution and is NOT resumed (${waiting.length ? 'a newer signal is waiting' : 'already resumed once'}). Check the position.`);
      }
    }

    const queue = (await st.get('queue')) || [];
    if (!queue.length) return this.reconcile();

    const sig = queue.at(-1);                                    // latest wins
    const skipped = queue.slice(0, -1).map((q) => q.id);
    // The signal moves from the queue to the in-flight marker in ONE write: it is never lost (D4).
    await st.put({ inflight: sig, queue: [] });

    // Anything that fails before execution starts puts the signal back and retries soon.
    let halted;
    try {
      const miss = missingSettings(env);
      if (miss.length) {
        await st.delete('inflight');
        await st.put('last', { signalId: sig.id, refused: `missing settings: ${miss.join(', ')}` });
        await telegram(env, `Signal ${sig.id} refused: missing settings ${miss.join(', ')}.`);
        return;
      }
      halted = (await controlCall(env, '')).halted;
    } catch (e) {
      const tries = (sig.startTries || 0) + 1;
      await st.delete('inflight');
      const now = (await st.get('queue')) || [];
      if (!now.length && tries < MAX_START_TRIES) {
        await st.put('queue', [{ ...sig, startTries: tries }]);
        await st.setAlarm(Date.now() + RETRY_MS);
      }
      await telegram(env, `Signal ${sig.id} could not start (try ${tries}/${MAX_START_TRIES}): ${String(e.message || e).slice(0, 200)}.`
        + (tries < MAX_START_TRIES && !now.length ? ` Retrying in ${RETRY_MS / 1000} s.` : ' Dropped.'));
      return;
    }

    try {
      if (halted) {
        await st.put('last', { signalId: sig.id, refused: 'HALTED' });
        await telegram(env, `Signal ${sig.id} (${sig.side}) refused: engine HALTED. /resume to re-enable.`);
        return;
      }
      // A resumed signal uses new client ids, so Paradex never sees the same client id twice.
      const run = sig.resumes ? { ...sig, id: `${sig.id}-r${sig.resumes}` } : sig;
      const report = await executeSignal(this.px(), run, execConfig(env), {
        log: (m) => console.log(m),
        guard: () => this.guard(),                               // before EVERY order (D2, D3)
      });
      report.skipped = skipped;
      await st.put({ last: report, target: report.target, [`report:${Date.now()}`]: report });
      console.log(JSON.stringify({ event: 'engine.executed', report }));
      const fills = report.legs.flatMap((l) => l.fills.map((f) => `${l.side} ${f.size} @ ${f.price} (${f.method}, ${f.slippageBps} bp)`));
      const why = report.refused || report.stopped || report.legs.map((l) => l.stopped).filter(Boolean).join('; ');
      await telegram(env, `${report.ok ? 'Done' : 'INCOMPLETE'}: ${sig.id} ${sig.side}. Position ${report.before} -> ${report.after} (target ${report.target}).`
        + (fills.length ? `\n${fills.join('\n')}` : '') + (report.ok ? '' : `\nGap ${report.gap ?? report.target}. ${why}`));
    } catch (e) {
      await st.put('last', { signalId: sig.id, error: String(e.message || e) });
      await telegram(env, `Signal ${sig.id} FAILED: ${String(e.message || e).slice(0, 300)}`);
    } finally {
      await st.delete('inflight');
    }
  }

  // Checked before every order. Returns null to allow it, or the reason to stop.
  async guard() {
    if ((await controlCall(this.env, '')).halted) return 'HALTED';
    const d = await this.dailyLoss();
    if (d.breached) return `MAX_DAILY_LOSS reached (lost ${d.loss.toFixed(2)} since ${d.date} 00:00 UTC): engine HALTED`;
    return null;
  }

  // Daily loss = account value at the day's first reading - account value now (UTC days).
  // A deposit or withdrawal moves this number too: halt before moving funds.
  // On a breach: persistent HALT and one Telegram alert.
  async dailyLoss() {
    const st = this.ctx.storage, env = this.env;
    const value = Number((await this.px().account()).account_value);
    if (!Number.isFinite(value)) throw new Error('no account_value in /account');
    const date = new Date().toISOString().slice(0, 10);
    let day = await st.get('day');
    if (!day || day.date !== date) { day = { date, start: value }; await st.put('day', day); }
    const loss = day.start - value;
    const breached = loss >= Number(env.MAX_DAILY_LOSS);
    if (breached && !day.breached) {
      await controlCall(env, '/halt?by=max_daily_loss');
      await st.put('day', { ...day, breached: true });
      await telegram(env, `MAX_DAILY_LOSS: account value ${day.start.toFixed(2)} -> ${value.toFixed(2)} today. Engine HALTED. Positions untouched; /flatten to close.`);
    }
    return { date, start: day.start, value, loss, breached };
  }

  // Every minute: position vs target, daily loss (even with no signal), and old idempotency keys.
  async reconcile() {
    const st = this.ctx.storage, env = this.env;
    try {
      const target = await st.get('target');
      if (target !== undefined) {
        const px = this.px();
        const spec = await px.market(env.MARKET);
        const pos = signedPosition(await px.positions(), env.MARKET);
        const gap = toInt8(target) - pos;
        const gapAbs = gap < 0n ? -gap : gap;
        const alerted = await st.get('gapAlerted');
        if (gapAbs >= toInt8(spec.order_size_increment)) {
          if (alerted !== fromInt8(gap)) {
            await telegram(env, `RECONCILE: position ${fromInt8(pos)} but target ${target} (gap ${fromInt8(gap)}). Check before the next signal.`);
            await st.put('gapAlerted', fromInt8(gap));
          }
        } else if (alerted) {
          await st.delete('gapAlerted');
          await telegram(env, 'RECONCILE: position back on target.');
        }
      }
      if (Number(env.MAX_DAILY_LOSS) > 0) await this.dailyLoss();
    } catch (e) {
      console.log(JSON.stringify({ event: 'engine.reconcile_failed', error: String(e.message || e) }));
    }
    const old = [...(await st.list({ prefix: 'seen:' })).entries()].filter(([, at]) => Date.now() - at > SEEN_TTL_MS).map(([k]) => k);
    for (let i = 0; i < old.length; i += 128) await st.delete(old.slice(i, i + 128));
  }
}
const engine = (env) => env.ENGINE.get(env.ENGINE.idFromName(env.MARKET || 'BTC-USD-PERP'));

const control = (env) => env.CONTROL.get(env.CONTROL.idFromName('account'));
const controlCall = async (env, path) => (await control(env).fetch(`https://control${path}`)).json();

// ---------- Paradex and Telegram ----------
// The kill switch uses its own subkey, so it still works if the engine's key is revoked.
// On prod the Engine refuses to trade without it (missingSettings); here it falls back to the
// engine key rather than refuse to act in an emergency.
const paradex = (env, { kill = false } = {}) => new Paradex({
  env: env.PARADEX_ENV,
  account: env.PARADEX_ACCOUNT,
  privateKey: (kill && env.PARADEX_KILL_PRIVATE_KEY) || env.PARADEX_PRIVATE_KEY,
  interactive: env.PARADEX_INTERACTIVE === 'true',
});

async function telegram(env, text, chatId = env.TELEGRAM_CHAT_ID) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return r.ok;
}

// The Telegram webhook secret is derived from ADMIN_TOKEN, so the user never has to create
// one more password. TELEGRAM_WEBHOOK_SECRET, if set, still takes precedence.
async function webhookSecret(env) {
  if (env.TELEGRAM_WEBHOOK_SECRET) return env.TELEGRAM_WEBHOOK_SECRET;
  if (!env.ADMIN_TOKEN) return '';
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`dts-telegram-webhook:${env.ADMIN_TOKEN}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const allowedUsers = (env) => String(env.TELEGRAM_USER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
const telegramLinked = (env) => Boolean(env.TELEGRAM_CHAT_ID) && allowedUsers(env).length > 0;

// Secrets the bot needs, by name. /health reports which are set, never their values.
export const SECRET_NAMES = ['PARADEX_ACCOUNT', 'PARADEX_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'SIGNAL_SECRET', 'ADMIN_TOKEN'];
const OPTIONAL_SECRETS = ['PARADEX_KILL_PRIVATE_KEY', 'ALERT_SECRET'];
const looksSet = (v) => typeof v === 'string' && v.trim().length > 0 && !/^(later|todo|x|-)$/i.test(v.trim());

const page = (title, body) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222}input,button{font:inherit;padding:10px;width:100%;box-sizing:border-box;margin:8px 0}button{background:#222;color:#fff;border:0;border-radius:6px}.ok{color:#176b2c}.bad{color:#a61b1b}</style>
</head><body><h1>${title}</h1>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const list = (r) => (Array.isArray(r) ? r : r?.results || []);

async function killAll(env) {
  const halt = await controlCall(env, '/halt');                 // 1. persistent halt first
  const px = paradex(env, { kill: true });
  await px.cancelAll();                                           // 2. cancel everything
  let open = [];
  for (let i = 0; i < 3; i++) {                                   // 3. verify, up to 3 reads
    await new Promise((r) => setTimeout(r, 1000));
    open = list(await px.openOrders());
    if (open.length === 0) break;
  }
  return { halted: Boolean(halt.halted), openOrdersLeft: open.length };
}

// Closes each open position with a reduce-only IOC LIMIT order capped FLATTEN_CAP_BPS (default
// 100 = 1%) beyond the touch, never a market order (review D6). Then re-reads the positions.
async function flatten(env) {
  const state = await controlCall(env, '');
  if (!state.halted) return { refused: 'send /killall first: flatten only runs while halted' };
  const px = paradex(env, { kill: true });
  const capBps = Number(env.FLATTEN_CAP_BPS || 100);
  const sent = [];
  for (const p of list(await px.positions())) {
    const raw = String(p.size ?? '0');
    if (Number(raw) === 0 || (p.status && p.status !== 'OPEN')) continue;
    const isLong = p.side ? p.side === 'LONG' : !raw.startsWith('-');
    const side = isLong ? 'SELL' : 'BUY';
    const spec = await px.market(p.market);
    const size = floorToStep(raw.replace('-', ''), spec.order_size_increment);
    const top = await px.bestPrices(p.market);
    const touch = side === 'SELL' ? top.bid : top.ask;
    if (!touch) { sent.push({ market: p.market, side, size, skipped: `no ${side === 'SELL' ? 'buyers' : 'sellers'} in the book` }); continue; }
    const price = side === 'SELL'
      ? ceilToTick(Number(touch) * (1 - capBps / 10_000), spec.price_tick_size)
      : floorToTick(Number(touch) * (1 + capBps / 10_000), spec.price_tick_size);
    const r = await px.placeOrder({
      market: p.market, side, type: 'LIMIT', size, price,
      instruction: 'IOC', flags: ['REDUCE_ONLY'], clientId: `dts-flatten-${p.market}-${Date.now()}`,
    });
    sent.push({ market: p.market, side, size, price, id: r.id });
  }
  await new Promise((r) => setTimeout(r, 1500));                  // Retail processing delay, with margin
  const left = list(await px.positions())
    .filter((p) => Number(p.size ?? 0) !== 0 && (!p.status || p.status === 'OPEN'))
    .map((p) => `${p.market} ${p.side || ''} ${p.size}`);
  return { orders: sent, positionsLeft: left };
}

// ---------- routes ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const secrets = Object.fromEntries([...SECRET_NAMES, ...OPTIONAL_SECRETS].map((n) => [n, looksSet(env[n])]));
      return Response.json({
        ok: true, env: env.PARADEX_ENV, market: env.MARKET,
        secrets, missing: SECRET_NAMES.filter((n) => !secrets[n]),
        telegramLinked: telegramLinked(env),
        limits: { orderSize: env.ORDER_SIZE, maxPosition: env.MAX_POSITION, maxDailyLoss: env.MAX_DAILY_LOSS, mode: env.EXEC_MODE },
        missingSettings: missingSettings(env),
      });
    }

    // One-time Telegram link: registers this Worker as the bot's webhook, with a secret derived
    // from ADMIN_TOKEN. The token is typed into the page, never put in a URL.
    if (url.pathname === '/setup') {
      if (request.method !== 'POST') {
        return page('Link your Telegram bot', `<p>Paste your <b>Admin token</b> from Apple Passwords, then press the button. This connects your Telegram bot to this DTS bot.</p>
<form method="post"><input type="password" name="token" placeholder="Admin token" autocomplete="off" required><button type="submit">Link Telegram</button></form>`);
      }
      const form = await request.formData().catch(() => null);
      if (!safeEqual(form?.get('token'), env.ADMIN_TOKEN)) return page('Not linked', '<p class="bad">That admin token is not the one set in Cloudflare. Go back and paste it again.</p>');
      if (!looksSet(env.TELEGRAM_BOT_TOKEN)) return page('Not linked', '<p class="bad">The Telegram bot token is not set in Cloudflare yet.</p>');
      const hook = `${url.origin}/telegram`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: hook, secret_token: await webhookSecret(env), allowed_updates: ['message'], drop_pending_updates: true }),
      });
      const out = await r.json().catch(() => ({}));
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: [
          { command: 'status', description: 'Position, limits, last signal' },
          { command: 'check', description: 'Testnet check: tiny order, read back, cancel' },
          { command: 'killall', description: 'Halt and cancel every order' },
          { command: 'flatten', description: 'While halted: close positions' },
          { command: 'resume', description: 'Lift the halt' },
        ] }),
      }).catch(() => {});
      return out.ok
        ? page('Telegram linked', `<p class="ok">Done. Now open your bot in Telegram and send <b>/start</b>.</p>`)
        : page('Not linked', `<p class="bad">Telegram refused: ${esc(out.description || r.status)}. Check the bot token in Cloudflare.</p>`);
    }

    if (url.pathname === '/probe') {
      const out = {};
      try { out.egress = (await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()).split('\n').filter((l) => /^(ip|colo|loc)=/.test(l)); } catch (e) { out.egress = String(e); }
      for (const [name, base] of Object.entries(BASES)) {
        for (const path of ['/system/config', '/bbo/BTC-USD-PERP']) {
          try {
            const t0 = Date.now();
            const r = await fetch(base + path);
            out[`${name} ${path}`] = { status: r.status, ms: Date.now() - t0 };
          } catch (e) { out[`${name} ${path}`] = { error: String(e) }; }
        }
      }
      return Response.json(out);
    }

    if (url.pathname === '/check') {
      if (!safeEqual(request.headers.get('x-admin-token'), env.ADMIN_TOKEN)) return new Response('forbidden', { status: 403 });
      const lines = [];
      try {
        await runCheck(paradex(env), env.MARKET, (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
      } catch { /* the failing step is already in lines */ }
      return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === '/alert' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !safeEqual(body.secret, env.ALERT_SECRET || env.SIGNAL_SECRET)) return new Response('forbidden', { status: 403 });
      const age = Date.now() - toMs(body.ts);
      if (!(Math.abs(age) <= MAX_ALERT_AGE_MS)) return new Response('stale or missing ts', { status: 400 });
      const { secret, ...rest } = body;
      await telegram(env, `Alert received: ${JSON.stringify(rest)}`);
      return Response.json({ relayed: true });
    }

    if (url.pathname === '/signal' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !safeEqual(body.secret, env.SIGNAL_SECRET)) return new Response('forbidden', { status: 403 });
      const age = Date.now() - toMs(body.ts);
      if (!(Math.abs(age) <= MAX_ALERT_AGE_MS)) return new Response('stale or missing ts', { status: 400 });
      const id = String(body.id || '');
      if (!/^[A-Za-z0-9._:-]{1,48}$/.test(id)) return new Response('bad id: 1 to 48 of A-Z a-z 0-9 . _ : -', { status: 400 });
      if (!['long', 'short', 'flat'].includes(body.side)) return new Response('bad side: long, short or flat', { status: 400 });
      const sig = { id, side: body.side, source: body.source };
      if (body.price !== undefined) { if (!(Number(body.price) > 0)) return new Response('bad price', { status: 400 }); sig.price = Number(body.price); }
      if (body.size !== undefined) {
        if (!(Number(body.size) > 0)) return new Response('bad size', { status: 400 });
        if (!(Number(body.size) <= Number(env.MAX_POSITION))) return new Response('size above MAX_POSITION', { status: 400 });
        sig.size = String(body.size);
      }
      return engine(env).fetch('https://engine/signal', { method: 'POST', body: JSON.stringify(sig) });
    }

    if (url.pathname === '/engine') {
      if (!safeEqual(request.headers.get('x-admin-token'), env.ADMIN_TOKEN)) return new Response('forbidden', { status: 403 });
      return engine(env).fetch('https://engine/state');
    }

    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (!safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), await webhookSecret(env))) return new Response('forbidden', { status: 403 });
      const update = await request.json().catch(() => ({}));
      const msg = update.message;
      if (!msg) return new Response('ignored');
      const first = (msg.text || '').trim().split(/\s+/)[0].replace(/@\w+$/, '');
      // Not linked yet: /start answers with the numbers the owner gives Claude. Nothing else works.
      if (!telegramLinked(env)) {
        if (first === '/start') {
          await telegram(env, `Hello. To finish linking, give Claude these two numbers:\nChat number: ${msg.chat?.id}\nUser number: ${msg.from?.id}\nUntil then this bot obeys no command.`, msg.chat?.id);
        }
        return new Response('not linked');
      }
      // Allowed chat AND allowed sender (review D8): anyone added to the chat cannot command the bot.
      if (String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID) || !allowedUsers(env).includes(String(msg.from?.id))) return new Response('ignored');
      const cmd = first;
      try {
        if (cmd === '/start' || cmd === '/help') {
          await telegram(env, 'Linked. Commands: /status, /check, /killall, /flatten, /resume.');
        }
        if (cmd === '/check') {
          if (env.PARADEX_ENV === 'prod') { await telegram(env, '/check runs on the testnet only.'); }
          else {
            const lines = [];
            try { await runCheck(paradex(env), env.MARKET, (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))); } catch { /* failing step already logged */ }
            await telegram(env, `Testnet check:\n${lines.join('\n').slice(0, 3500)}`);
          }
        }
        if (cmd === '/status') {
          const s = await controlCall(env, '');
          const e = await (await engine(env).fetch('https://engine/state')).json();
          const last = e.last ? `${e.last.signalId} ${e.last.ok === false ? 'INCOMPLETE' : e.last.error ? 'FAILED' : e.last.refused || 'ok'}` : 'none';
          await telegram(env, `Alive. Paradex ${env.PARADEX_ENV}, ${env.MARKET}, mode ${env.EXEC_MODE || 'taker'}. Halted: ${s.halted ? 'YES' : 'no'}. Target ${e.target ?? 'none'}. Last signal: ${last}.`);
        }
        if (cmd === '/killall') {
          const r = await killAll(env);
          await telegram(env, r.openOrdersLeft === 0
            ? 'Kill switch: HALTED, all orders cancelled and verified. Positions untouched; /flatten to close them.'
            : `Kill switch: HALTED, but ${r.openOrdersLeft} order(s) still open after 3 checks. Act manually now.`);
        }
        if (cmd === '/flatten') {
          const r = await flatten(env);
          await telegram(env, r.refused ? `Flatten refused: ${r.refused}`
            : `Flatten: ${r.orders.length} order(s) sent. Positions left: ${r.positionsLeft.length ? r.positionsLeft.join('; ') + ' -> /flatten again or act manually' : 'none'}.`
              + (r.orders.some((o) => o.skipped) ? `\n${r.orders.filter((o) => o.skipped).map((o) => `${o.market}: ${o.skipped}`).join('\n')}` : ''));
        }
        if (cmd === '/resume') { await controlCall(env, '/resume'); await telegram(env, 'Resumed: halt flag cleared.'); }
      } catch (e) {
        await telegram(env, `${cmd} FAILED: ${String(e.message || e).slice(0, 300)}`);
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },
};
