// Executor tests against the simulated exchange. Run: npm run test:executor
// Every order and cancel takes 300 ms to process, as on Paradex Retail (review D1), unless a test says otherwise.
import { executeSignal, planLegs, capPrice } from '../src/executor.js';
import { toInt8 } from '../src/paradex-client.js';
import { FakeParadex, fakeClock } from './fake-paradex.mjs';

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fail++; };
const base = { market: 'BTC-USD-PERP', size: '0.01', maxSlippageBps: 20, pollMs: 1000 };

// 1. Leg planning
{
  const s = toInt8('0.001');
  const flip = planLegs(toInt8('0.01'), toInt8('-0.01'), s);
  check('flip long to short = reduce-only close of 0.01, then open 0.01',
    flip.length === 2 && flip[0].reduceOnly && flip[0].size8 === toInt8('0.01') && !flip[1].reduceOnly && flip[1].size8 === toInt8('0.01'));
  const flat = planLegs(toInt8('0.01'), 0n, s);
  check('long to flat = one reduce-only leg', flat.length === 1 && flat[0].reduceOnly && flat[0].side === 'SELL');
  check('already at target = no leg', planLegs(toInt8('0.01'), toInt8('0.01'), s).length === 0);
  check('buy cap rounds down, sell cap rounds up', capPrice('BUY', 100, 20, '0.5') === '100' && capPrice('SELL', 100, 20, '0.5') === '100');
}

// 2. Taker: flat to long, fills at the ask, within the cap
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const c = fakeClock(px);
  const r = await executeSignal(px, { id: 's1', side: 'long', price: 100.4 }, { ...base, mode: 'taker' }, c);
  check('taker long: position 0.01', r.ok && r.after === '0.01');
  check('taker long: IOC only, client id from the signal', px.sent.every((o) => o.instruction === 'IOC' && o.clientId.startsWith('s1-')));
  check('taker long: price sent is the cap (100.5), never above', px.sent.every((o) => Number(o.price) <= 100.5));
}

// 3. Taker: flip long to short uses reduce-only for the closing part
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  px.pos = 0.01;
  const r = await executeSignal(px, { id: 's2', side: 'short', price: 100.1 }, { ...base, mode: 'taker' }, fakeClock(px));
  const flags = px.sent.map((o) => (o.flags || []).join(','));
  check('flip: ends short 0.01', r.ok && r.after === '-0.01');
  check('flip: first order reduce-only, second not', flags[0] === 'REDUCE_ONLY' && flags[1] === '');
}

// 4. Taker: market beyond the cap stops, and the gap is reported
{
  const px = new FakeParadex({ bid: 101, ask: 101.5 });
  const r = await executeSignal(px, { id: 's3', side: 'long', price: 100 }, { ...base, mode: 'taker' }, fakeClock(px));
  check('cap: nothing sent when the ask is beyond the cap', px.sent.length === 0 && !r.ok && r.gap === '0.01', r.legs[0]?.stopped || '');
}

// 5. Taker: thin liquidity, partial fills completed over several attempts
{
  const px = new FakeParadex({ bid: 100, ask: 100.5, depth: 0.004 });
  const r = await executeSignal(px, { id: 's4', side: 'long', price: 100.4 }, { ...base, mode: 'taker', takerAttempts: 3 }, fakeClock(px));
  check('partial: 0.004 + 0.004 + 0.002 over 3 IOC attempts reach 0.01', px.sent.length === 3 && r.after === '0.01');
}

// 6. Maker: rests at the bid, filled when the market comes down
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const c = fakeClock(px, [{ at: 3000, run: () => px.move(99.5, 100) }]);
  const r = await executeSignal(px, { id: 's5', side: 'long', price: 100.25 }, { ...base, mode: 'maker', makerWindowMs: 60000, makerReposts: 4 }, c);
  check('maker: filled by the post-only order, no fallback', r.ok && r.legs[0].fallback === false && r.legs[0].fills[0].method === 'maker');
  check('maker: first order post-only at the bid', px.sent[0].instruction === 'POST_ONLY' && px.sent[0].price === '100');
}

