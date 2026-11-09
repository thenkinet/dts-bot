// Cross-checks the JavaScript signer against the Python oracle's output.
// Run from this folder: node test.mjs
import { readFileSync } from 'node:fs';
import { authHash, orderHash, signHash, verifyHash, publicKeyOf, fullPublicKeyOf, quantize8 } from '../src/paradex-sign.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
const O = JSON.parse(readFileSync(new URL('./oracle_out.json', import.meta.url)));
const byLabel = Object.fromEntries(O.cases.map((c) => [c.label, c]));
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fail++; };

const pub = publicKeyOf(V.private_key);
const full = fullPublicKeyOf(V.private_key);
check('public key matches Python', BigInt(pub) === BigInt(O.public_key));

const jobs = [['auth', authHash(V.chain_id_str, V.account_address, V.auth.timestamp, V.auth.expiration)]];
for (const o of V.orders) {
  check(`quantize size ${o.label}`, quantize8(o.size) === o.size_q);
  if (o.orderType !== 'MARKET') check(`quantize price ${o.label}`, quantize8(o.price) === o.price_q);
  jobs.push(['order:' + o.label, orderHash(V.chain_id_str, V.account_address, o)]);
}

for (const [label, h] of jobs) {
  const py = byLabel[label];
  check(`${label} hash identical`, BigInt(py.hash) === h);
  const js = signHash(h, V.private_key);
  check(`${label} JS signature verifies`, verifyHash(h, js.r, js.s, full));
  check(`${label} Python signature verifies in JS`, verifyHash(h, py.r, py.s, full));
}
// Independent oracle: hashes built by Paradex's official SDK message builders.
let sdk = null;
// Required (review D7): a missing file is a failure, not a skip. Regenerate with test/sdk_oracle.py.
try { sdk = JSON.parse(readFileSync(new URL('./sdk_out.json', import.meta.url))); } catch { check('test/sdk_out.json present (python3 test/sdk_oracle.py test/vectors.json > test/sdk_out.json)', false); }
if (sdk) for (const [label, h] of jobs) {
  const c = sdk.cases.find((x) => x.label === label);
  check(`${label} hash identical to the official Paradex SDK`, c && BigInt(c.hash) === h);
}
if (sdk) check('official-SDK file covers every case', jobs.every(([label]) => sdk.cases.some((x) => x.label === label)));
console.log(fail ? `\n${fail} check(s) failed` : '\nAll required checks passed');
process.exit(fail ? 1 : 0);
