// Run: npm run check   (reads .env.local; see README)
import { Paradex } from '../src/paradex-client.js';
import { runCheck } from '../src/check.js';

const env = process.env;
if ((env.PARADEX_ENV || 'testnet') !== 'testnet') {
  console.error('This check only runs against the testnet. Set PARADEX_ENV=testnet.');
  process.exit(1);
}
const px = new Paradex({
  env: 'testnet',
  account: env.PARADEX_ACCOUNT,
  privateKey: env.PARADEX_PRIVATE_KEY,
  interactive: env.PARADEX_INTERACTIVE === 'true',
});
try {
  await runCheck(px, env.MARKET || 'BTC-USD-PERP', (...a) => console.log(...a));
} catch {
  console.error('\nStopped at the first failure above. Copy the full output into the review.');
  process.exit(1);
}
