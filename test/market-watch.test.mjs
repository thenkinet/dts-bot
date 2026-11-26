// Market watch: summaries, Binance fallback, timing and price lines, and the read-only wrapper.
import assert from 'node:assert/strict';
import { summarise, binanceBook, _resetBinance, timedClient, timingLine, priceLine, describeNow, pingParadex, binanceSymbol, tickDelays, summariseTicks, describeTicks, markGaps, describeMark, shortReport, verdict, latencyReport, tickSource, delivery } from '../src/market-watch.js';

let fails = 0;
const t = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { fails++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

await t('Binance symbol from the Paradex market, unless overridden', () => {
  assert.equal(binanceSymbol('BTC-USD-PERP'), 'BTCUSDT');
  assert.equal(binanceSymbol('ETH-USD-PERP', 'ETHUSDC'), 'ETHUSDC');
});

await t('Binance perp first; on HTTP 451 falls back to spot and stops asking perp', async () => {
  _resetBinance();
  const seen = [];
  const f = async (url) => { seen.push(url); return url.includes('fapi') ? json({ code: 0 }, 451) : json({ bidPrice: '100.00', askPrice: '100.02' }); };
  const a = await binanceBook('BTCUSDT', f);
  assert.equal(a.source, 'Binance spot'); assert.equal(a.bid, 100);
  seen.length = 0;
  await binanceBook('BTCUSDT', f);
  assert.ok(seen.every((u) => !u.includes('fapi')));
});

await t('All Binance sources failing: /spread says why', async () => {
  _resetBinance();
  const a = await binanceBook('BTCUSDT', async (url) => json({}, url.includes('fapi') ? 451 : 403));
  assert.equal(a, null);
  assert.match(describeNow({ pd: { bid: 1, ask: 2 }, bn: null }), /Binance perp: HTTP 451; Binance spot: HTTP 403; Binance spot \(api\): HTTP 403/);
});

await t('Binance perp used when it answers', async () => {
  _resetBinance();
  const a = await binanceBook('BTCUSDT', async () => json({ bidPrice: '59925.6', askPrice: '59925.7' }));
  assert.equal(a.source, 'Binance perp');
});

await t('Summary: gap in bp, spreads, skips incomplete samples', () => {
  const s = [
    { t: 1, pd: { bid: 99.9, ask: 100.1, ms: 50 }, bn: { bid: 100.09, ask: 100.11, source: 'Binance perp', ms: 20 } },
    { t: 2, pd: { bid: 99.9, ask: 100.1, ms: 70 }, bn: { bid: 99.89, ask: 99.91, source: 'Binance perp', ms: 30 } },
    { t: 3, pd: null, bn: { bid: 1, ask: 2, ms: 10 } },
  ];
  const m = summarise(s);
  assert.equal(m.n, 2);
  assert.ok(Math.abs(m.gapMean) < 0.05);                  // -10 bp and +10 bp average to 0
  assert.ok(Math.abs(m.gapMin + 9.99) < 0.05 && Math.abs(m.gapMax - 10.01) < 0.05);
  assert.ok(Math.abs(m.pdSpread - 20) < 0.01);
  assert.equal(m.pdMs, 60);
});

await t('Wrapper notes send, Paradex stamp, fill time and first book; passes everything through', async () => {
  const px = {
    secret: 'x',
    async bestPrices() { return { bid: '59880', ask: '59890' }; },
    async placeOrder(o) { return { id: 'o1', created_at: 1000, echo: o.size }; },
    async getOrder() { return { status: 'CLOSED', last_updated_at: 1300 }; },
    async positions() { return []; },
  };
  const marks = {};
  const w = timedClient(px, marks);
  await w.bestPrices('BTC'); await w.bestPrices('BTC');
  const r = await w.placeOrder({ size: '0.1' });
  await w.getOrder('o1');
  assert.equal(r.echo, '0.1'); assert.equal(w.secret, 'x');
  assert.deepEqual(await w.positions(), []);
  assert.equal(marks.stamped, 1000); assert.equal(marks.closed, 1300); assert.equal(marks.book.bid, '59880');
  assert.ok(marks.sent > 0 && marks.ack >= marks.sent);
});

await t('Timing line walks TV -> Cloudflare -> engine -> order -> Paradex -> filled', () => {
  const tv = Date.parse('2026-11-24T09:57:45Z');
  const line = timingLine({ tvAt: tv, edgeAt: tv + 1400, edgeColo: 'MXP' }, { start: tv + 1425, sent: tv + 1635, stamped: tv + 1695, closed: tv + 2000, ack: tv + 1700 });
  assert.equal(line, 'Timing: TV 09:57:45 -> Cloudflare (MXP) +1.4 s -> engine +25 ms -> order sent +210 ms -> Paradex stamped +60 ms -> filled +305 ms. Total 2.0 s.');
});

await t('Price line compares the Paradex book and fill with the TradingView price', () => {
  const line = priceLine({ price: 60000 }, { book: { bid: '59940', ask: '59950' } }, [{ price: '59950' }]);
  assert.equal(line, 'Prices: TradingView 60000 | Paradex 59940/59950 (mid -9.2 bp vs TradingView) | filled 59950 (-8.3 bp vs TradingView).');
  assert.equal(priceLine({}, {}, []), '');
});

await t('Now line and Paradex ping', async () => {
  assert.match(describeNow({ pd: { bid: 59882.2, ask: 59892 }, bn: { bid: 59925.6, ask: 59925.7, source: 'Binance perp' } }), /Paradex is -6\.4 bp/);
  let n = 0;
  const p = await pingParadex('https://x', { n: 3, fetchFn: async () => { n++; return json({ server_time: String(Date.now()) }); } });
  assert.equal(p.n, 3); assert.equal(n, 3); assert.ok(Math.abs(p.clockOffset) < 50);
});

await t('Tick delays: bar close -> TradingView -> Cloudflare -> engine', () => {
  const barOpen = Date.parse('2026-11-24T12:00:00Z');
  const d = tickDelays({ barOpen, interval: '1', tvAt: barOpen + 61_000, edgeAt: barOpen + 61_700, engineAt: barOpen + 61_850 });
  assert.equal(d.closeAt, barOpen + 60_000);
  assert.equal(d.binanceToTv, 1000); assert.equal(d.tvToCloudflare, 700); assert.equal(d.cloudflareToEngine, 150);
  assert.equal(tickDelays({ barOpen: NaN, interval: '1', tvAt: 5, edgeAt: 10, engineAt: 12 }).binanceToTv, null);
});

await t('Tick summary: gap vs Binance close, typical and slowest delays', () => {
  const ticks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ t: i, price: 100, pd: { bid: 99.9, ask: 99.92, ms: 40 },
    delays: { binanceToTv: i * 100, tvToCloudflare: 500, cloudflareToEngine: 150 } }));
  const m = summariseTicks(ticks);
  assert.equal(m.n, 10); assert.ok(Math.abs(m.gapMean + 9) < 0.01);
  assert.equal(m.binanceToTv.med, 550); assert.equal(m.binanceToTv.p90, 1000);
  const txt = describeTicks('Last hour', m);
  assert.match(txt, /Gap: Paradex -9\.0 bp vs Binance/);
  assert.match(txt, /Binance bar close -> TradingView fires: 550 ms typical, 1\.0 s slowest 10%/);
  assert.match(describeTicks('Last hour', summariseTicks([])), /no TradingView ticks yet/);
});

