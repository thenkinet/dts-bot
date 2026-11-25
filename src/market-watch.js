// Market watch: how fast each leg is, and how far Paradex trades from Binance.
//
// 1. Per signal: a timing line (TradingView -> Cloudflare -> engine -> Paradex) and a price line
//    (Binance price sent by TradingView vs the Paradex book and the fill).
// 2. Every minute: one sample of Binance and Paradex best prices, kept 24 hours, summarised by /spread.
//
// Binance's futures API refuses some locations (HTTP 451). Then the Binance spot price from Binance's
// official public-data host is used instead, and every line says which one it is.
// Read-only: nothing here places, changes or cancels an order.

export const SAMPLE_PREFIX = 'mw:';   // every minute from the engine: Paradex book and response time
export const TICK_PREFIX = 'tk:';     // every minute from TradingView (/tick): Binance close and the delays
export const KEEP_MS = 24 * 3_600_000;

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const mid = (b, a) => (Number(b) > 0 && Number(a) > 0 ? (Number(b) + Number(a)) / 2 : null);
export const bps = (x, ref) => (x == null || !ref ? null : ((x - ref) / ref) * 10_000);
const f1 = (x) => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(1));
const secs = (ms) => (ms == null || !Number.isFinite(ms) ? '?' : Math.abs(ms) >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// BTC-USD-PERP -> BTCUSDT, unless BINANCE_SYMBOL says otherwise.
export const binanceSymbol = (market, override) => override || `${String(market).split('-')[0]}USDT`;

const SOURCES = [
  { name: 'Binance perp', url: (s) => `https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${s}` },
  { name: 'Binance spot', url: (s) => `https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${s}` },
  { name: 'Binance spot (api)', url: (s) => `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${s}` },
];
let perpRefused = false;   // remembered per instance: no point asking again every minute
let lastBinanceError = null;   // why the last attempt failed, shown by /spread

async function timedJson(url, fetchFn, timeoutMs = 3000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetchFn(url, { signal: ctl.signal });
    const ms = Date.now() - t0;
    return { status: r.status, ms, json: r.ok ? await r.json() : null };
  } finally { clearTimeout(timer); }
}

export async function binanceBook(symbol, fetchFn = fetch) {
  const why = [];
  for (const src of SOURCES) {
    if (src.name === 'Binance perp' && perpRefused) { why.push(`${src.name}: refused earlier`); continue; }
    try {
      const r = await timedJson(src.url(symbol), fetchFn);
      if (r.json && Number(r.json.bidPrice) > 0) { lastBinanceError = null; return { source: src.name, bid: Number(r.json.bidPrice), ask: Number(r.json.askPrice), ms: r.ms }; }
      if (src.name === 'Binance perp' && (r.status === 451 || r.status === 403)) perpRefused = true;
      why.push(`${src.name}: HTTP ${r.status}`);
    } catch (e) { why.push(`${src.name}: ${e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 80)}`); }
  }
  lastBinanceError = why.join('; ');
  return null;
}
export const binanceError = () => lastBinanceError;
export const _resetBinance = () => { perpRefused = false; lastBinanceError = null; };

// One sample: Paradex book (the view the bot trades on) and, if asked, Binance's, with response times.
// Binance refuses Cloudflare's servers (HTTP 403), so the minute loop asks Paradex only and the
// Binance price comes from TradingView through /tick.
export async function takeSample(px, market, { symbol, binance = true, fetchFn = fetch, now = Date.now } = {}) {
  const t0 = now();
  const [pd, bn] = await Promise.all([
    px.bestPrices(market).then((b) => ({ bid: Number(b.bid), ask: Number(b.ask), ms: now() - t0 })).catch(() => null),
    binance ? binanceBook(symbol || binanceSymbol(market), fetchFn) : null,
  ]);
  return { t: t0, pd, bn };
}

