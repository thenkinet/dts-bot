// The testnet check: log in, place one tiny post-only bid far below the
// market (so it cannot fill), read it back, cancel it, read it back.
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

  if (px.env === 'prod') throw new Error('runCheck is for the testnet only');

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
  log('\nDone: Paradex accepted our login and order signatures.');
}