await t('Mark gaps and the liquidity summary', () => {
  const g = markGaps({ pd: { bid: 99.9, ask: 100.1 }, mark: 100.05, last: 100.15, index: 100 });
  assert.ok(Math.abs(g.mid + 5) < 0.01 && Math.abs(g.last - 10) < 0.01 && Math.abs(g.spread - 20) < 0.01 && Math.abs(g.index - 5) < 0.01);
  assert.equal(markGaps({ pd: { bid: 1, ask: 2 } }).mid, null);
  const txt = describeMark('Liquidity, last hour', [{ pd: { bid: 99.9, ask: 100.1 }, mark: 100 }, { pd: { bid: 100.5, ask: 100.7 }, mark: 100 }], 50);
  assert.match(txt, /2 minutes/); assert.match(txt, /60\.0 bp worst/); assert.match(txt, /1 minute\(s\) beyond the 50 bp guard/);
  assert.match(describeMark('x', [], 50), /no mark price samples/);
});

await t('Price line with the execution report: Paradex mid and mark lead, TradingView for information', () => {
  const line = priceLine({ price: 60050 }, {}, [{ price: '59950' }], { ref: '59945', bidAtStart: '59940', askAtStart: '59950', markAtStart: '59942', markGapBps: 0.5 });
  assert.equal(line, 'Prices: Paradex 59940/59950, mid 59945.0 (mark 59942.0, +0.5 bp) | filled 59950 (+0.8 bp vs mid) | TradingView (Binance USDT) 60050, -17.5 bp.');
});