// A TradingView bar-close alert: {{time}} is the bar's open, {{interval}} its length in minutes
// ("1"), {{timenow}} when TradingView fired (to the second). Returns the delays in ms.
export function tickDelays({ barOpen, interval, tvAt, edgeAt, engineAt }) {
  const mins = Number(interval);
  const closeAt = Number.isFinite(barOpen) && mins > 0 ? barOpen + mins * 60_000 : null;
  return {
    closeAt,
    binanceToTv: closeAt && Number.isFinite(tvAt) ? tvAt - closeAt : null,
    tvToCloudflare: Number.isFinite(tvAt) ? edgeAt - tvAt : null,
    cloudflareToEngine: engineAt - edgeAt,
  };
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// Summary of /tick samples: gap Paradex mid vs Binance close, and each delay (median and slowest 10%).
export function summariseTicks(ticks) {
  const ok = ticks.filter((k) => k.price > 0 && k.pd && mid(k.pd.bid, k.pd.ask));
  const gaps = ok.map((k) => bps(mid(k.pd.bid, k.pd.ask), k.price));
  const d = (key) => ticks.map((k) => k.delays?.[key]).filter((x) => Number.isFinite(x));
  const both = (key) => ({ med: median(d(key)), p90: pct(d(key), 0.9) });
  return {
    n: ticks.length, nGap: ok.length,
    gapMean: mean(gaps), gapMin: gaps.length ? Math.min(...gaps) : null, gapMax: gaps.length ? Math.max(...gaps) : null,
    pdSpread: mean(ok.map((k) => ((k.pd.ask - k.pd.bid) / mid(k.pd.bid, k.pd.ask)) * 10_000)),
    binanceToTv: both('binanceToTv'), tvToCloudflare: both('tvToCloudflare'), cloudflareToEngine: both('cloudflareToEngine'),
    pdMs: median(ok.map((k) => k.pd.ms).filter((x) => Number.isFinite(x))),
  };
}

export function describeTicks(label, m) {
  if (!m.n) return `${label}: no TradingView ticks yet (set up the 1-minute alert to /tick).`;
  const dl = (x) => `${secs(x.med)} typical, ${secs(x.p90)} slowest 10%`;
  return `${label} (${m.n} TradingView ticks):`
    + (m.nGap ? `\n- Gap: Paradex ${f1(m.gapMean)} bp vs Binance on average (from ${f1(m.gapMin)} to ${f1(m.gapMax)}). Paradex spread ${m.pdSpread.toFixed(2)} bp.` : '')
    + `\n- Binance bar close -> TradingView fires: ${dl(m.binanceToTv)} (TradingView time is to the second).`
    + `\n- TradingView -> Cloudflare: ${dl(m.tvToCloudflare)}.`
    + `\n- Cloudflare -> engine in Asia: ${dl(m.cloudflareToEngine)}.`
    + (m.pdMs != null ? `\n- Paradex answers the engine in ${secs(m.pdMs)} typical.` : '');
}

// Summary of samples: gap = Paradex mid vs Binance mid, in basis points (1 bp = 0.01%).
export function summarise(samples) {
  const ok = samples.filter((s) => s.pd && s.bn && mid(s.pd.bid, s.pd.ask) && mid(s.bn.bid, s.bn.ask));
  const gaps = ok.map((s) => bps(mid(s.pd.bid, s.pd.ask), mid(s.bn.bid, s.bn.ask)));
  const spread = (b) => ((b.ask - b.bid) / mid(b.bid, b.ask)) * 10_000;
  return {
    n: ok.length,
    gapMean: mean(gaps), gapMin: gaps.length ? Math.min(...gaps) : null, gapMax: gaps.length ? Math.max(...gaps) : null,
    pdSpread: mean(ok.map((s) => spread(s.pd))), bnSpread: mean(ok.map((s) => spread(s.bn))),
    pdMs: median(samples.filter((s) => s.pd).map((s) => s.pd.ms)), bnMs: median(samples.filter((s) => s.bn).map((s) => s.bn.ms)),
    source: ok.at(-1)?.bn.source || samples.find((s) => s.bn)?.bn.source || null,
  };
}

export function describeNow(s) {
  if (!s?.pd) return 'Now: Paradex price unavailable.';
  if (!s?.bn) return `Now: Binance price unavailable from where the engine runs (${lastBinanceError || 'no answer'}).`;
  const pm = mid(s.pd.bid, s.pd.ask), bm = mid(s.bn.bid, s.bn.ask);
  return `Now: Paradex ${s.pd.bid}/${s.pd.ask} (spread ${(s.pd.ask - s.pd.bid).toFixed(2)}), ${s.bn.source} ${s.bn.bid}/${s.bn.ask} (spread ${(s.bn.ask - s.bn.bid).toFixed(2)}).`
    + `\nGap: Paradex is ${f1(bps(pm, bm))} bp vs Binance (${(pm - bm).toFixed(1)} USD).`;
}

export function describeSummary(label, m) {
  if (!m.n) return `${label}: no complete samples yet (each needs both prices).`;
  return `${label} (${m.n} samples, ${m.source}): gap ${f1(m.gapMean)} bp on average (from ${f1(m.gapMin)} to ${f1(m.gapMax)}). `
    + `Spread: Paradex ${m.pdSpread.toFixed(2)} bp, Binance ${m.bnSpread.toFixed(2)} bp. Response: Paradex ${secs(m.pdMs)}, Binance ${secs(m.bnMs)}.`;
}

// Round trips to Paradex from where the engine runs, and Paradex's clock vs ours.
export async function pingParadex(base, { n = 5, fetchFn = fetch } = {}) {
  const rtt = [], offset = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const r = await fetchFn(`${base}/system/time`);
      const j = await r.json();
      const t1 = Date.now();
      rtt.push(t1 - t0);
      if (Number(j.server_time) > 0) offset.push(Number(j.server_time) - (t0 + t1) / 2);
    } catch { /* counted as missing */ }
  }
  return { n: rtt.length, rttMedian: median(rtt), rttMin: rtt.length ? Math.min(...rtt) : null, clockOffset: median(offset) };
}

