// DTS bot Worker. Routes:
//   GET  /health     liveness, plus which secrets are set (names only, never values)
//   GET  /probe      can Cloudflare reach Paradex and Binance, near the caller and from the engine? No key needed
//   GET  /setup      one-time page: links Telegram to this bot (asks for the admin token)
//   GET  /check      the Paradex check: tiny orders far from the price, cancelled (header x-admin-token required)
//   POST /alert      relays a TradingView/MMT test alert to Telegram (secret + fresh ts in the body)
//   POST /tick       a charting tool's 1-minute bar-close alert {src?, bar, ts?, price}: delays per tool, for /latency. Never trades.
//   POST /signal     Track A: a directional signal {id, side: long|short|flat, price?, size?} for the Engine
//   GET  /engine     the Engine's state: last report, target, queue (header x-admin-token required)
//   POST /telegram   Telegram webhook, allowed chat only:
//                    /status, /check, /spread [7d|full] (Paradex health: price vs mark, spread, speed), /latency [7d], /killall (halt + cancel all + verify + re-protect), /flatten (capped reduce-only IOC, needs halt), /resume
//                    (allowed chat AND allowed sender ids)
import { DurableObject } from 'cloudflare:workers';
import { Paradex, BASES } from './paradex-client.js';
import { runCheck } from './check.js';
import { executeSignal, signedPosition, DEFAULTS } from './executor.js';
import { toInt8, fromInt8, floorToStep, floorToTick, ceilToTick } from './paradex-client.js';
import { syncDisasterStop, describeStop, DEFAULT_STOP_BPS } from './disaster.js';
import { takeSample, summarise, describeNow, pingParadex, timedClient, timingLine, priceLine, binanceSymbol, SAMPLE_PREFIX, KEEP_MS,
  TICK_PREFIX, ORDER_PREFIX, TG_PREFIX, fromToolPayload, tickDelays, summariseTicks, describeTicks, markGaps, describeMark, shortReport, latencyReport, moduleReport } from './market-watch.js';
