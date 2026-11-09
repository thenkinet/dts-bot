// Track A executor: turns one directional signal into orders on Paradex.
//
//   signal = { id, side: 'long' | 'short' | 'flat', price?, size? }
//
// Two methods (cfg.mode):
//   'taker'  IOC limit orders capped at the reference price +/- maxSlippageBps.
//            With a Retail (interactive) token: zero fees, access to RPI liquidity.
//   'maker'  post-only at the touch, re-posted at the new touch while time remains,
//            then IOC fallback (same cap) for whatever is unfilled. Test bench for Track B.
//
// Safety rules (from Quant 2's reviews):
// - Never decide the next order before the previous one is in a FINAL state (Paradex Retail
//   delays every submit and cancel by 300 ms). If an order's state stays unknown, the leg stops.
// - Remaining size = the smaller of (leg size - fills of final orders) and (distance from the
//   position at Paradex to the leg's goal), so neither a lagging position nor a lagging order
//   can cause an extra order.
// - Before EVERY order: deps.guard() (HALT flag, daily loss) and the MAX_POSITION check.
// - Flips are a reduce-only close then an opening leg; every client id derives from the signal id.
import { floorToTick, ceilToTick, floorToStep, toInt8, fromInt8 } from './paradex-client.js';

export const DEFAULTS = {
  mode: 'taker',           // 'taker' | 'maker'
  size: '0.001',           // position size per signal, in base units
  maxPosition: null,       // hard cap on |position| (required by the Engine)
  maxSlippageBps: 20,      // cap around the reference price
  takerAttempts: 3,        // IOC attempts per leg
  makerWindowMs: 60_000,   // patience before the IOC fallback
  makerReposts: 4,         // re-posts at the new touch within the window
  pollMs: 2_000,           // status polling while a maker order rests
  statusPollMs: 250,       // polling while waiting for a final state
  finalTimeoutMs: 5_000,   // longest wait for a final state before the leg stops
};

const abs = (n) => (n < 0n ? -n : n);
const sgn = (n) => (n > 0n ? 1 : n < 0n ? -1 : 0);
const rows = (r) => (Array.isArray(r) ? r : r?.results || []);

class Stop extends Error {}

// Signed position (1e8 BigInt) of one market from a /positions reply.
export function signedPosition(positions, market) {
  const p = rows(positions).find((r) => r.market === market && (!r.status || r.status === 'OPEN'));
  if (!p) return 0n;
  const raw = String(p.size ?? '0');
  const a = abs(toInt8(raw));
  if (p.side) return p.side === 'SHORT' ? -a : a;
  return toInt8(raw);
}

// Target position (1e8 BigInt) implied by a signal.
export function targetOf(signal, cfg) {
  const s = abs(toInt8(signal.size ?? cfg.size));
  if (signal.side === 'long') return s;
  if (signal.side === 'short') return -s;
  if (signal.side === 'flat') return 0n;
  throw new Error(`bad signal side: ${signal.side}`);
}

// Legs needed to go from position q to target t: a reduce-only part first, then an opening part.
export function planLegs(q, t, step8) {
  const delta = t - q;
  if (abs(delta) < step8) return [];
  const side = delta > 0n ? 'BUY' : 'SELL';
  let reduce = 0n;
  if (q !== 0n && sgn(delta) !== sgn(q)) reduce = abs(delta) < abs(q) ? abs(delta) : abs(q);
  const open = abs(delta) - reduce;
  const legs = [];
  if (reduce > 0n) legs.push({ name: 'close', side, size8: reduce, reduceOnly: true });
  if (open > 0n) legs.push({ name: 'open', side, size8: open, reduceOnly: false });
  return legs;
}

// Price cap for a side: never pay more than ref*(1+s) on a buy, nor accept less than ref*(1-s) on a sell.
export function capPrice(side, ref, bps, tick) {
  const k = bps / 10_000;
  return side === 'BUY' ? floorToTick(Number(ref) * (1 + k), tick) : ceilToTick(Number(ref) * (1 - k), tick);
}