// Wraps the Paradex client for one signal and notes the moments that matter. Read-only wrapper.
export function timedClient(px, marks) {
  return new Proxy(px, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      if (k === 'placeOrder') return async (o) => {
        const sent = Date.now();
        const r = await v.call(t, o);
        if (!marks.sent) Object.assign(marks, { sent, ack: Date.now(), stamped: Number(r?.created_at) || null });
        return r;
      };
      if (k === 'getOrder') return async (id) => {
        const r = await v.call(t, id);
        if (r?.status === 'CLOSED' && !marks.closed) marks.closed = Number(r.last_updated_at) || null;
        return r;
      };
      if (k === 'bestPrices') return async (s) => {
        const r = await v.call(t, s);
        if (!marks.book) marks.book = { at: Date.now(), bid: r.bid, ask: r.ask };
        return r;
      };
      return v.bind(t);
    },
  });
}

// "Timing: TV 09:57:45 -> Cloudflare +1.4 s -> engine +25 ms -> order sent +210 ms -> Paradex +60 ms -> filled +305 ms"
// TradingView gives its time to the second, so the first step is +/- 1 s. Paradex times are its own clock.
export function timingLine(sig, marks) {
  const parts = [];
  const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);
  let prev = sig.tvAt;
  const step = (label, at) => { if (!at) return; parts.push(`${label} +${secs(prev ? at - prev : null)}`); prev = at; };
  if (sig.tvAt) parts.push(`TV ${hhmmss(sig.tvAt)}`);
  step(`Cloudflare${sig.edgeColo ? ` (${sig.edgeColo})` : ''}`, sig.edgeAt);
  step('engine', marks.start);
  step('order sent', marks.sent);
  step('Paradex stamped', marks.stamped);
  step('filled', marks.closed);
  const total = (marks.closed || marks.ack) && sig.tvAt ? ` Total ${secs((marks.closed || marks.ack) - sig.tvAt)}.` : '';
  return `Timing: ${parts.join(' -> ')}.${total}`;
}

