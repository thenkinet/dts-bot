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
export const ORDER_PREFIX = 'od:';    // every real order: its timings (queue, checks, sent, acknowledged)
export const TG_PREFIX = 'tg:';       // every Telegram command: how long it took to arrive, and to answer
export const KEEP_MS = 7 * 24 * 3_600_000;   // 7 days of minute samples (about 10,000, a few MB)

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
// endToEnd (bar close -> Cloudflare) needs no clock but Cloudflare's: the bar's close is exact by definition.
// The split into trigger and delivery needs the tool's own firing time (ms), when it sends one.
export function tickDelays({ barOpen, interval, tvAt, edgeAt, engineAt }) {
  const mins = Number(interval);
  const closeAt = Number.isFinite(barOpen) && mins > 0 ? barOpen + mins * 60_000 : null;
  return {
    closeAt,
    endToEnd: closeAt ? edgeAt - closeAt : null,
    binanceToTv: closeAt && Number.isFinite(tvAt) ? tvAt - closeAt : null,
    tvToCloudflare: Number.isFinite(tvAt) ? edgeAt - tvAt : null,
    cloudflareToEngine: engineAt - edgeAt,
  };
}

// ---- /latency: one scoreboard per charting tool ----
// Ticks recorded before source tags existed came from TradingView.
export const tickSource = (k) => k.src || 'tradingview';
const e2e = (k) => k.delays?.endToEnd ?? (Number.isFinite(k.delays?.binanceToTv) && Number.isFinite(k.delays?.tvToCloudflare)
  ? k.delays.binanceToTv + k.delays.tvToCloudflare : null);

// Short names keep the table within a phone's width (about 30 characters of fixed-width text).
const TOOL = { tradingview: 'TV', takeprofit: 'TP', mmt: 'MMT' };
export const toolName = (src) => TOOL[src] || src.slice(0, 8);

// Webhooks that never arrived: one tick is due per 1-minute bar close, from the tool's first tick in
// the range until 20 s ago (the latest bar may still be on its way). A rejected webhook counts as missed.
// OFF_MIN or more missing minutes in a row mean the alert was off (paused, edited, expired): those are
// reported apart and left out of the uptime. Shorter gaps are lost webhooks.
export const OFF_MIN = 5;
export function delivery(ks, at = Date.now()) {
  const closes = new Set(ks.map((k) => k.delays?.closeAt).filter((x) => Number.isFinite(x)));
  if (!closes.size) return null;
  const first = Math.min(...closes), last = Math.floor((at - 20_000) / 60_000) * 60_000;
  const runs = [];
  for (let c = first; c <= last; c += 60_000) {
    if (closes.has(c)) continue;
    const r = runs.at(-1);
    if (r && c === r.to + 60_000) r.to = c; else runs.push({ from: c, to: c });
  }
  for (const r of runs) r.n = Math.round((r.to - r.from) / 60_000) + 1;
  const off = runs.filter((r) => r.n >= OFF_MIN);
  const missed = runs.filter((r) => r.n < OFF_MIN).flatMap((r) => Array.from({ length: r.n }, (_, i) => r.from + i * 60_000));
  const all = last >= first ? Math.round((last - first) / 60_000) + 1 : 0;
  const offN = off.reduce((a, r) => a + r.n, 0);
  return { due: all - offN, got: all - offN - missed.length, missed, off, offNow: Boolean(off.length && off.at(-1).to === last) };
}