await t('Short report: verdict, signed bp vs mark, p50 / p99 / max, guard, status', () => {
  // 100 minutes: mid vs mark from -1 to +3 bp, one bad minute at -40 bp below the mark.
  const samples = Array.from({ length: 100 }, (_, i) => {
    const gap = i === 50 ? -40 : (i % 5) - 1;                 // bp
    const mark = 60000, m = mark * (1 + gap / 10_000);
    return { t: i, mark, pd: { bid: m - 5, ask: m + 5, ms: 40 + (i % 10) } };
  });
  const now = { mark: 60000, pd: { bid: 60013, ask: 60023, ms: 41 } };   // mid 60018 = +3.0 bp
  const txt = shortReport({ now, samples, guard: 50, label: '24h', status: 'Flat · bot paused', at: Date.parse('2026-11-25T11:42:00Z') });
  const lines = txt.split('\n');
  assert.equal(lines[0], '✅ OK to trade · 11:42 UTC');
  assert.equal(lines[1], 'Now 60,018.0 · +3.0 bp');
  assert.equal(lines[2], 'Spread now 1.7 bp');
  assert.match(txt, /vs mark\s+\+1\.0\s+\+3\.0\s+-40\.0/);    // the worst minute keeps its minus sign
  assert.match(txt, /spread\s+1\.7\s+1\.7\s+1\.7/);
  assert.match(txt, /speed ms\s+44\s+49\s+49/);
  assert.match(txt, /Guard 50 bp: never \(100 min\)/);
  assert.equal(lines.at(-1), 'Flat · bot paused');
  assert.ok(lines.every((l) => [...l].length <= 32), 'fits a phone');
});

await t('Verdict: OK, thin past half the guard, blocked past the guard or without a mark', () => {
  assert.equal(verdict(3, 50).icon, '✅');
  assert.equal(verdict(-30, 50).icon, '⚠️');
  assert.equal(verdict(51, 50).icon, '⛔');
  assert.equal(verdict(null, 50).icon, '⛔');
  assert.match(shortReport({ now: { pd: { bid: 1, ask: 2 } }, samples: [], guard: 50, label: '24h' }), /No mark price: blocked[\s\S]*24h: no samples yet/);
});

await t('Latency: end-to-end per tool without its clock; split only when the tool sends a firing time', () => {
  const barOpen = Date.parse('2026-11-26T10:00:00Z'), close = barOpen + 60_000;
  const d = tickDelays({ barOpen, interval: '1', tvAt: NaN, edgeAt: close + 900, engineAt: close + 970 });
  assert.equal(d.endToEnd, 900); assert.equal(d.binanceToTv, null); assert.equal(d.tvToCloudflare, null);
  const tv = Array.from({ length: 100 }, (_, i) => ({ t: i, delays: { binanceToTv: 300 + i, tvToCloudflare: 1700 + i, cloudflareToEngine: 70 } }));  // old ticks: no src, no endToEnd
  const tp = Array.from({ length: 100 }, (_, i) => ({ t: i, src: 'takeprofit', delays: { endToEnd: 900 + i, cloudflareToEngine: 72 } }));
  assert.equal(tickSource(tv[0]), 'tradingview');
  const txt = latencyReport({ ticks: [...tv, ...tp], samples: [{ pd: { ms: 41 } }, { pd: { ms: 43 } }], label: '24h', at: Date.parse('2026-11-26T12:40:00Z') });
  assert.match(txt, /^⏱ Latency 24h · 12:40 UTC/);
  assert.match(txt, /\nTP\s+949\s+998\s+999/);
  assert.match(txt, /\nTV\s+2098\s+2196\s+2198/);           // derived from trigger + delivery
  assert.match(txt, /TV split[\s\S]*trigger\s+349/);
  assert.match(txt, /minutes: TP 100 · TV 100/);
  assert.doesNotMatch(txt, /TP split/);   // no split for a tool without its own clock
  assert.match(txt, /Clock ✓ fastest delivery 1700 ms/);
  assert.ok(txt.split('\n').every((l) => [...l].length <= 32), 'fits a phone');
  assert.match(latencyReport({ ticks: [], samples: [], label: '24h' }), /No charting-tool ticks yet/);
});

await t('Webhooks: missed bar closes counted per tool, rejected or lost alike', () => {
  const c0 = Date.parse('2026-11-26T10:00:00Z');
  const lost = new Set([5, 6, 40]);
  const ks = Array.from({ length: 100 }, (_, i) => i).filter((i) => !lost.has(i))
    .map((i) => ({ t: c0 + i * 60_000 + 2000, delays: { closeAt: c0 + i * 60_000, binanceToTv: 300, tvToCloudflare: 1700 } }));
  const at = c0 + 99 * 60_000 + 25_000;                       // the last bar is due
  const d = delivery(ks, at);
  assert.equal(d.due, 100); assert.equal(d.got, 97); assert.deepEqual(d.missed.map((c) => (c - c0) / 60_000), [5, 6, 40]);
  assert.equal(delivery(ks, c0 + 99 * 60_000 + 5000).due, 99);   // the bar that just closed is not due yet
  const txt = latencyReport({ ticks: ks, samples: [], label: '24h', at });
  assert.match(txt, /\nTV\s+97\/100\s+97\.0%/);
  assert.match(txt, /TV missed 3 · last 10:40/);
  assert.ok(txt.split('\n').every((l) => [...l].length <= 32), 'fits a phone');
  assert.match(latencyReport({ ticks: ks.slice(0, 1), samples: [], label: '24h', at: c0 + 25_000 }), /TV\s+1\/1\s+100\.0%/);
});

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); } else console.log('\nall market-watch tests passed');