import { VERSION } from './version.js';

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
  reference: env.PRICE_REFERENCE || 'venue',                  // the cap is set around the Paradex mid
  maxMarkGapBps: Number(env.MAX_MARK_GAP_BPS || 50),          // mid more than 0.5% from mark: don't trade
  takerAttempts: Number(env.TAKER_ATTEMPTS || DEFAULTS.takerAttempts),
  makerWindowMs: Number(env.MAKER_WINDOW_MS || DEFAULTS.makerWindowMs),
  makerReposts: Number(env.MAKER_REPOSTS || DEFAULTS.makerReposts),
  pollMs: DEFAULTS.pollMs,
});
const RECONCILE_MS = 60_000;
const RETRY_MS = 10_000;              // a signal that could not start is retried this soon
const MAX_START_TRIES = 3;
const SEEN_TTL_MS = 7 * 86_400_000;   // idempotency keys kept 7 days
const stopBps = (env) => Number(env.DISASTER_STOP_BPS || DEFAULT_STOP_BPS);

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
    // Any contact starts the minute loop (reconcile, disaster stop, samples) if it is not running:
    // a new engine starts it at its first /status or /spread, not only at its first signal.
    if (!(await st.getAlarm())) await st.setAlarm(Date.now() + 1000);
    if (url.pathname === '/signal') {
      const sig = await request.json();
      if (await st.get(`seen:${sig.id}`)) return Response.json({ duplicate: true, id: sig.id });
      const queue = (await st.get('queue')) || [];
      queue.push({ ...sig, receivedAt: Date.now() });
      await st.put({ [`seen:${sig.id}`]: Date.now(), queue });   // one atomic write
      await st.setAlarm(Date.now());
      return Response.json({ queued: true, id: sig.id }, { status: 202 });
    }
    if (url.pathname === '/tick') {
      const k = await request.json();
      const engineAt = Date.now();
      const dry = await this.dryRun().catch((e) => ({ stopped: String(e.message || e).slice(0, 120) }));   // the order path, timed
      const pd = await takeSample(this.px(), this.env.MARKET, { binance: false }).then((x) => x.pd).catch(() => null);
      const rec = { t: k.edgeAt, src: k.src, price: k.price, pd, dry, from: k.from, delays: tickDelays({ ...k, engineAt }) };
      await st.put(`${TICK_PREFIX}${String(k.edgeAt).padStart(15, '0')}`, rec);
      const stale = [...(await st.list({ prefix: TICK_PREFIX, end: `${TICK_PREFIX}${String(Date.now() - KEEP_MS).padStart(15, '0')}` })).keys()];
      for (let i = 0; i < stale.length; i += 128) await st.delete(stale.slice(i, i + 128));
      return Response.json({ recorded: true });
    }
    if (url.pathname === '/probe') return Response.json(await probeFromHere());
    if (url.pathname === '/latency') {
      const days = url.searchParams.get('range') === '7d' ? 7 : 1;
      const since = `${String(Date.now() - days * 86_400_000).padStart(15, '0')}`;
      const label = days === 7 ? '7d' : '24h';
      const ticks = [...(await st.list({ prefix: TICK_PREFIX, start: `${TICK_PREFIX}${since}` })).values()];
      if (!url.searchParams.get('full')) {
        const tg = [...(await st.list({ prefix: TG_PREFIX, start: `${TG_PREFIX}${since}` })).values()];
        return new Response(moduleReport({ ticks, tg, label }), { headers: { 'content-type': 'text/plain' } });
      }
      const samples = [...(await st.list({ prefix: SAMPLE_PREFIX, start: `${SAMPLE_PREFIX}${since}` })).values()];
      const orders = [...(await st.list({ prefix: ORDER_PREFIX, start: `${ORDER_PREFIX}${since}` })).values()];
      return new Response(latencyReport({ ticks, samples, orders, label }), { headers: { 'content-type': 'text/plain' } });
    }
    if (url.pathname === '/tg') {
      // One Telegram command's timings (side path, not the order path). Kept as long as the ticks.
      const r = await request.json();
      await st.put(`${TG_PREFIX}${String(Date.now()).padStart(15, '0')}`, { inMs: r.inMs, sendMs: r.sendMs });
      const stale = [...(await st.list({ prefix: TG_PREFIX, end: `${TG_PREFIX}${String(Date.now() - KEEP_MS).padStart(15, '0')}` })).keys()];
      for (let i = 0; i < stale.length; i += 128) await st.delete(stale.slice(i, i + 128));
      return Response.json({ recorded: true });
    }
    if (url.pathname === '/market') {
      const days = url.searchParams.get('range') === '7d' ? 7 : 1;
      const text = url.searchParams.get('full') ? await this.marketReport() : await this.shortMarket(days);
      return new Response(text, { headers: { 'content-type': 'text/plain' } });
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
    // A retired engine (ENGINE_REGION changed) stops its minute loop and forgets its state, so two
    // engines never manage the same account. Its disaster stops are left to the new engine.
    if (this.ctx.id.toString() !== engineId(this.env).toString()) {
      console.log(JSON.stringify({ event: 'engine.retired', id: this.ctx.id.toString() }));
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
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
      const marks = { start: Date.now() };                     // timing of this signal (read-only)
      const report = await executeSignal(timedClient(this.px(), marks), run, execConfig(env), {
        log: (m) => console.log(m),
        guard: () => this.guard(),                               // before EVERY order (D2, D3)
      });
      report.skipped = skipped;
      await st.put({ last: report, target: report.target, [`report:${Date.now()}`]: report,
        // timings of this real order, for /latency next to the dry runs
        [`${ORDER_PREFIX}${String(Date.now()).padStart(15, '0')}`]: { src: sig.source, edgeAt: sig.edgeAt, receivedAt: sig.receivedAt, ...marks, book: undefined } });
      console.log(JSON.stringify({ event: 'engine.executed', report }));
      const fills = report.legs.flatMap((l) => l.fills.map((f) => `${l.side} ${f.size} @ ${f.price} (${f.method}, ${f.slippageBps} bp)`));
      const prices = priceLine(sig, marks, report.legs.flatMap((l) => l.fills), report);
      const why = report.refused || report.stopped || report.legs.map((l) => l.stopped).filter(Boolean).join('; ');
      // Every position gets its disaster stop at Paradex right after execution.
      let stopLine;
      try { stopLine = describeStop(await syncDisasterStop(this.px(), env.MARKET, { bps: stopBps(env) })); }
      catch (e) { stopLine = `DISASTER STOP FAILED: ${String(e.message || e).slice(0, 200)}. Check the position now.`; }
      await telegram(env, `${report.ok ? 'Done' : 'INCOMPLETE'}: ${sig.id} ${sig.side}. Position ${report.before} -> ${report.after} (target ${report.target}).`
        + (fills.length ? `\n${fills.join('\n')}` : '') + (report.ok ? '' : `\nGap ${report.gap ?? report.target}. ${why}`) + `\n${stopLine}`
        + `\n${timingLine(sig, marks)}` + (prices ? `\n${prices}` : ''));
      console.log(JSON.stringify({ event: 'engine.timing', id: sig.id, tvAt: sig.tvAt, edgeAt: sig.edgeAt, edgeColo: sig.edgeColo, receivedAt: sig.receivedAt, ...marks, tvPrice: sig.price }));
    } catch (e) {
      await st.put('last', { signalId: sig.id, error: String(e.message || e) });
      await telegram(env, `Signal ${sig.id} FAILED: ${String(e.message || e).slice(0, 300)}`);
    } finally {
      await st.delete('inflight');
    }
  }

  // Latency of the order path, without trading: the exact code a real signal runs (same Paradex reads,
  // same guard), stopped where the order would leave. Then one signed Paradex request, the closest
  // stand-in for an order's acknowledgement. Two locks keep it read-only: the executor stops before
  // placeOrder in dry-run mode, and the client it is given refuses any order or cancel.
  // Each step is timed on its own (steps, in order), so /latency shows where the checks' time goes.
  async dryRun() {
    const real = this.px();
    const steps = [];
    const timed = async (label, fn) => { const a = Date.now(); try { return await fn(); } finally { steps.push([label, Date.now() - a]); } };
    const LABEL = { market: 'market', positions: 'position', bestPrices: 'book', marketSummary: 'mark' };
    const readOnly = new Proxy(real, {
      get(t, k) {
        const v = t[k];
        if (['placeOrder', 'cancelOrder', 'cancelAll'].includes(k)) return async () => { throw new Error('dry run: orders are blocked'); };
        if (typeof v !== 'function') return v;
        return (...a) => timed(LABEL[k] || String(k).slice(0, 9), () => v.apply(t, a));
      },
    });
    // The guard's two parts, timed apart: the pause flag (Control object) and the account value (daily
    // loss). Both are always read here, as when the bot runs; the real guard skips the second while paused.
    const guard = async () => {
      await timed('pause', () => controlCall(this.env, ''));
      if (Number(this.env.MAX_DAILY_LOSS) > 0) await timed('account', () => this.dailyLoss());
      return null;
    };
    const t0 = Date.now();
    let ready = null, ack = null, before = [];
    const report = await executeSignal(readOnly, { id: `dry-${t0}`, side: 'flat' }, { ...execConfig(this.env), dryRun: true }, {
      guard,
      onReady: async () => { ready = Date.now(); before = steps.slice(); await real.openOrders(this.env.MARKET); ack = Date.now() - ready; },
    });
    if (!ready) return { stopped: String(report.refused || report.stopped || 'no order path').slice(0, 120) };
    return { checks: ready - t0, ack, via: 'rest', steps: before };   // steps up to the moment the order would leave
  }

  // /spread (and /spread 7d): the short report. Verdict, now, then p50 / p99 / max over the range.
  async shortMarket(days = 1) {
    const env = this.env, st = this.ctx.storage;
    const now = await takeSample(this.px(), env.MARKET, { binance: false });
    try { const m = await this.px().marketSummary(env.MARKET); now.mark = Number(m.mark_price); } catch { /* verdict says unavailable */ }
    const since = Date.now() - days * 86_400_000;
    const samples = [...(await st.list({ prefix: SAMPLE_PREFIX, start: `${SAMPLE_PREFIX}${String(since).padStart(15, '0')}` })).values()];
    let status = '';
    try {
      const pos = signedPosition(await this.px().positions(), env.MARKET);
      const halted = (await controlCall(env, '')).halted;
      status = `${pos === 0n ? 'Flat' : `${pos > 0n ? 'Long' : 'Short'} ${fromInt8(pos < 0n ? -pos : pos)}`} · bot ${halted ? 'paused' : 'running'}`;
    } catch (e) { status = `Position unknown (${String(e.message || e).slice(0, 80)})`; }
    return shortReport({ now, samples, guard: Number(env.MAX_MARK_GAP_BPS || 50), label: days === 7 ? '7d' : '24h', status });
  }

  // /spread full: where the engine runs, how fast Paradex answers from there, and Binance vs Paradex.
  async marketReport() {
    const env = this.env, st = this.ctx.storage, lines = [];
    try {
      const tr = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
      const g = (k) => (tr.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
      lines.push(`Engine runs in Cloudflare ${g('colo') || '?'} (${g('loc') || '?'}).`);
    } catch { lines.push('Engine location unknown.'); }
    const p = await pingParadex(BASES[env.PARADEX_ENV] || BASES.prod);
    lines.push(p.n ? `Paradex round trip from there: ${Math.round(p.rttMedian)} ms typical, ${p.rttMin} ms best (${p.n} tries). Paradex clock ${p.clockOffset >= 0 ? '+' : ''}${Math.round(p.clockOffset)} ms vs ours.` : 'Paradex did not answer.');
    const now = await takeSample(this.px(), env.MARKET, { binance: env.BINANCE_DIRECT === 'true', symbol: binanceSymbol(env.MARKET, env.BINANCE_SYMBOL) });
    if (now.pd) lines.push(`Paradex now: ${now.pd.bid}/${now.pd.ask} (spread ${(now.pd.ask - now.pd.bid).toFixed(1)} USD).`);
    try {
      const m = await this.px().marketSummary(env.MARKET);
      const g = markGaps({ ...now, mark: m.mark_price, last: m.last_traded_price, index: m.underlying_price });
      lines.push(`Mark ${Number(m.mark_price).toFixed(1)}, last trade ${m.last_traded_price}, index (oracle) ${Number(m.underlying_price).toFixed(1)}.`
        + (g.mid != null ? ` Mid ${g.mid >= 0 ? '+' : ''}${g.mid.toFixed(1)} bp vs mark (guard ${Number(env.MAX_MARK_GAP_BPS || 50)} bp).` : ''));
    } catch { lines.push('Mark price unavailable: signals would be refused.'); }
    const ownAll = [...(await st.list({ prefix: SAMPLE_PREFIX })).values()].filter((x) => x.t > Date.now() - 86_400_000);
    const limitBps = Number(env.MAX_MARK_GAP_BPS || 50);
    lines.push(describeMark('Liquidity, last hour', ownAll.filter((x) => x.t > Date.now() - 3_600_000), limitBps));
    lines.push(describeMark('Liquidity, last 24 h', ownAll, limitBps));
    if (now.bn) lines.push(describeNow(now));
    const ticks = [...(await st.list({ prefix: TICK_PREFIX })).values()].filter((k) => k.t > Date.now() - 86_400_000);
    const last = ticks.findLast((k) => k.price > 0 && (k.src || 'tradingview') === 'tradingview') || ticks.findLast((k) => k.price > 0);
    if (last) lines.push(`Last ${last.src || 'tradingview'} tick ${Math.round((Date.now() - last.t) / 1000)} s ago: Binance close ${last.price}.`);
    lines.push(describeTicks('Last hour', summariseTicks(ticks.filter((k) => k.t > Date.now() - 3_600_000))));
    lines.push(describeTicks('Last 24 h', summariseTicks(ticks)));
    const own = ownAll.filter((x) => x.pd);
    if (own.length) lines.push(`Engine's own minute checks (${own.length}): Paradex answers in ${Math.round(summarise(own).pdMs)} ms typical.`);
    try {
      const m = await this.px().market(env.MARKET);
      lines.push(`Paradex ${env.MARKET}: tick ${m.price_tick_size} USD, size step ${m.order_size_increment}, minimum order ${m.min_notional} USD.`);
    } catch { /* optional */ }
    lines.push('1 bp = 0.01%. A negative gap means Paradex is cheaper than Binance. Binance quotes in USDT, Paradex in USD.');
    return lines.join('\n');
  }

  // Liquidity watch, every minute: Paradex mid vs mark. One Telegram alert when the gap passes
  // MAX_MARK_GAP_BPS (signals would be refused), one when it is back.
  async markWatch(s) {
    const st = this.ctx.storage, env = this.env;
    const g = markGaps(s);
    if (g.mid == null) return;
    const limit = Number(env.MAX_MARK_GAP_BPS || 50);
    const wide = Math.abs(g.mid) > limit;
    const was = await st.get('markAlerted');
    if (wide && !was) {
      await st.put('markAlerted', Date.now());
      await telegram(env, `LIQUIDITY: Paradex mid is ${g.mid.toFixed(1)} bp from the mark price (limit ${limit}). Signals are refused until it narrows. Spread ${g.spread.toFixed(1)} bp, last trade ${g.last == null ? '?' : g.last.toFixed(1)} bp from mark.`);
    } else if (!wide && was) {
      await st.delete('markAlerted');
      await telegram(env, `LIQUIDITY: back to normal, Paradex mid ${g.mid.toFixed(1)} bp from the mark price.`);
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
    const value = Number((await this.px().accountInfo()).account_value);
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
    // Every minute: a position without its disaster stop gets one; a stop without a position goes.
    try {
      const s = await syncDisasterStop(this.px(), env.MARKET, { bps: stopBps(env) });
      if (s.action === 'placed' || s.action === 'cancelled') await telegram(env, `RECONCILE: ${describeStop(s)}`);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      if ((await st.get('stopAlerted')) !== msg) { await st.put('stopAlerted', msg); await telegram(env, `RECONCILE: DISASTER STOP FAILED: ${msg}`); }
    }
    // Every minute: one Paradex sample for /spread (book, response time), kept 24 hours. Never blocks the rest.
    try {
      const s = await takeSample(this.px(), env.MARKET, { binance: env.BINANCE_DIRECT === 'true', symbol: binanceSymbol(env.MARKET, env.BINANCE_SYMBOL) });
      try {
        const m = await this.px().marketSummary(env.MARKET);
        s.mark = Number(m.mark_price); s.last = Number(m.last_traded_price); s.index = Number(m.underlying_price);
      } catch { /* the sample is kept without them */ }
      await this.markWatch(s);
      await st.put(`${SAMPLE_PREFIX}${String(s.t).padStart(15, '0')}`, s);
      const stale = [...(await st.list({ prefix: SAMPLE_PREFIX, end: `${SAMPLE_PREFIX}${String(Date.now() - KEEP_MS).padStart(15, '0')}` })).keys()];
      for (let i = 0; i < stale.length; i += 128) await st.delete(stale.slice(i, i + 128));
    } catch (e) {
      console.log(JSON.stringify({ event: 'engine.sample_failed', error: String(e.message || e) }));
    }
    const old = [...(await st.list({ prefix: 'seen:' })).entries()].filter(([, at]) => Date.now() - at > SEEN_TTL_MS).map(([k]) => k);
    for (let i = 0; i < old.length; i += 128) await st.delete(old.slice(i, i + 128));
  }
}
// The engine lives where ENGINE_REGION says (a Cloudflare location hint, e.g. "apac" for Asia,
// close to Paradex). A Durable Object never moves: a new region means a new engine, created empty,
// and the old one retires itself at its next alarm (see Engine.alarm). Change it only when flat.
const engineName = (env) => `${env.MARKET || 'BTC-USD-PERP'}${env.ENGINE_REGION ? `@${env.ENGINE_REGION}` : ''}`;
const engineId = (env) => env.ENGINE.idFromName(engineName(env));
const engine = (env) => env.ENGINE.get(engineId(env), env.ENGINE_REGION ? { locationHint: env.ENGINE_REGION } : undefined);

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

// Every message ends with the bot's version (the pull request it runs), so it is clear which code sent it.
async function telegram(env, text, chatId = env.TELEGRAM_CHAT_ID, parseMode) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `${text}\nbot ${VERSION}`, ...(parseMode ? { parse_mode: parseMode } : {}) }),
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