export function latencyReport({ ticks, samples, orders = [], label, at = Date.now() }) {
  const P = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : null);
  const ms = (x) => (x == null || !Number.isFinite(x) ? '-' : String(Math.round(x)));
  const line = (name, vals) => `${name.padEnd(9).slice(0, 9)}${ms(P(vals, 0.5)).padStart(6)}${ms(P(vals, 0.99)).padStart(6)}${ms(vals.length ? Math.max(...vals) : null).padStart(6)}`;
  const head = (title) => `${title.padEnd(9)}${'p50'.padStart(6)}${'p99'.padStart(6)}${'max'.padStart(6)}`;
  const out = [`⏱ Latency ${label} · ${new Date(at).toISOString().slice(11, 16)} UTC`, ''];
  const bySrc = {};
  for (const k of ticks) (bySrc[tickSource(k)] ||= []).push(k);
  const names = Object.keys(bySrc).sort();
  if (!names.length) return out.concat(['No charting-tool ticks yet.', 'Set a 1-min alert to /tick.']).join('\n');
  // Total per minute, the whole plumbing: bar close -> Cloudflare door -> Seoul -> the bot's checks
  // before an order (the dry run: the real order path, stopped before the order) -> Paradex answers a
  // signed request (stand-in for the order's acknowledgement). Ticks from before the dry run existed
  // use the plain Paradex round trip instead. Percentiles are taken on the per-minute totals:
  // p99s and maxes of the legs do not add up, p50s roughly do.
  const hasDry = (k) => Number.isFinite(k.dry?.checks) && Number.isFinite(k.dry?.ack);
  const total = (k) => {
    const a = e2e(k), b = k.delays?.cloudflareToEngine, c = hasDry(k) ? k.dry.checks + k.dry.ack : k.pd?.ms;
    return Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) ? a + b + c : null;
  };
  out.push('Close → order ack (ms)', head(''));
  const counts = [];
  for (const n of names) {
    out.push(line(toolName(n), bySrc[n].map(total).filter((x) => Number.isFinite(x))));
    counts.push(`${toolName(n)} ${bySrc[n].filter((k) => Number.isFinite(e2e(k))).length}`);
  }
  out.push(`(minutes: ${counts.join(' · ')})`);
  // How the typical total adds up, leg by leg (p50 of each leg).
  const med = (vals) => P(vals.filter((x) => Number.isFinite(x)), 0.5);
  const add = (label, v) => `${label.padEnd(17)}${ms(v).padStart(6)}`;
  for (const n of names) {
    const ks = bySrc[n], split = ks.some((k) => Number.isFinite(k.delays?.tvToCloudflare));
    const legs = split
      ? [[' trigger', med(ks.map((k) => k.delays?.binanceToTv))], ['+ delivery', med(ks.map((k) => k.delays?.tvToCloudflare))]]
      : [[' close → door', med(ks.map(e2e))]];
    legs.push(['+ door → Seoul', med(ks.map((k) => k.delays?.cloudflareToEngine))]);
    const dk = ks.filter(hasDry);
    if (dk.length) legs.push(['+ checks', med(dk.map((k) => k.dry.checks))], ['+ order ack', med(dk.map((k) => k.dry.ack))]);
    else legs.push(['+ Seoul ↔ Paradex', med(ks.map((k) => k.pd?.ms))]);
    if (legs.some(([, v]) => v == null)) continue;
    out.push('', `${toolName(n)} adds up (p50 ms)`, ...legs.map(([l, v]) => add(l, v)), add('= about', legs.reduce((x, [, v]) => x + v, 0)));
    const via = dk.at(-1)?.dry.via;
    if (dk.length) out.push(`(via ${String(via || '?').toUpperCase()}${dk.length < ks.length ? ` · ${dk.length}/${ks.length} min` : ''})`);
  }
  const dv = names.map((n) => [n, delivery(bySrc[n], at)]).filter(([, d]) => d && (d.due || d.off.length));
  if (dv.length) {
    const hm = (ms) => new Date(ms).toISOString().slice(11, 16);
    out.push('', `${'Webhooks'.padEnd(9)}${'arrived'.padStart(11)}${'up'.padStart(7)}`);
    for (const [n, d] of dv) {
      const up = d.due ? `${(Math.floor((d.got / d.due) * 1000) / 10).toFixed(1)}%` : '-';
      out.push(`${toolName(n).padEnd(9)}${`${d.got}/${d.due}`.padStart(11)}${up.padStart(7)}`);
    }
    for (const [n, d] of dv) {
      const t = toolName(n);
      if (d.missed.length) out.push(`${t} lost ${d.missed.length} · last ${hm(d.missed.at(-1))}`);
      if (d.offNow) out.push(`${t} off since ${hm(d.off.at(-1).from)} ⚠️`);
      else if (d.off.length === 1) out.push(`${t} off ${d.off[0].n}m · ${hm(d.off[0].from)}-${hm(d.off[0].to)}`);
      else if (d.off.length) out.push(`${t} off ${d.off.reduce((a, r) => a + r.n, 0)}m · ${d.off.length} gaps`);
    }
  }
  for (const n of names) {
    const ks = bySrc[n].filter((k) => Number.isFinite(k.delays?.tvToCloudflare));
    out.push('', head(`${toolName(n)} detail`));
    if (ks.length) {
      out.push(line('trigger', ks.map((k) => k.delays.binanceToTv).filter((x) => Number.isFinite(x))));
      out.push(line('delivery', ks.map((k) => k.delays.tvToCloudflare)));
    } else out.push(line('to door', bySrc[n].map(e2e).filter((x) => Number.isFinite(x))));
  }
  const hop = ticks.map((k) => k.delays?.cloudflareToEngine).filter((x) => Number.isFinite(x));
  const pdx = samples.map((s) => s.pd?.ms).filter((x) => Number.isFinite(x));
  const dry = ticks.filter(hasDry);
  out.push('', head('Bot'));
  if (hop.length) out.push(line('→ Seoul', hop));
  if (dry.length) out.push(line('checks', dry.map((k) => k.dry.checks)), line('order ack', dry.map((k) => k.dry.ack)));
  if (pdx.length) out.push(line('↔ Paradex', pdx));
  const stopped = ticks.filter((k) => k.dry?.stopped).length;
  if (stopped) out.push(`(dry run stopped early: ${stopped})`);
  // The checks, step by step, in the order the bot runs them. A step that runs twice (the book) is
  // numbered; "other" is the time between steps (the bot's own work, storage).
  const stepped = dry.filter((k) => Array.isArray(k.dry.steps) && k.dry.steps.length);
  if (stepped.length) {
    const order = [], byLabel = {};
    for (const k of stepped) {
      const seen = {};
      let sum = 0;
      for (const [l, v] of k.dry.steps) {
        seen[l] = (seen[l] || 0) + 1;
        const key = seen[l] > 1 ? `${l} ${seen[l]}` : l;
        if (!byLabel[key]) { byLabel[key] = []; order.push(key); }
        byLabel[key].push(v); sum += v;
      }
      (byLabel.other ||= []).push(Math.max(0, k.dry.checks - sum));
    }
    out.push('', `Checks by step (${stepped.length})`, head(''));
    for (const key of [...order, 'other']) out.push(line(key, byLabel[key]));
  }
  // Real orders: the same legs, measured on the real thing.
  const od = orders.filter((o) => Number.isFinite(o.start));
  if (od.length) {
    const v = (f) => od.map(f).filter((x) => Number.isFinite(x) && x >= 0);
    out.push('', `Real orders: ${od.length}`, head(''));
    out.push(line('→ Seoul', v((o) => o.receivedAt - o.edgeAt)), line('queue', v((o) => o.start - o.receivedAt)));
    out.push(line('checks', v((o) => o.sent - o.start)), line('order ack', v((o) => o.ack - o.sent)));
  }
  const deliv = ticks.map((k) => k.delays?.tvToCloudflare).filter((x) => Number.isFinite(x));
  if (deliv.length) {
    const lo = Math.min(...deliv);
    out.push('', lo < 0 ? `Clock ⚠️ tool ${Math.round(-lo)} ms ahead` : `Clock ✓ fastest ${Math.round(lo)} ms`);   // <= 27 wide
  }
  return out.join('\n');
}

