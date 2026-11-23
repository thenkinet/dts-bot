// The check: log in, place one tiny post-only bid 10% below the market (so it cannot
// fill), read it back, cancel it, read it back; then the same with a stop order triggered 50%
// below the market. Safe on the testnet and on the real network.
// Used by scripts/testnet-check.mjs (Node) and by the Worker's /check route.
import { floorToTick, ceilToStep } from './paradex-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runCheck(px, symbol, log = console.log) {
  const step = async (name, fn) => {
    try {
      const out = await fn();
      log(`PASS  ${name}`, out);
      return out;
    } catch (e) {
      log(`FAIL  ${name}`, String(e.message || e));
      throw e;
    }
  };

  await step('1. read system config (chain id)', async () => (await px.init(), { chainId: px.chainId }));
  await step('2. log in and receive a JWT', async () => ({ jwtLength: (await px.login()).length }));
  const m = await step(`3. read ${symbol} specs`, async () => {
    const mk = await px.market(symbol);
    return { tick: mk.price_tick_size, sizeStep: mk.order_size_increment, minNotional: mk.min_notional };
  });
  const top = await step('4. read best bid and ask', async () => {
    const b = await px.bestPrices(symbol);
    return { bid: b.bid, ask: b.ask };
  });

  const anchor = Number(top.bid || top.ask);
  if (!anchor) throw new Error('the order book is empty on both sides: try another market (MARKET=ETH-USD-PERP)');
  const price = floorToTick(anchor * 0.9, m.tick);
  const minSize = Number(m.minNotional || 0) > 0 ? (Number(m.minNotional) * 1.05) / Number(price) : Number(m.sizeStep);
  const size = ceilToStep(Math.max(minSize, Number(m.sizeStep)), m.sizeStep);
  const clientId = `dts-check-${Date.now()}`;

  const placed = await step(`5. place post-only BUY ${size} @ ${price} (10% below the market)`, async () => {
    const r = await px.placeOrder({ market: symbol, side: 'BUY', type: 'LIMIT', size, price, instruction: 'POST_ONLY', clientId });
    return { id: r.id, status: r.status, client_id: r.client_id };
  });
  await sleep(1500);
  await step('6. read the order back', async () => {
    const o = await px.getOrder(placed.id);
    return { status: o.status, remaining_size: o.remaining_size };
  });
  await step('7. cancel it', async () => px.cancelOrder(placed.id));
  await sleep(1500);
  await step('8. read it back after the cancel', async () => {
    const o = await px.getOrder(placed.id);
    return { status: o.status, cancel_reason: o.cancel_reason };
  });
  // 9-12: a STOP_MARKET order, the type the disaster stop uses. Not reduce-only (there is no position
  // to reduce); its trigger is 50% below the market, so it cannot trigger in the seconds it rests.
  const trigger = floorToTick(anchor * 0.5, m.tick);
  const stopSize = ceilToStep(Math.max((Number(m.minNotional || 0) * 1.05) / Number(trigger), Number(m.sizeStep)), m.sizeStep);
  const stop = await step(`9. place stop SELL ${stopSize} triggered at ${trigger} (50% below the market)`, async () => {
    const r = await px.placeOrder({ market: symbol, side: 'SELL', type: 'STOP_MARKET', size: stopSize, triggerPrice: trigger, instruction: 'GTC', clientId: `dts-checkstop-${Date.now()}` });
    return { id: r.id, status: r.status, type: r.type };
  });
  await sleep(1500);
  await step('10. read the stop back, and find it among the open orders', async () => {
    const o = await px.getOrder(stop.id);
    const open = await px.openOrders(symbol);
    const listed = (Array.isArray(open) ? open : open?.results || []).some((x) => x.id === stop.id);
    if (!listed) throw new Error(`stop ${stop.id} is not listed among open orders: the disaster stop would be placed twice`);
    return { status: o.status, trigger_price: o.trigger_price, listedAsOpen: listed };
  });
  await step('11. cancel the stop', async () => px.cancelOrder(stop.id));
  await sleep(1500);
  await step('12. read it back after the cancel', async () => {
    const o = await px.getOrder(stop.id);
    return { status: o.status, cancel_reason: o.cancel_reason };
  });
  log('\nDone: Paradex accepted our login, order and stop-order signatures.');
}
