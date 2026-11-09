// Paradex request/order signing for Cloudflare Workers.
// Implements StarkNet typed-data hashing (legacy "StarkNetDomain" revision)
// on top of @scure/starknet only, so the Worker bundle stays small.
// Message layouts follow Paradex's public API documentation.
import { keccak, computeHashOnElements, sign, verify, getStarkKey, getPublicKey, Signature } from '@scure/starknet';

const enc = new TextEncoder();

// Felt encoding: decimal or 0x-hex strings become numbers, other text is a
// Cairo short string (ASCII bytes, max 31 chars), empty string is 0.
export function toFelt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (v === '') return 0n;
  if (/^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (/^[0-9]+$/.test(v)) return BigInt(v);
  if (v.length > 31) throw new Error(`short string too long: ${v}`);
  let n = 0n;
  for (const b of enc.encode(v)) n = (n << 8n) | BigInt(b);
  return n;
}

const typeHash = (name, fields) =>
  keccak(enc.encode(`${name}(${fields.map((f) => `${f}:felt`).join(',')})`));

const hashElements = (xs) => BigInt(computeHashOnElements(xs));

const structHash = (name, fields, values) =>
  hashElements([typeHash(name, fields), ...fields.map((f) => toFelt(values[f]))]);

const DOMAIN_FIELDS = ['name', 'chainId', 'version'];
const REQUEST_FIELDS = ['method', 'path', 'body', 'timestamp', 'expiration'];
const ORDER_FIELDS = ['timestamp', 'market', 'side', 'orderType', 'size', 'price'];

// chainIdStr is the StarkNet chain id string from Paradex's /system/config.
export function messageHash(chainIdStr, account, primaryType, fields, message) {
  const domain = { name: 'Paradex', chainId: toFelt(chainIdStr), version: '1' };
  return hashElements([
    toFelt('StarkNet Message'),
    structHash('StarkNetDomain', DOMAIN_FIELDS, domain),
    toFelt(account),
    structHash(primaryType, fields, message),
  ]);
}

// Exact decimal -> integer scaled by 1e8 (Paradex quantum), no floating point.
export function quantize8(dec) {
  const s = String(dec);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad decimal: ${s}`);
  const [i, f = ''] = s.split('.');
  if (f.length > 8) throw new Error(`more than 8 decimals: ${s}`);
  return (BigInt(i + f.padEnd(8, '0'))).toString();
}

export function authHash(chainIdStr, account, timestamp, expiration) {
  return messageHash(chainIdStr, account, 'Request', REQUEST_FIELDS, {
    method: 'POST', path: '/v1/auth', body: '', timestamp, expiration,
  });
}

// order: { timestamp(ms), market, side: 'BUY'|'SELL', orderType: 'LIMIT'|'MARKET', size, price }
export function orderHash(chainIdStr, account, o) {
  return messageHash(chainIdStr, account, 'Order', ORDER_FIELDS, {
    timestamp: String(o.timestamp),
    market: o.market,
    side: o.side === 'BUY' ? '1' : '2',
    orderType: o.orderType,
    size: quantize8(o.size),
    price: o.orderType === 'MARKET' ? '0' : quantize8(o.price),
  });
}

const hex = (n) => '0x' + n.toString(16);

// Returns the signature in Paradex's header/body format: '["0x<r>","0x<s>"]'.
export function signHash(hash, privateKeyHex) {
  const sig = sign(hex(hash), privateKeyHex);
  return { r: sig.r, s: sig.s, wire: JSON.stringify([hex(sig.r), hex(sig.s)]) };
}

// fullPublicKey: uncompressed key bytes/hex, e.g. from fullPublicKeyOf(privateKey).
export function verifyHash(hash, r, s, fullPublicKey) {
  return verify(new Signature(BigInt(r), BigInt(s)), hex(hash), fullPublicKey);
}

export const fullPublicKeyOf = (privateKeyHex) => getPublicKey(privateKeyHex, false);

export const publicKeyOf = (privateKeyHex) => getStarkKey(privateKeyHex);