// 7. Maker: never filled within the window, IOC fallback completes it
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const r = await executeSignal(px, { id: 's6', side: 'long', price: 100.5 }, { ...base, mode: 'maker', makerWindowMs: 20000, makerReposts: 1 }, fakeClock(px));
  const last = px.sent.at(-1);
  check('maker fallback: last order IOC, position reached', last.instruction === 'IOC' && r.ok && r.legs[0].fallback === true);
  check('maker fallback: cancels its resting order before falling back', [...px.orders.values()].filter((o) => o.instruction === 'POST_ONLY').every((o) => o.status === 'CLOSED'));
}

// 7b. Maker: unfilled, and the fallback would break the cap: no IOC, gap reported
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const r = await executeSignal(px, { id: 's6b', side: 'long', price: 100.25 }, { ...base, mode: 'maker', makerWindowMs: 20000, makerReposts: 1 }, fakeClock(px));
  check('maker fallback respects the cap: no IOC above it, gap reported', !px.sent.some((o) => o.instruction === 'IOC') && !r.ok && r.gap === '0.01', r.legs[0].stopped || '');
}

// 8. Maker: re-posts when the touch moves away
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const c = fakeClock(px, [{ at: 2000, run: () => px.move(100.5, 101) }, { at: 9000, run: () => px.move(100, 100.5) }]);
  const r = await executeSignal(px, { id: 's7', side: 'long', price: 100.5 }, { ...base, mode: 'maker', makerWindowMs: 60000, makerReposts: 4 }, c);
  const posts = px.sent.filter((o) => o.instruction === 'POST_ONLY').map((o) => o.price);
  check('maker re-post: second post-only at the new bid 100.5', posts[0] === '100' && posts[1] === '100.5' && r.ok, `posts ${posts.join(' -> ')}`);
}

// 9. Empty side of the book (seen on the real testnet: best ask "0")
{
  const px = new FakeParadex({ bid: 79000, ask: null, tick: '0.1', step: '0.00001' });
  const r = await executeSignal(px, { id: 's8', side: 'long', price: 79010 }, { ...base, size: '0.001', mode: 'taker' }, fakeClock(px));
  check('no sellers: nothing sent, reason reported', px.sent.length === 0 && !r.ok && /no sellers/.test(r.legs[0].stopped), r.legs[0].stopped);
  const px2 = new FakeParadex({ bid: null, ask: null });
  let threw = false;
  try { await executeSignal(px2, { id: 's9', side: 'long' }, { ...base, mode: 'taker' }, fakeClock(px2)); } catch { threw = true; }
  check('empty book and no signal price: refuses to trade', threw);
}

// 10. D1: with the 300 ms delay, one IOC that fills fully is the ONLY order (v3 sent up to 3)
{
  const px = new FakeParadex({ bid: 100, ask: 100.5, delayMs: 300 });
  const r = await executeSignal(px, { id: 'd1', side: 'long', price: 100.4 }, { ...base, mode: 'taker', takerAttempts: 3 }, fakeClock(px));
  check('D1 delay: exactly one IOC, position 0.01, never above target', px.sent.length === 1 && r.ok && r.after === '0.01' && px.pos === 0.01, `sent ${px.sent.length}, pos ${px.pos}`);
}

// 11. D1: a slower exchange (900 ms) still gives one order and the right position
{
  const px = new FakeParadex({ bid: 100, ask: 100.5, delayMs: 900 });
  const r = await executeSignal(px, { id: 'd1b', side: 'short', price: 100.1 }, { ...base, mode: 'taker' }, fakeClock(px));
  check('D1 900 ms delay: one IOC, position -0.01', px.sent.length === 1 && r.after === '-0.01' && px.pos === -0.01, `sent ${px.sent.length}, pos ${px.pos}`);
}

