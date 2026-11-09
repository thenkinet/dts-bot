// Worker routes that need no exchange: /health, /setup, Telegram linking. Network is mocked.
import assert from 'node:assert/strict';
const { default: worker, SECRET_NAMES } = await import('../src/worker.js');

let fails = 0;
const t = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { fails++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'content-type': 'application/json' } });
};
const base = { PARADEX_ENV: 'testnet', MARKET: 'BTC-USD-PERP', MAX_POSITION: '0.002', MAX_DAILY_LOSS: '50',
  PARADEX_ACCOUNT: 'later', PARADEX_PRIVATE_KEY: 'later', TELEGRAM_BOT_TOKEN: 'bot123', SIGNAL_SECRET: 's'.repeat(20), ADMIN_TOKEN: 'a'.repeat(20) };
const req = (path, init) => new Request(`https://dts-bot.example.workers.dev${path}`, init);
const secretFor = async (admin) => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dts-telegram-webhook:${admin}`)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); };
const tg = async (env, text, chat = 111, from = 222, secret) => worker.fetch(req('/telegram', { method: 'POST',
  headers: { 'X-Telegram-Bot-Api-Secret-Token': secret ?? await secretFor(env.ADMIN_TOKEN) },
  body: JSON.stringify({ message: { text, chat: { id: chat }, from: { id: from } } }) }), env);

await t('/health lists secret names, never values; "later" counts as missing', async () => {
  const j = await (await worker.fetch(req('/health'), base)).json();
  assert.deepEqual(j.missing, ['PARADEX_ACCOUNT', 'PARADEX_PRIVATE_KEY']);
  assert.equal(j.secrets.ADMIN_TOKEN, true);
  assert.ok(!JSON.stringify(j).includes(base.ADMIN_TOKEN) && !JSON.stringify(j).includes('bot123'));
  assert.equal(j.telegramLinked, false);
  assert.deepEqual(SECRET_NAMES.length, 5);
});

await t('/setup with a wrong admin token does not touch Telegram', async () => {
  calls.length = 0;
  const r = await worker.fetch(req('/setup', { method: 'POST', body: new URLSearchParams({ token: 'wrong' }) }), base);
  assert.match(await r.text(), /not the one set/);
  assert.equal(calls.length, 0);
});

await t('/setup with the admin token registers the webhook with the derived secret', async () => {
  calls.length = 0;
  const r = await worker.fetch(req('/setup', { method: 'POST', body: new URLSearchParams({ token: base.ADMIN_TOKEN }) }), base);
  assert.match(await r.text(), /Telegram linked/);
  const hook = calls.find((c) => c.url.endsWith('/setWebhook'));
  assert.equal(hook.body.url, 'https://dts-bot.example.workers.dev/telegram');
  assert.equal(hook.body.secret_token, await secretFor(base.ADMIN_TOKEN));
});

await t('Telegram with a wrong webhook secret is refused', async () => {
  const r = await tg(base, '/start', 111, 222, 'nope');
  assert.equal(r.status, 403);
});

await t('Not linked: /start replies to the sender with chat and user numbers', async () => {
  calls.length = 0;
  await tg(base, '/start');
  const m = calls.find((c) => c.url.endsWith('/sendMessage'));
  assert.equal(m.body.chat_id, 111);
  assert.match(m.body.text, /Chat number: 111/);
  assert.match(m.body.text, /User number: 222/);
});

await t('Not linked: /killall does nothing', async () => {
  calls.length = 0;
  const r = await tg(base, '/killall');
  assert.equal(await r.text(), 'not linked');
  assert.equal(calls.length, 0);
});

const linked = { ...base, TELEGRAM_CHAT_ID: '111', TELEGRAM_USER_IDS: '222' };
await t('Linked: a stranger is ignored', async () => {
  calls.length = 0;
  const r = await tg(linked, '/status', 111, 999);
  assert.equal(await r.text(), 'ignored');
  assert.equal(calls.length, 0);
});

await t('Linked: /start from the owner answers in the allowed chat', async () => {
  calls.length = 0;
  await tg(linked, '/start');
  const m = calls.find((c) => c.url.endsWith('/sendMessage'));
  assert.equal(m.body.chat_id, '111');
  assert.match(m.body.text, /Linked/);
});

console.log(fails ? `\n${fails} worker check(s) FAILED` : '\nAll worker checks passed');
process.exit(fails ? 1 : 0);
