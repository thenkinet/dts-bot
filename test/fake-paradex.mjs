// A small simulated Paradex for executor tests: one market, a top of book, a position,
// IOC and post-only matching, reduce-only clipping, and Paradex Retail's processing
// DELAY on every submit and cancel (delayMs, 300 by default). Sizes are plain numbers.
// Time only advances through the fake clock, which calls advance().
export class FakeParadex {
  constructor({ bid = 100, ask = 100.5, depth = 1e9, tick = '0.5', step = '0.001', delayMs = 300 } = {}) {
    Object.assign(this, { bid, ask, depth, tick, step, delayMs });
    this.pos = 0;              // signed position
    this.orders = new Map();
    this.sent = [];            // every order request, for assertions
    this.pending = [];         // { due, run } actions waiting for the delay
    this.t = 0;
    this.n = 0;
  }
  async market(symbol) { return { symbol, price_tick_size: this.tick, order_size_increment: this.step }; }
  async bestPrices() { return { bid: this.bid ? String(this.bid) : null, ask: this.ask ? String(this.ask) : null }; }
  async positions() {
    return { results: this.pos === 0 ? [] : [{ market: 'BTC-USD-PERP', side: this.pos > 0 ? 'LONG' : 'SHORT', size: String(Math.abs(+this.pos.toFixed(8))), status: 'OPEN' }] };
  }
  async openOrders() { return { results: [...this.orders.values()].filter((o) => o.status === 'OPEN') }; }
  async getOrder(id) { const o = this.orders.get(id); return { ...o, remaining_size: String(o.remaining) }; }
  async cancelAll() { for (const o of this.orders.values()) if (o.status !== 'CLOSED') o.status = 'CLOSED'; return {}; }
  async cancelOrder(id) {
    this.pending.push({ due: this.t + this.delayMs, run: () => { const o = this.orders.get(id); if (o && o.status !== 'CLOSED') o.status = 'CLOSED'; } });
    return {};
  }

  #clip(side, size, reduceOnly) {
    if (!reduceOnly) return size;
    const closable = side === 'BUY' ? Math.max(0, -this.pos) : Math.max(0, this.pos);
    return Math.min(size, closable);
  }
  #fill(o, qty, price) {
    if (qty <= 0) return;
    const prevFilled = Number(o.size) - o.remaining;
    o.avg_fill_price = String(((Number(o.avg_fill_price || 0) * prevFilled) + price * qty) / (prevFilled + qty));
    o.remaining = +(o.remaining - qty).toFixed(8);
    this.pos = +(this.pos + (o.side === 'BUY' ? qty : -qty)).toFixed(8);
    if (o.remaining <= 0) o.status = 'CLOSED';
  }
  #process(o) {
    const price = Number(o.price), size = Number(o.size);
    const reduceOnly = (o.flags || []).includes('REDUCE_ONLY');
    const crosses = o.side === 'BUY' ? (this.ask && price >= this.ask) : (this.bid && price <= this.bid);
    if (o.instruction === 'POST_ONLY') {
      if (crosses) { o.status = 'CLOSED'; o.cancel_reason = 'POST_ONLY_WOULD_CROSS'; } else o.status = 'OPEN';
      return;
    }
    if (o.instruction === 'IOC') {
      const qty = crosses ? Math.min(this.#clip(o.side, size, reduceOnly), this.depth) : 0;
      this.#fill(o, qty, o.side === 'BUY' ? this.ask : this.bid);
      o.status = 'CLOSED';
    }
  }
  async placeOrder(req) {
    this.sent.push(req);
    const id = `o${++this.n}`;
    const o = { id, ...req, remaining: Number(req.size), status: 'NEW', avg_fill_price: undefined };
    this.orders.set(id, o);
    if (this.delayMs > 0) this.pending.push({ due: this.t + this.delayMs, run: () => { if (o.status === 'NEW') this.#process(o); } });
    else this.#process(o);
    return { id, status: o.status };
  }
  // Move the market; resting post-only orders that are now crossed fill at their own price.
  move(bid, ask) {
    this.bid = bid; this.ask = ask;
    for (const o of this.orders.values()) {
      if (o.status !== 'OPEN') continue;
      const p = Number(o.price);
      const hit = o.side === 'BUY' ? (this.ask && this.ask <= p) : (this.bid && this.bid >= p);
      if (hit) this.#fill(o, this.#clip(o.side, o.remaining, (o.flags || []).includes('REDUCE_ONLY')), p);
    }
  }
  advance(t) {
    this.t = t;
    this.pending.sort((a, b) => a.due - b.due);
    while (this.pending.length && this.pending[0].due <= t) this.pending.shift().run();
  }
}

// A fake clock: sleep advances time instantly, runs scheduled market moves,
// then lets the exchange process whatever its delay has made due.
export function fakeClock(px, schedule = []) {
  let t = 0;
  const moves = [...schedule].sort((a, b) => a.at - b.at);
  return {
    now: () => t,
    async sleep(ms) {
      const end = t + ms;
      while (moves.length && moves[0].at <= end) { const m = moves.shift(); px?.advance(m.at); m.run(); }
      t = end;
      px?.advance(t);
    },
  };
}