// 12. D1: an order whose state never becomes final stops the leg: no further order
{
  const px = new FakeParadex({ bid: 100, ask: 100.5, delayMs: 1e9 });
  const r = await executeSignal(px, { id: 'd1c', side: 'long', price: 100.4 }, { ...base, mode: 'taker', takerAttempts: 3 }, fakeClock(px));
  check('D1 unknown state: one order only, stopped, reported', px.sent.length === 1 && !r.ok && /no final state/.test(r.stopped || ''), r.stopped || '');
}

// 13. D1: maker order filled DURING its 300 ms cancel: counted, no extra fallback order
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  // The order rests at 100; the touch moves up at 2,000 ms (re-post due), and the market
  // trades down through 100 at 2,100 ms, while the cancel is still being processed.
  const c = fakeClock(px, [{ at: 1500, run: () => px.move(100.5, 101) }, { at: 2100, run: () => px.move(99.5, 100) }]);
  const r = await executeSignal(px, { id: 'd1d', side: 'long', price: 100.5 }, { ...base, mode: 'maker', makerWindowMs: 60000, makerReposts: 4 }, c);
  check('D1 fill during cancel: position exactly 0.01, never 0.02', px.pos === 0.01 && r.after === '0.01' && r.ok, `pos ${px.pos}, sent ${px.sent.map((o) => o.instruction).join(',')}`);
}

// 14. D2: a target above MAX_POSITION is refused before any order
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const r = await executeSignal(px, { id: 'd2', side: 'long', price: 100.4, size: '0.05' }, { ...base, mode: 'taker', maxPosition: '0.02' }, fakeClock(px));
  check('D2 MAX_POSITION: target 0.05 > 0.02 refused, nothing sent', px.sent.length === 0 && !r.ok && /MAX_POSITION/.test(r.refused || ''), r.refused || '');
}

// 15. D2: a manual trade mid-leg pushes the position past the target: no further order
{
  const px = new FakeParadex({ bid: 100, ask: 100.5, depth: 0.004 });
  let n = 0;
  const pos0 = px.positions.bind(px);
  px.positions = async () => { if (++n === 3) px.pos = +(px.pos + 0.01).toFixed(8); return pos0(); };  // someone trades by hand
  const r = await executeSignal(px, { id: 'd2b', side: 'long', price: 100.4 }, { ...base, mode: 'taker', maxPosition: '0.02' }, fakeClock(px));
  check('D2 position read before each order: stops adding after a manual trade, reports the gap', px.sent.length === 2 && !r.ok && r.gap === '-0.008', `sent ${px.sent.length}, gap ${r.gap}`);
}

// 16. D3: the guard is called before EVERY order; a halt mid-execution stops the next order
{
  const px = new FakeParadex({ bid: 100, ask: 100.5, depth: 0.004 });
  let calls = 0;
  const guard = async () => (++calls >= 2 ? 'HALTED' : null);
  const r = await executeSignal(px, { id: 'd3', side: 'long', price: 100.4 }, { ...base, mode: 'taker' }, { ...fakeClock(px), guard });
  check('D3 halt mid-leg: 1 order sent, then stopped with HALTED', px.sent.length === 1 && calls === 2 && r.stopped === 'HALTED' && !r.ok, `sent ${px.sent.length}, calls ${calls}`);
}

// 17. D3: halted from the start: nothing at all
{
  const px = new FakeParadex({ bid: 100, ask: 100.5 });
  const r = await executeSignal(px, { id: 'd3b', side: 'short', price: 100.1 }, { ...base, mode: 'maker' }, { ...fakeClock(px), guard: async () => 'HALTED' });
  check('D3 halted: no order sent', px.sent.length === 0 && r.stopped === 'HALTED');
}

console.log(fail ? `\n${fail} executor check(s) failed` : '\nAll executor checks passed');
process.exit(fail ? 1 : 0);
