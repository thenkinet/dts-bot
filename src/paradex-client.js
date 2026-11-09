// Minimal Paradex REST client for the DTS starter kit.
// Works in Node 20+ and in Cloudflare Workers (both have fetch).
// Message schemas match Paradex's official SDK (paradex-py); see test/sdk_oracle.py.
import { authHash, orderHash, signHash, quantize8, publicKeyOf } from './paradex-sign.js';

export const BASES = {
  testnet: 'https://api.testnet.paradex.trade/v1',
  prod: 'https://api.prod.paradex.trade/v1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTP call with a timeout. Retries only when it is safe:
// - GET and DELETE (idempotent), or a POST explicitly marked idempotent (login). Orders are never
//   retried here: placeOrder checks by client id first (review D5);
// - and only on HTTP 429, HTTP 5xx, a timeout or a network error. Honours Retry-After.
async function call(base, method, path, { jwt, headers = {}, body, timeoutMs = 5000, idempotent } = {}) {
  const canRetry = idempotent ?? (method === 'GET' || method === 'DELETE');
  const attempts = canRetry ? 3 : 1;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
      if (res.ok) return data;
      const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
      err.status = res.status;
      if (!(res.status === 429 || res.status >= 500)) throw err; // client errors: never retried
      lastErr = err;
      const ra = Number(res.headers.get('retry-after'));
      if (i < attempts - 1) await sleep(ra > 0 ? ra * 1000 : 250 * 2 ** i + Math.random() * 100);
    } catch (e) {
      if (e.status && !(e.status === 429 || e.status >= 500)) throw e;
      lastErr = e.name === 'AbortError' ? new Error(`${method} ${path} -> timeout after ${timeoutMs} ms`) : e;
      if (i < attempts - 1) await sleep(250 * 2 ** i + Math.random() * 100);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---- exact decimal helpers (8-decimal grid, no floating point in results) ----
const SCALE = 100000000n;
// Decimal (string or number) to a BigInt scaled by 1e8, and back. Signs supported.
export const toInt8 = (x) => {
  const s = typeof x === 'number' ? x.toFixed(8) : String(x).trim();
  return s.startsWith('-') ? -BigInt(quantize8(s.slice(1))) : BigInt(quantize8(s));
};
export const fromInt8 = (n) => {
  const neg = n < 0n, a = neg ? -n : n;
  const i = a / SCALE, f = (a % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (f ? `${i}.${f}` : `${i}`);
};
// Prices: bids round DOWN, asks round UP, to the tick itself (ticks like 0.5 work).
export const floorToTick = (price, tick) => { const t = toInt8(tick); return fromInt8((toInt8(price) / t) * t); };
export const ceilToTick = (price, tick) => { const t = toInt8(tick), p = toInt8(price); return fromInt8(((p + t - 1n) / t) * t); };
// Sizes: entries may round UP (to reach a minimum); exits always round DOWN,
// so a reduce-only exit can never exceed the position (rule H3).
export const ceilToStep = (size, step) => { const s = toInt8(step), v = toInt8(size); return fromInt8(((v + s - 1n) / s) * s); };
export const floorToStep = (size, step) => { const s = toInt8(step); return fromInt8((toInt8(size) / s) * s); };

const JWT_MAX_AGE_MS = 3 * 60 * 1000; // refresh well before Paradex's short expiry

export class Paradex {
  // account: the main Paradex (Starknet) account address.
  // privateKey: the key that signs: a trade-only subkey for the bot.
  // interactive: true requests a Retail (interactive) token.
  constructor({ env = 'testnet', account, privateKey, interactive = false }) {
    if (!account || !privateKey) throw new Error('account and privateKey are required');
    this.base = BASES[env];
    if (!this.base) throw new Error(`unknown env ${env}`);
    Object.assign(this, { env, account, privateKey, interactive });
    // Same form as the official SDK: hex of the signer's public key, no padding.
    this.publicKey = '0x' + BigInt(publicKeyOf(privateKey)).toString(16);
    this.jwtAt = 0;
  }

  async init() {
    this.config = await call(this.base, 'GET', '/system/config');
    this.chainId = this.config.starknet_chain_id;
    if (!this.chainId) throw new Error(`no starknet_chain_id in /system/config: ${JSON.stringify(this.config)}`);
    return this.config;
  }

  // Login, as the official SDK does it: sign a Request for path /v1/auth,
  // POST it to /auth/{public key of the signing key}. Works for main keys and subkeys.
  async login() {
    if (!this.chainId) await this.init();
    const ts = Math.floor(Date.now() / 1000);
    const exp = ts + 30 * 60;
    const sig = signHash(authHash(this.chainId, this.account, ts, exp), this.privateKey);
    let path = `/auth/${this.publicKey}`;
    if (this.interactive) path += '?token_usage=interactive';
    const r = await call(this.base, 'POST', path, {
      idempotent: true,
      headers: {
        'PARADEX-STARKNET-ACCOUNT': this.account,
        'PARADEX-STARKNET-SIGNATURE': sig.wire,
        'PARADEX-TIMESTAMP': String(ts),
        'PARADEX-SIGNATURE-EXPIRATION': String(exp),
      },
    });
    this.jwt = r.jwt_token;
    if (!this.jwt) throw new Error(`no jwt_token in /auth reply: ${JSON.stringify(r)}`);
    this.jwtAt = Date.now();
    return this.jwt;
  }

  async ensureLogin() {
    if (!this.jwt || Date.now() - this.jwtAt > JWT_MAX_AGE_MS) await this.login();
  }

  // Private call: fresh token, and one re-login on HTTP 401.
  async priv(method, path, opts = {}) {
    await this.ensureLogin();
    try {
      return await call(this.base, method, path, { ...opts, jwt: this.jwt });
    } catch (e) {
      if (e.status !== 401) throw e;
      await this.login();
      return call(this.base, method, path, { ...opts, jwt: this.jwt });
    }
  }

  async market(symbol) {
    const r = await call(this.base, 'GET', `/markets?market=${encodeURIComponent(symbol)}`);
    const m = (r.results || []).find((x) => x.symbol === symbol) || (r.results || [])[0];
    if (!m) throw new Error(`market ${symbol} not found: ${JSON.stringify(r)}`);
    return m;
  }

  // Best bid and ask. A side with no orders is null: Paradex reports it as "0"
  // (seen on the testnet, where the book is thin). Falls back to a depth-1 order book.
  async bestPrices(symbol) {
    const clean = (p) => (p !== undefined && p !== null && Number(p) > 0 ? String(p) : null);
    try {
      const b = await call(this.base, 'GET', `/bbo/${symbol}`);
      return { bid: clean(b.bid), ask: clean(b.ask), raw: b };
    } catch { /* fall through */ }
    const ob = await call(this.base, 'GET', `/orderbook/${symbol}?depth=1`);
    return { bid: clean(ob.bids?.[0]?.[0]), ask: clean(ob.asks?.[0]?.[0]), raw: ob };
  }

  // o: { market, side: 'BUY'|'SELL', type: 'LIMIT'|'MARKET', size, price,
  //      instruction: 'POST_ONLY'|'GTC'|'IOC', flags?: ['REDUCE_ONLY'], clientId? }
  // Never retried blindly (review D5). Without a client id: one attempt. With one: after a
  // 429, 5xx or timeout, it first asks Paradex whether the order exists
  // (GET /orders/by_client_id/{id}); if it does, that order is returned and nothing is re-sent.
  async placeOrder(o) {
    if (!o.clientId) return this.#postOrder(o);
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        return await this.#postOrder(o);
      } catch (e) {
        if (e.status && !(e.status === 429 || e.status >= 500)) throw e;   // a refusal: final
        lastErr = e;
      }
      await sleep(400 * 2 ** i);                       // longer than Retail's 300 ms processing delay
      const found = await this.getOrderByClientId(o.clientId).catch((e) => (e.status >= 400 && e.status < 500 ? null : Promise.reject(e)));
      if (found && found.id) return { ...found, recovered: true };
    }
    throw lastErr;
  }

  async #postOrder(o) {
    if (!this.chainId) await this.init();
    const ts = Date.now();
    const type = o.type || 'LIMIT';
    const sig = signHash(orderHash(this.chainId, this.account, {
      timestamp: ts, market: o.market, side: o.side, orderType: type, size: o.size, price: o.price,
    }), this.privateKey);
    const body = {
      market: o.market, side: o.side, type, size: o.size, price: type === 'MARKET' ? '0' : o.price,
      instruction: o.instruction || 'POST_ONLY', signature: sig.wire, signature_timestamp: ts,
    };
    if (o.flags) body.flags = o.flags;
    if (o.clientId) body.client_id = o.clientId;
    return this.priv('POST', '/orders', { body, idempotent: false });
  }

  getOrderByClientId(clientId) { return this.priv('GET', `/orders/by_client_id/${encodeURIComponent(clientId)}`); }
  account() { return this.priv('GET', '/account'); }           // account_value, free_collateral, ...

  getOrder(id) { return this.priv('GET', `/orders/${id}`); }
  openOrders(market) { return this.priv('GET', market ? `/orders?market=${encodeURIComponent(market)}` : '/orders'); }
  positions() { return this.priv('GET', '/positions'); }
  cancelOrder(id) { return this.priv('DELETE', `/orders/${id}`); }
  cancelAll(market) { return this.priv('DELETE', market ? `/orders?market=${encodeURIComponent(market)}` : '/orders'); }
}