const beyondCap = (side, price, cap) => (side === 'BUY' ? Number(price) > Number(cap) : Number(price) < Number(cap));
const filledOf = (o, size8) => {
  const left = abs(toInt8(o.remaining_size ?? fromInt8(size8)));
  return left >= size8 ? 0n : size8 - left;
};

export async function executeSignal(px, signal, cfgIn = {}, deps = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const guard = deps.guard || (async () => null);
  const market = cfg.market;

  const spec = await px.market(market);
  const tick = spec.price_tick_size, step = spec.order_size_increment;
  const step8 = toInt8(step);
  const maxPos8 = cfg.maxPosition ? abs(toInt8(cfg.maxPosition)) : null;
  const floorStep = (x8) => (x8 <= 0n ? 0n : abs(toInt8(floorToStep(fromInt8(x8), step))));

  let pos = signedPosition(await px.positions(), market);
  const before = pos;
  const target = targetOf(signal, cfg);
  const report = { signalId: signal.id, mode: cfg.mode, market, before: fromInt8(before), target: fromInt8(target), legs: [] };

  if (maxPos8 !== null && abs(target) > maxPos8) {
    report.refused = `target ${fromInt8(target)} is above MAX_POSITION ${fromInt8(maxPos8)}`;
    report.after = report.before; report.ok = false;
    return report;
  }
  const legs = planLegs(before, target, step8);
  const top0 = await px.bestPrices(market);
  const sides = [top0.bid, top0.ask].filter(Boolean).map(Number);
  const mid0 = sides.length ? sides.reduce((a, b) => a + b, 0) / sides.length : null;
  const ref = signal.price ?? mid0;
  Object.assign(report, { ref: ref == null ? null : String(ref), bidAtStart: top0.bid, askAtStart: top0.ask });
  if (legs.length === 0) { report.after = report.before; report.ok = true; report.note = 'already at target'; return report; }
  if (!ref) throw new Error('no reference price: the signal has none and the book is empty');

  const readPos = async () => { pos = signedPosition(await px.positions(), market); return pos; };

  // Wait until an order reaches a final state; null if it does not within finalTimeoutMs.
  const waitFinal = async (id) => {
    const end = now() + cfg.finalTimeoutMs;
    do {
      await sleep(cfg.statusPollMs);
      const o = await px.getOrder(id);
      if (o.status === 'CLOSED') return o;
    } while (now() < end);
    return null;
  };

  // Every order goes through here: guard (HALT, daily loss) and MAX_POSITION first.
  const send = async (req, leg) => {
    const why = await guard({ leg: leg.name, side: req.side, size: req.size, reduceOnly: leg.reduceOnly });
    if (why) throw new Stop(why);
    if (!leg.reduceOnly && maxPos8 !== null) {
      const signed = (req.side === 'BUY' ? 1n : -1n) * toInt8(req.size);
      if (abs(pos + signed) > maxPos8) throw new Stop(`order would take the position beyond MAX_POSITION ${fromInt8(maxPos8)}`);
    }
    return px.placeOrder(req);
  };

  try {
    for (const leg of legs) {
      const cap = capPrice(leg.side, ref, cfg.maxSlippageBps, tick);
      const legSize = floorStep(leg.size8);
      const goal = pos + (leg.side === 'BUY' ? legSize : -legSize);
      const rec = { leg: leg.name, side: leg.side, size: fromInt8(legSize), cap, fills: [], method: cfg.mode, fallback: false };
      report.legs.push(rec);
      let filled = 0n;
      const remaining = () => {
        const byOrders = legSize - filled;
        const byPos = leg.side === 'BUY' ? goal - pos : pos - goal;
        return floorStep(byOrders < byPos ? byOrders : byPos);
      };
      const book = (o, sent, method, fallbackPrice) => {
        const got = filledOf(o, sent);
        if (got > 0n) rec.fills.push({ method, size: fromInt8(got), price: o.avg_fill_price ?? fallbackPrice });
        filled += got;
      };

      // ---- maker method: post-only at the touch, re-posted while time remains ----
      if (cfg.mode === 'maker') {
        const deadline = now() + cfg.makerWindowMs;
        const slice = cfg.makerWindowMs / (cfg.makerReposts + 1);
        for (let n = 0; n <= cfg.makerReposts && remaining() > 0n && now() < deadline; n++) {
          const top = await px.bestPrices(market);
          const own = leg.side === 'BUY' ? top.bid : top.ask;
          const price = own ? (leg.side === 'BUY' ? floorToTick(own, tick) : ceilToTick(own, tick)) : cap;
          if (beyondCap(leg.side, price, cap)) { log(`maker: touch ${price} beyond cap ${cap}, waiting`); await sleep(slice); continue; }
          const sent = remaining();
          const r = await send({
            market, side: leg.side, type: 'LIMIT', size: fromInt8(sent), price, instruction: 'POST_ONLY',
            flags: leg.reduceOnly ? ['REDUCE_ONLY'] : undefined, clientId: `${signal.id}-${leg.name}-m${n}`,
          }, leg);
          let o = null;
          const sliceEnd = Math.min(deadline, now() + slice);
          while (now() < sliceEnd) {
            await sleep(cfg.pollMs);
            const cur = await px.getOrder(r.id);
            if (cur.status === 'CLOSED') { o = cur; break; }
            const t = await px.bestPrices(market);
            const touch = leg.side === 'BUY' ? t.bid : t.ask;
            if (touch && (leg.side === 'BUY' ? Number(touch) > Number(price) : Number(touch) < Number(price))) break; // left behind
          }
          if (!o) { await px.cancelOrder(r.id); o = await waitFinal(r.id); }
          if (!o) throw new Stop(`order ${r.id} has no final state ${cfg.finalTimeoutMs} ms after its cancel`);
          book(o, sent, 'maker', price);
          await readPos();
        }
        if (remaining() > 0n) rec.fallback = true;
      }

      // ---- taker method (and the maker fallback): IOC at the cap ----
      for (let a = 1; a <= cfg.takerAttempts && remaining() > 0n; a++) {
        const top = await px.bestPrices(market);
        const best = leg.side === 'BUY' ? top.ask : top.bid;
        if (!best) { rec.stopped = `no ${leg.side === 'BUY' ? 'sellers' : 'buyers'} in the book`; break; }
        if (beyondCap(leg.side, best, cap)) { rec.stopped = `best price ${best} beyond cap ${cap}`; break; }
        const sent = remaining();
        const r = await send({
          market, side: leg.side, type: 'LIMIT', size: fromInt8(sent), price: cap, instruction: 'IOC',
          flags: leg.reduceOnly ? ['REDUCE_ONLY'] : undefined, clientId: `${signal.id}-${leg.name}-t${a}`,
        }, leg);
        const o = await waitFinal(r.id);
        if (!o) throw new Stop(`IOC ${r.id} has no final state after ${cfg.finalTimeoutMs} ms`);
        book(o, sent, 'taker', cap);
        await readPos();
      }
      rec.unfilled = fromInt8(remaining());
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    report.stopped = e.message;
    const last = report.legs.at(-1);
    if (last) last.stopped = e.message;
  }

  await readPos();
  report.after = fromInt8(pos);
  report.gap = fromInt8(target - pos);
  report.ok = !report.stopped && abs(target - pos) < step8;
  // Slippage of each fill against the reference, in basis points (positive = cost).
  for (const l of report.legs) for (const f of l.fills) {
    const s = (Number(f.price) - Number(ref)) / Number(ref) * 10_000;
    f.slippageBps = Math.round((l.side === 'BUY' ? s : -s) * 100) / 100;
  }
  return report;
}