const COMMANDS = [
  { command: 'status', description: 'Position, limits, last signal' },
  { command: 'check', description: 'Check: tiny order far from the price, cancelled' },
  { command: 'spread', description: 'Paradex health: price vs mark, spread, speed (7d, full)' },
  { command: 'latency', description: 'Bar close to order, by module (7d, full)' },
  { command: 'killall', description: 'Halt and cancel every order' },
  { command: 'flatten', description: 'While halted: close positions' },
  { command: 'resume', description: 'Lift the halt' },
];
const setCommands = (env) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: COMMANDS }),
}).catch(() => {});
const allowedUsers = (env) => String(env.TELEGRAM_USER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
const telegramLinked = (env) => Boolean(env.TELEGRAM_CHAT_ID) && allowedUsers(env).length > 0;

// Secrets the bot needs, by name. /health reports which are set, never their values.
export const SECRET_NAMES = ['PARADEX_ACCOUNT', 'PARADEX_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'SIGNAL_SECRET', 'ADMIN_TOKEN'];
const OPTIONAL_SECRETS = ['PARADEX_KILL_PRIVATE_KEY', 'ALERT_SECRET', 'TICK_SECRET'];
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
  // Cancelling everything also removed the disaster stops: put them back on any open position.
  let protection;
  try { protection = open.length === 0 ? describeStop(await syncDisasterStop(px, env.MARKET, { bps: stopBps(env) })) : 'not re-placed: orders still open'; }
  catch (e) { protection = `DISASTER STOP FAILED: ${String(e.message || e).slice(0, 200)}`; }
  return { halted: Boolean(halt.halted), openOrdersLeft: open.length, protection };
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
  try { await syncDisasterStop(px, env.MARKET, { bps: stopBps(env) }); } catch { /* the minute check retries */ }
  const left = list(await px.positions())
    .filter((p) => Number(p.size ?? 0) !== 0 && (!p.status || p.status === 'OPEN'))
    .map((p) => `${p.market} ${p.side || ''} ${p.size}`);
  return { orders: sent, positionsLeft: left };
}

// Public, read-only reachability test: where this code runs, and whether Paradex and Binance answer
// from there (status and time only; no key is used). /probe runs it near the caller and in the engine.
const PROBE_URLS = {
  'Paradex /system/time': `${BASES.prod}/system/time`,
  'Binance perp': 'https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT',
  'Binance spot (data-api)': 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT',
  'Binance spot (api)': 'https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',
};
async function probeFromHere() {
  const out = {};
  try {
    const tr = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
    out.location = tr.split('\n').filter((l) => /^(colo|loc)=/.test(l)).join(' ');
  } catch (e) { out.location = String(e.message || e); }
  for (const [name, u] of Object.entries(PROBE_URLS)) {
    const t0 = Date.now();
    try { const r = await fetch(u); await r.arrayBuffer(); out[name] = { status: r.status, ms: Date.now() - t0 }; }
    catch (e) { out[name] = { error: String(e.message || e).slice(0, 120) }; }
  }
  return out;
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
      await setCommands(env);
      return out.ok
        ? page('Telegram linked', `<p class="ok">Done. Now open your bot in Telegram and send <b>/start</b>.</p>`)
        : page('Not linked', `<p class="bad">Telegram refused: ${esc(out.description || r.status)}. Check the bot token in Cloudflare.</p>`);
    }

    if (url.pathname === '/probe') {
      // From the Cloudflare location nearest the caller, then from the engine (Seoul, near Paradex).
      const out = { here: await probeFromHere() };
      try { out.engine = await (await engine(env).fetch('https://engine/probe')).json(); } catch (e) { out.engine = { error: String(e.message || e) }; }
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

    // A charting tool's 1-minute bar-close alert on the Binance chart: measures delays and the price gap.
    // "src" names the tool (each gets its own scoreboard in /latency); "ts", its firing time, is optional:
    // without it we still get bar close -> Cloudflare, just not the split. Same secret as signals; never trades.
    // A tool that cannot put a secret in its message (OpenMarket sends its own fixed JSON) proves itself
    // with ?key=TICK_SECRET in the URL instead. That secret opens /tick only: it can never trade.
    if (url.pathname === '/tick' && request.method === 'POST') {
      const edgeAt = Date.now();
      const raw = await request.json().catch(() => null);
      const tool = fromToolPayload(raw);
      const body = tool || raw;
      const allowed = (raw && safeEqual(raw.secret, env.SIGNAL_SECRET)) || safeEqual(url.searchParams.get('key'), env.TICK_SECRET);
      if (!body || !allowed) return new Response('forbidden', { status: 403 });
      const barOpen = toMs(body.bar), tvAt = body.ts === undefined || body.ts === '' ? NaN : toMs(body.ts);
      if (!(Math.abs(edgeAt - barOpen) <= 10 * 60_000)) return new Response('stale or missing bar time', { status: 400 });
      if (Number.isFinite(tvAt) && !(Math.abs(edgeAt - tvAt) <= 5 * 60_000)) return new Response('stale ts', { status: 400 });
      const noPrice = body.price === undefined || body.price === null || body.price === '';   // optional (MMT script alerts have none)
      if (!noPrice && !(Number(body.price) > 0)) return new Response('bad price', { status: 400 });
      const src = String(body.src || 'tradingview').toLowerCase();
      if (!/^[a-z0-9_-]{1,20}$/.test(src)) return new Response('bad src: 1 to 20 of a-z 0-9 _ -', { status: 400 });
      return engine(env).fetch('https://engine/tick', { method: 'POST', body: JSON.stringify({
        src, tvAt, barOpen, interval: String(body.tf ?? '1'), price: noPrice ? null : Number(body.price), edgeAt, edgeColo: request.cf?.colo,
        // where the tool's webhook comes from (Cloudflare's own lookup of the sender's address): information only
        from: { org: request.cf?.asOrganization, city: request.cf?.city, country: request.cf?.country, colo: request.cf?.colo } }) });
    }

    if (url.pathname === '/signal' && request.method === 'POST') {
      const edgeAt = Date.now();
      const body = await request.json().catch(() => null);
      if (!body || !safeEqual(body.secret, env.SIGNAL_SECRET)) return new Response('forbidden', { status: 403 });
      const age = Date.now() - toMs(body.ts);
      if (!(Math.abs(age) <= MAX_ALERT_AGE_MS)) return new Response('stale or missing ts', { status: 400 });
      const id = String(body.id || '');
      if (!/^[A-Za-z0-9._:-]{1,48}$/.test(id)) return new Response('bad id: 1 to 48 of A-Z a-z 0-9 . _ : -', { status: 400 });
      if (!['long', 'short', 'flat'].includes(body.side)) return new Response('bad side: long, short or flat', { status: 400 });
      // tvAt: when TradingView fired ({{timenow}}, to the second); edgeAt: when Cloudflare received it.
      const sig = { id, side: body.side, source: body.source, tvAt: toMs(body.ts), edgeAt, edgeColo: request.cf?.colo };
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
      const inAt = Date.now();
      try {
        if (cmd === '/start' || cmd === '/help') {
          await setCommands(env);                                  // refreshes the menu after an update
          await telegram(env, 'Linked. Commands: /status, /check, /spread, /latency, /killall, /flatten, /resume.');
        }
        if (cmd === '/check') {
          // A post-only bid 10% below the market cannot fill; it is cancelled at once.
          const lines = [];
          try { await runCheck(paradex(env), env.MARKET, (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))); } catch { /* failing step already logged */ }
          await telegram(env, `Check on Paradex ${env.PARADEX_ENV}:\n${lines.join('\n').slice(0, 3500)}`);
        }
        if (cmd === '/spread') {
          // /spread: last 24 h, short. /spread 7d: last 7 days. /spread full: every detail.
          const arg = ((msg.text || '').trim().split(/\s+/)[1] || '').toLowerCase();
          const q = arg === 'full' ? '?full=1' : arg === '7d' ? '?range=7d' : '';
          const text = (await (await engine(env).fetch(`https://engine/market${q}`)).text()).slice(0, 3500);
          if (arg === 'full') await telegram(env, text);
          else await telegram(env, `<pre>${esc(text)}</pre>`, env.TELEGRAM_CHAT_ID, 'HTML');   // fixed-width, so the table lines up
        }
        if (cmd === '/latency') {
          // /latency: the chain by module, last 24 h. Add 7d for 7 days, full for every detail (both work together).
          const args = (msg.text || '').trim().toLowerCase().split(/\s+/).slice(1);
          const q = new URLSearchParams();
          if (args.includes('7d')) q.set('range', '7d');
          if (args.includes('full')) q.set('full', '1');
          const text = (await (await engine(env).fetch(`https://engine/latency${q.toString() ? `?${q}` : ''}`)).text()).slice(0, 3500);
          await telegram(env, `<pre>${esc(text)}</pre>`, env.TELEGRAM_CHAT_ID, 'HTML');
        }
        if (cmd === '/status') {
          const s = await controlCall(env, '');
          const e = await (await engine(env).fetch('https://engine/state')).json();
          const last = e.last ? `${e.last.signalId} ${e.last.ok === false ? 'INCOMPLETE' : e.last.error ? 'FAILED' : e.last.refused || 'ok'}` : 'none';
          await telegram(env, `Alive. Paradex ${env.PARADEX_ENV}, ${env.MARKET}, mode ${env.EXEC_MODE || 'taker'}. Halted: ${s.halted ? 'YES' : 'no'}. Target ${e.target ?? 'none'}. Last signal: ${last}.`);
        }
        if (cmd === '/killall') {
          const r = await killAll(env);
          await telegram(env, (r.openOrdersLeft === 0
            ? 'Kill switch: HALTED, all orders cancelled and verified. Positions untouched; /flatten to close them.'
            : `Kill switch: HALTED, but ${r.openOrdersLeft} order(s) still open after 3 checks. Act manually now.`) + `\n${r.protection}`);
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
      // Side path timings: command in = Telegram's stamp (to the second) -> here; reply sent = our
      // answer, from receiving the command to Telegram accepting the reply. Never blocks the reply.
      const sendMs = Date.now() - inAt, inMs = Number(msg.date) > 0 ? Math.max(0, inAt - Number(msg.date) * 1000) : null;
      try { await engine(env).fetch('https://engine/tg', { method: 'POST', body: JSON.stringify({ inMs, sendMs }) }); } catch { /* measurement only */ }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },
};
