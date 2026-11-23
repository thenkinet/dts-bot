// Disaster stop tests with a scripted exchange. Run: npm run test:disaster
import { syncDisasterStop, stopTrigger, describeStop } from '../src/disaster.js';
import { orderHash, quantize8 } from '../src/paradex-sign.js';

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fail++; };

function fakeEx({ pos = null, stops = [], bid = 61000, ask = 61010 } = {}) {
  const ex = { sent: [], cancelled: [], n: 0 };
  Object.assign(ex, {
    async market(symbol) { return { symbol, price_tick_size: '0.1', order_size_increment: '0.00001' }; },
    async positions() { return { results: pos ? [{ market: 'BTC-USD-PERP', status: 'OPEN', ...pos }] : [] }; },
    async openOrders() { return { results: stops }; },
    async bestPrices() { return { bid: String(bid), ask: String(ask) }; },
    async placeOrder(o) { ex.sent.push(o); return { id: `s${++ex.n}`, status: 'NEW' }; },
    async cancelOrder(id) { ex.cancelled.push(id); return {}; },
  });
  return ex;
}
const opts = { bps: 500, now: () => 1 };
const ourStop = (over) => ({ id: 'old', market: 'BTC-USD-PERP', type: 'STOP_MARKET', flags: ['REDUCE_ONLY'], client_id: 'dts-stop-0', status: 'UNTRIGGERED', ...over });

check('trigger: long 5% below entry, rounded down', stopTrigger(true, 61000, 500, '0.1') === '57950');
check('trigger: short 5% above entry, rounded up', stopTrigger(false, 61000.05, 500, '0.1') === '64050.1');

{ const ex = fakeEx({ pos: { side: 'LONG', size: '0.0002', average_entry_price: '61000' } });
  const s = await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  const o = ex.sent[0];
  check('long position: one reduce-only STOP_MARKET SELL for the whole size at entry -5%',
    ex.sent.length === 1 && o.type === 'STOP_MARKET' && o.side === 'SELL' && o.size === '0.0002' && o.triggerPrice === '57950'
    && o.flags.includes('REDUCE_ONLY') && o.clientId.startsWith('dts-stop-') && s.action === 'placed', JSON.stringify(o)); }

{ const ex = fakeEx({ pos: { side: 'SHORT', size: '0.0004', average_entry_price: '61000' } });
  await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  check('short position: BUY stop above the entry', ex.sent[0].side === 'BUY' && ex.sent[0].triggerPrice === '64050'); }

{ const ex = fakeEx({ pos: { side: 'LONG', size: '0.0002', average_entry_price: '61000' }, stops: [ourStop({ side: 'SELL', size: '0.0002', trigger_price: '57950' })] });
  const s = await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  check('right stop already there: nothing sent, nothing cancelled', s.action === 'kept' && ex.sent.length === 0 && ex.cancelled.length === 0); }

{ const ex = fakeEx({ pos: { side: 'LONG', size: '0.0004', average_entry_price: '61000' }, stops: [ourStop({ side: 'SELL', size: '0.0002', trigger_price: '57950' })] });
  const calls = [];
  const p = ex.placeOrder, c = ex.cancelOrder;
  ex.placeOrder = async (o) => { calls.push('place'); return p(o); };
  ex.cancelOrder = async (id) => { calls.push('cancel'); return c(id); };
  await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  check('position grew: the new stop is placed BEFORE the old one is cancelled', calls.join(',') === 'place,cancel' && ex.sent[0].size === '0.0004'); }

{ const ex = fakeEx({ pos: null, stops: [ourStop({ side: 'SELL', size: '0.0002', trigger_price: '57950' })] });
  const s = await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  check('no position: our stop is cancelled, nothing placed', s.action === 'cancelled' && ex.cancelled[0] === 'old' && ex.sent.length === 0); }

{ const ex = fakeEx({ pos: null, stops: [ourStop({ client_id: 'manual-1', side: 'SELL', size: '0.0002', trigger_price: '50000' })] });
  await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  check('a stop placed by hand (other client id) is never touched', ex.cancelled.length === 0); }

{ const ex = fakeEx({ pos: { side: 'LONG', size: '0.0002' } });
  await syncDisasterStop(ex, 'BTC-USD-PERP', opts);
  check('no entry price reported: falls back to the bid', ex.sent[0].triggerPrice === '57950'); }

check('Telegram wording', /falls to 57950/.test(describeStop({ action: 'placed', side: 'SELL', size: '0.0002', trigger: '57950' })));

// Signing: a stop order signs a price of 0, as the official SDK does (it is not a limit type).
const h1 = orderHash('PRIVATE_SN_PARACLEAR_MAINNET', '0x1', { timestamp: 1, market: 'BTC-USD-PERP', side: 'SELL', orderType: 'STOP_MARKET', size: '0.0002', price: undefined });
const h2 = orderHash('PRIVATE_SN_PARACLEAR_MAINNET', '0x1', { timestamp: 1, market: 'BTC-USD-PERP', side: 'SELL', orderType: 'STOP_MARKET', size: '0.0002', price: '0' });
check('STOP_MARKET signs price 0 whatever price is passed', h1 === h2 && quantize8('0') === '0');

console.log(fail ? `\n${fail} disaster check(s) failed` : '\nAll disaster-stop checks passed');
process.exit(fail ? 1 : 0);
