// Disaster stop: every open position carries ONE reduce-only STOP_MARKET order resting at Paradex,
// DISASTER_STOP_BPS (default 500 = 5%) beyond the position's average entry price. Paradex triggers it
// on the mark price, so it protects the position even if the bot, Cloudflare or the phone are down.
//
// syncDisasterStop() makes the exchange match that rule and is safe to call any time:
//   - no position          -> cancel our stops
//   - right stop in place  -> nothing
//   - otherwise            -> place the new stop FIRST, then cancel the old ones (never unprotected)
// Our stops are recognised by type STOP_MARKET, the REDUCE_ONLY flag and a client id starting dts-stop-.
import { floorToTick, ceilToTick, floorToStep, toInt8, fromInt8 } from './paradex-client.js';
import { signedPosition } from './executor.js';

export const DEFAULT_STOP_BPS = 500;
const rows = (r) => (Array.isArray(r) ? r : r?.results || []);
const abs = (n) => (n < 0n ? -n : n);

// Trigger for a position: below the entry for a long (rounded down, further away), above it for a short.
export function stopTrigger(isLong, entry, bps, tick) {
  const k = bps / 10_000;
  return isLong ? floorToTick(Number(entry) * (1 - k), tick) : ceilToTick(Number(entry) * (1 + k), tick);
}

export const isOurStop = (o, market) => o.market === market && o.type === 'STOP_MARKET'
  && (o.flags || []).includes('REDUCE_ONLY') && String(o.client_id || '').startsWith('dts-stop-')
  && o.status !== 'CLOSED';

export async function syncDisasterStop(px, market, { bps = DEFAULT_STOP_BPS, now = Date.now } = {}) {
  const spec = await px.market(market);
  const tick = spec.price_tick_size, step = spec.order_size_increment;
  const positions = await px.positions();
  const pos = signedPosition(positions, market);
  const stops = rows(await px.openOrders(market)).filter((o) => isOurStop(o, market));

  if (abs(pos) < toInt8(step)) {
    for (const o of stops) await px.cancelOrder(o.id);
    return { action: stops.length ? 'cancelled' : 'none', cancelled: stops.length };
  }

  const isLong = pos > 0n;
  const p = rows(positions).find((r) => r.market === market && (!r.status || r.status === 'OPEN')) || {};
  let entry = Number(p.average_entry_price || p.avg_entry_price || 0);
  if (!(entry > 0)) { const b = await px.bestPrices(market); entry = Number(isLong ? b.bid : b.ask) || Number(b.bid || b.ask); }
  if (!(entry > 0)) throw new Error('disaster stop: no entry price and an empty book');

  const side = isLong ? 'SELL' : 'BUY';
  const size = floorToStep(fromInt8(abs(pos)), step);
  const trigger = stopTrigger(isLong, entry, bps, tick);
  const same = stops.find((o) => o.side === side && toInt8(o.size) === toInt8(size)
    && Math.abs(Number(o.trigger_price) - Number(trigger)) <= Number(tick));
  if (same && stops.length === 1) return { action: 'kept', side, size, trigger, id: same.id };

  const r = await px.placeOrder({
    market, side, type: 'STOP_MARKET', size, triggerPrice: trigger, instruction: 'GTC',
    flags: ['REDUCE_ONLY'], clientId: `dts-stop-${now()}`,
  });
  for (const o of stops) await px.cancelOrder(o.id);
  return { action: 'placed', side, size, trigger, entry: String(entry), id: r.id, replaced: stops.length };
}

export const describeStop = (s) => (s.action === 'none' ? 'Disaster stop: none needed (no position).'
  : s.action === 'cancelled' ? `Disaster stop: ${s.cancelled} cancelled (no position).`
  : `Disaster stop ${s.action}: ${s.side} ${s.size} if the mark price ${s.side === 'SELL' ? 'falls to' : 'rises to'} ${s.trigger}.`);