// Paradex mid, last trade and spread against Paradex's mark price, in bp (1 bp = 0.01%).
// A mid far from the mark means a thin or broken book: the liquidity risk we watch.
export function markGaps(s) {
  const m = Number(s?.mark), pm = s?.pd ? mid(s.pd.bid, s.pd.ask) : null;
  if (!(m > 0) || !pm) return { mid: null, last: null, spread: null, index: null };
  return {
    mid: bps(pm, m),
    last: Number(s.last) > 0 ? bps(Number(s.last), m) : null,
    spread: ((s.pd.ask - s.pd.bid) / pm) * 10_000,
    index: Number(s.index) > 0 ? bps(m, Number(s.index)) : null,
  };
}

export function describeMark(label, samples, limit) {
  const g = samples.map(markGaps).filter((x) => x.mid != null);
  if (!g.length) return `${label}: no mark price samples yet.`;
  const absMid = g.map((x) => Math.abs(x.mid)), absLast = g.map((x) => x.last).filter((x) => x != null).map(Math.abs);
  const sp = g.map((x) => x.spread), over = absMid.filter((x) => x > limit).length;
  return `${label} (${g.length} minutes): Paradex mid vs mark ${median(absMid).toFixed(1)} bp typical, ${Math.max(...absMid).toFixed(1)} bp worst`
    + (absLast.length ? `; last trade vs mark ${median(absLast).toFixed(1)} bp typical, ${Math.max(...absLast).toFixed(1)} bp worst` : '')
    + `; spread ${median(sp).toFixed(1)} bp typical, ${pct(sp, 0.95).toFixed(1)} bp at the widest 5%. `
    + (over ? `${over} minute(s) beyond the ${limit} bp guard.` : `Never beyond the ${limit} bp guard.`);
}

// Binance price that TradingView sent vs the Paradex book when the engine looked, and the fill.
// With the execution report: the Paradex mid and mark are the reference, TradingView is for information.
export function priceLine(sig, marks, fills, report) {
  if (report && report.ref) {
    const ref = Number(report.ref), parts = [];
    parts.push(`Paradex ${report.bidAtStart}/${report.askAtStart}, mid ${ref.toFixed(1)}`
      + (report.markAtStart ? ` (mark ${Number(report.markAtStart).toFixed(1)}, ${f1(report.markGapBps)} bp)` : ''));
    const px = fills.map((f) => Number(f.price)).filter((x) => x > 0);
    if (px.length) parts.push(`filled ${px.join(', ')} (${px.map((x) => f1(bps(x, ref))).join(', ')} bp vs mid)`);
    if (Number(sig.price) > 0) parts.push(`TradingView (Binance USDT) ${Number(sig.price)}, ${f1(bps(ref, Number(sig.price)))} bp`);
    return `Prices: ${parts.join(' | ')}.`;
  }
  const tv = Number(sig.price) > 0 ? Number(sig.price) : null;
  const pm = marks.book ? mid(marks.book.bid, marks.book.ask) : null;
  const parts = [];
  if (tv) parts.push(`TradingView ${tv}`);
  if (pm) parts.push(`Paradex ${marks.book.bid}/${marks.book.ask}${tv ? ` (mid ${f1(bps(pm, tv))} bp vs TradingView)` : ''}`);
  const px = fills.map((f) => Number(f.price)).filter((x) => x > 0);
  if (px.length) parts.push(`filled ${px.join(', ')}${tv ? ` (${px.map((x) => f1(bps(x, tv))).join(', ')} bp vs TradingView)` : ''}`);
  return parts.length ? `Prices: ${parts.join(' | ')}.` : '';
}