// ---- /latency (short): the whole chain by module, processing vs delivery ----
// Processing = time a module spends working; delivery = time on the wire to the next module.
//   Binance + charting tool: processing = bar close -> the tool fires (Binance's feed and the tool's
//     script cannot be told apart from outside); delivery = the tool's webhook -> Cloudflare's door.
//     A tool that sends no firing time gets one combined figure, shown as delivery.
//   Cloudflare: delivery = door -> engine in Seoul; processing = the pause-flag check (a Cloudflare
//     object) plus the bot's own work between Paradex requests.
//   Paradex: every request is a round trip. The fastest round trip of the range counts as delivery
//     (pure network); anything above it is Paradex processing. Requests: the checks' reads + the ack.
// Each cell is the p50 over minutes; the headline is the p50 of per-minute totals (they differ a little).
const p50 = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[Math.max(0, Math.ceil(0.5 * v.length) - 1)] : null; };
const p99 = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[Math.max(0, Math.ceil(0.99 * v.length) - 1)] : null; };
const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)} s`);

export function moduleSplit(k, floor) {
  const steps = k.dry?.steps;
  if (!Array.isArray(steps) || !Number.isFinite(k.dry?.checks) || !Number.isFinite(k.dry?.ack)) return null;
  const pdx = steps.filter(([l]) => l !== 'pause').map(([, v]) => v).concat([k.dry.ack]);
  const pause = steps.filter(([l]) => l === 'pause').reduce((a, [, v]) => a + v, 0);
  const other = Math.max(0, k.dry.checks - steps.reduce((a, [, v]) => a + v, 0));
  const pSum = pdx.reduce((a, b) => a + b, 0), pDel = Math.min(pSum, floor * pdx.length);
  return { cfProc: pause + other, cfDel: k.delays?.cloudflareToEngine, pxProc: pSum - pDel, pxDel: pDel };
}

export function moduleReport({ ticks, tg = [], label, at = Date.now() }) {
  const out = [`⏱ Latency ${label} · ${new Date(at).toISOString().slice(11, 16)} UTC`, ''];
  const bySrc = {};
  for (const k of ticks) (bySrc[tickSource(k)] ||= []).push(k);
  const names = Object.keys(bySrc).sort();
  if (!names.length) return out.concat(['No charting-tool ticks yet.', 'Set a 1-min alert to /tick.']).join('\n');
  const full = ticks.filter((k) => Array.isArray(k.dry?.steps));
  const rtts = full.flatMap((k) => k.dry.steps.filter(([l]) => l !== 'pause').map(([, v]) => v).concat([k.dry.ack])).filter((x) => x > 0);
  const floor = rtts.length ? Math.min(...rtts) : 0;
  const split = (k) => moduleSplit(k, floor);
  // Headline per tool: bar close -> Paradex acknowledges, measured whole each minute.
  out.push('Bar close → order ack');
  for (const n of names) {
    const ks = bySrc[n].filter((k) => split(k) && Number.isFinite(e2e(k)));
    const tot = ks.map((k) => { const m = split(k); return e2e(k) + m.cfDel + m.cfProc + m.pxProc + m.pxDel; });
    out.push(ks.length ? `${toolName(n).padEnd(4)}${sec(p50(tot)).padStart(7)} · p99 ${sec(p99(tot))}` : `${toolName(n).padEnd(4)} measuring…`);
  }
  const ms = (x) => (x == null || !Number.isFinite(x) ? '-' : String(Math.round(x)));
  const row = (l, a, b) => `${l.padEnd(11)}${ms(a).padStart(7)}${ms(b).padStart(7)}`;
  out.push('', `${'Module (ms)'.padEnd(11)}${'proc'.padStart(7)}${'deliv'.padStart(7)}`);
  // The total row is for the first tool with a complete minute (its tool row + Cloudflare + Paradex).
  const main = names.find((n) => bySrc[n].some((k) => split(k) && Number.isFinite(e2e(k)))) || names[0];
  let tp = 0, td = 0;
  for (const n of names) {
    const ks = bySrc[n];
    const hasTs = ks.some((k) => Number.isFinite(k.delays?.tvToCloudflare));
    const a = hasTs ? p50(ks.map((k) => k.delays?.binanceToTv)) : null;
    const b = hasTs ? p50(ks.map((k) => k.delays?.tvToCloudflare)) : p50(ks.map(e2e));
    out.push(row(`Binance+${toolName(n)}`.slice(0, 11), a, b));
    if (n === main) { tp += a || 0; td += b || 0; }
  }
  const ms2 = full.map(split).filter(Boolean);
  if (ms2.length) {
    const cfP = p50(ms2.map((m) => m.cfProc)), cfD = p50(ms2.map((m) => m.cfDel));
    const pxP = p50(ms2.map((m) => m.pxProc)), pxD = p50(ms2.map((m) => m.pxDel));
    out.push(row('Cloudflare', cfP, cfD), row('Paradex', pxP, pxD));
    tp += cfP + pxP; td += cfD + pxD;
    out.push(row(`= ${toolName(main)} total`, tp, td));
  } else out.push('Cloudflare, Paradex: measuring…');
  // Side paths: Telegram, not part of the order path.
  const inMs = tg.map((x) => x.inMs), sendMs = tg.map((x) => x.sendMs);
  if (tg.length) {
    out.push('', 'Side path: Telegram (ms)');
    if (p50(inMs) != null) out.push(`${'command in'.padEnd(16)}${`~${ms(p50(inMs))}`.padStart(7)}`);   // ~: Telegram stamps to the second
    if (p50(sendMs) != null) out.push(`${'bot answers'.padEnd(16)}${ms(p50(sendMs)).padStart(7)}`);
  }
  const up = names.map((n) => { const d = delivery(bySrc[n], at); return d && d.due ? `${toolName(n)} ${(Math.floor((d.got / d.due) * 1000) / 10).toFixed(1)}%` : null; }).filter(Boolean);
  if (up.length) out.push('', `Up: ${up.join(' · ')}`);
  out.push(`(p50 · ${full.length} min)`, 'More: /latency full');
  return out.join('\n');
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
    + `\n- Binance bar close -> TradingView fires: ${dl(m.binanceToTv)}.`
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

// ---- the short /spread report ----
// Signed values keep their direction: + means above the mark price, - below.
// p50: half the minutes were closer than this. p99: only 1% further. max: the single worst minute.
// For the signed gap, p50 is the plain median; p99 and max are taken by size, with the sign of that minute.
// Nearest-rank percentile: the value that p of the minutes are at or below (p99 of 100 minutes = the 99th).
const rank = (n, p) => Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
const bySize = (vals, p) => (vals.length ? [...vals].sort((a, b) => Math.abs(a) - Math.abs(b))[rank(vals.length, p)] : null);
const pctR = (vals, p) => (vals.length ? [...vals].sort((a, b) => a - b)[rank(vals.length, p)] : null);
const sb = (x) => (x == null || !Number.isFinite(x) ? '-' : (x > 0 ? '+' : x < 0 ? '' : '') + x.toFixed(1));  // signed bp
const ub = (x) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(1));                                     // unsigned bp
const num = (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const row = (label, a, b, c) => `${label.padEnd(9)}${String(a).padStart(6)}${String(b).padStart(6)}${String(c).padStart(6)}`;   // 27 wide, like /latency: fits a phone

export function verdict(gapBps, guard) {
  if (gapBps == null || !Number.isFinite(gapBps)) return { icon: '⛔', text: 'No mark price: blocked' };
  if (Math.abs(gapBps) > guard) return { icon: '⛔', text: 'Blocked: book off mark' };
  if (Math.abs(gapBps) > guard / 2) return { icon: '⚠️', text: 'Thin: book drifting' };
  return { icon: '✅', text: 'OK to trade' };
}

// samples: the engine's minute samples ({ t, pd: {bid, ask, ms}, mark }). now: the same shape, taken now.
export function shortReport({ now, samples, guard, label, status, at = Date.now() }) {
  const gNow = markGaps(now);
  const v = verdict(gNow.mid, guard);
  const pm = now?.pd ? mid(now.pd.bid, now.pd.ask) : null;
  const g = samples.map((s) => ({ ...markGaps(s), ms: s.pd?.ms })).filter((x) => x.mid != null);
  const gaps = g.map((x) => x.mid), spreads = g.map((x) => x.spread), ms = g.map((x) => x.ms).filter((x) => Number.isFinite(x));
  const over = gaps.filter((x) => Math.abs(x) > guard).length;
  const lines = [`${v.icon} ${v.text} · ${new Date(at).toISOString().slice(11, 16)} UTC`];
  if (pm) lines.push(`Now ${num(pm)} · ${sb(gNow.mid)} bp`, `Spread now ${ub(gNow.spread)} bp`);
  else lines.push('Now: no Paradex price');
  lines.push('');
  if (g.length) {
    lines.push(row(`${label} bp`, 'p50', 'p99', 'max'));
    lines.push(row('vs mark', sb(pctR(gaps, 0.5)), sb(bySize(gaps, 0.99)), sb(bySize(gaps, 1))));
    lines.push(row('spread', ub(pctR(spreads, 0.5)), ub(pctR(spreads, 0.99)), ub(Math.max(...spreads))));
    if (ms.length) lines.push(row('speed ms', Math.round(pctR(ms, 0.5)), Math.round(pctR(ms, 0.99)), Math.round(Math.max(...ms))));
    lines.push('');
    lines.push(`Guard ${guard} bp hit ${over}/${g.length} min`);
  } else {
    lines.push(`${label}: no samples yet`);
  }
  if (status) lines.push(status);
  return lines.join('\n');
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
