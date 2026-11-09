// Client tests with a mocked network (no Paradex needed). Run: npm run test:client
// D5: an order POST that times out or gets a 5xx may still have reached Paradex.
// The client must look it up by client id before sending it again.
import { readFileSync } from 'node:fs';
import { Paradex } from '../src/paradex-client.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fail++; };

// A scripted fetch: each POST /orders answer is taken from `orderAnswers`; the exchange
// "has" the order whenever an answer is marked created.
function mockNet(orderAnswers) {
  const log = [];
  const book = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname.replace('/v1', ''), method = init.method || 'GET';
    log.push(`${method} ${path}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/system/config') return json(200, { starknet_chain_id: V.chain_id_str });
    if (path.startsWith('/auth/')) return json(200, { jwt_token: 'jwt' });
    if (method === 'POST' && path === '/orders') {
      const body = JSON.parse(init.body);
      const a = orderAnswers.shift() || { status: 201 };
      if (a.created) book.set(body.client_id, { id: `o${book.size + 1}`, client_id: body.client_id, status: 'NEW' });
      if (a.status === 'timeout') { await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }
      if (a.status >= 400) return json(a.status, { error: a.error || 'SERVER_ERROR' });
      book.set(body.client_id, { id: `o${book.size + 1}`, client_id: body.client_id, status: 'NEW' });
      return json(201, book.get(body.client_id));
    }
    if (method === 'GET' && path.startsWith('/orders/by_client_id/')) {
      const o = book.get(decodeURIComponent(path.split('/').pop()));
      return o ? json(200, o) : json(404, { error: 'ORDER_ID_NOT_FOUND' });
    }
    return json(404, {});
  };
  return { log, book };
}

const px = () => new Paradex({ env: 'testnet', account: V.account_address, privateKey: V.private_key });
const order = (clientId) => ({ market: 'BTC-USD-PERP', side: 'BUY', type: 'LIMIT', size: '0.001', price: '100000', instruction: 'IOC', clientId });
const posts = (log) => log.filter((l) => l === 'POST /orders').length;

{ // 500 but the order WAS created: found by client id, not re-sent
  const { log, book } = mockNet([{ status: 500, created: true }]);
  const r = await px().placeOrder(order('a1'));
  check('D5 5xx after creation: one POST, order recovered by client id', posts(log) === 1 && r.recovered && book.size === 1, log.join(' | '));
}
{ // 500 and NOT created: looked up (404), then sent again once
  const { log, book } = mockNet([{ status: 500 }, { status: 201 }]);
  const r = await px().placeOrder(order('a2'));
  check('D5 5xx, not created: lookup 404, then one re-send', posts(log) === 2 && !r.recovered && book.size === 1 && log.some((l) => l.startsWith('GET /orders/by_client_id/')));
}
{ // a refusal (400) is final: no lookup, no re-send
  const { log } = mockNet([{ status: 400, error: 'INVALID_ORDER_SIZE' }]);
  let threw = false;
  try { await px().placeOrder(order('a3')); } catch (e) { threw = e.status === 400; }
  check('D5 400 refusal: thrown, never re-sent', threw && posts(log) === 1 && !log.some((l) => l.includes('by_client_id')));
}
{ // no client id: one attempt only, whatever happens
  const { log } = mockNet([{ status: 503 }]);
  let threw = false;
  try { await px().placeOrder(order(undefined)); } catch { threw = true; }
  check('D5 no client id: a single POST, never retried', threw && posts(log) === 1);
}

console.log(fail ? `\n${fail} client check(s) failed` : '\nAll client checks passed');
process.exit(fail ? 1 : 0);
