// Unit test for the "Set up my share site" wizard's Cloudflare calls (lib/cfsetup.js),
// against a fake Cloudflare API: every request's method, path, headers and body, and
// how it copes with Cloudflare's errors. It can't prove the real API agrees (see the
// README's list of what needs a real-account test), only that we send what the docs say.
//
// Usage: node test/cfsetup.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { CloudflareSetup, tokenTemplateUrl, TOKEN_PERMISSIONS, API, COMPATIBILITY_DATE } from '../extension/src/lib/cfsetup.js';

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '  ✓' : '  ✗'} ${what}`); if (!cond) failures++; };
const SHARE = process.env.LUMEN_SHARE_DIR || path.join(ROOT, '..', 'lumen', 'share');
const sources = { 'index.js': fs.readFileSync(path.join(SHARE, 'src', 'index.js'), 'utf8'), 'player.js': fs.readFileSync(path.join(SHARE, 'src', 'player.js'), 'utf8') };
const schemaSql = fs.readFileSync(path.join(SHARE, 'schema.sql'), 'utf8');
const ACCT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token';

// A fake Cloudflare: routes "METHOD path" to handlers, records every request.
function fakeCloudflare(overrides = {}) {
  const calls = [];
  const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
  const err = (status, code, message) => ({ status, body: { success: false, errors: [{ code, message }], result: null } });
  const routes = {
    'GET /user/tokens/verify': () => ok({ id: 't1', status: 'active' }),
    'GET /accounts?per_page=50': () => ok([{ id: ACCT, name: 'Sam’s Account' }]),
    [`GET /accounts/${ACCT}/workers/subdomain`]: () => ok({ subdomain: 'sam' }),
    [`PUT /accounts/${ACCT}/workers/subdomain`]: (b) => ok({ subdomain: b.subdomain }),
    [`POST /accounts/${ACCT}/r2/buckets`]: (b) => ok({ name: b.name }),
    [`POST /accounts/${ACCT}/d1/database`]: () => ok({ uuid: '11111111-2222-3333-4444-555555555555', name: 'x' }),
    [`POST /accounts/${ACCT}/d1/database/11111111-2222-3333-4444-555555555555/query`]: () => ok([{ success: true }]),
    'PUT script': () => ok({ id: 'lumen-share' }),
    'POST script-subdomain': () => ok({ enabled: true, previews_enabled: false }),
    'GET site-info': () => ({ status: 200, body: { api: 2, features: ['tokens'], owner: 'Sam', you: { kind: 'admin' } } }),
    'POST site-tokens': (b) => ({ status: 200, body: { id: 'abcdefghijkm', token: 'lt_abcdefghijkm_' + 'x'.repeat(32), name: b.name, scope: 'record' } }),
    ...overrides,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    let body = init.body;
    let parsed = body;
    if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch { /* raw */ } }
    calls.push({ method, url: u, headers: init.headers || {}, body: parsed, credentials: init.credentials });
    let key;
    if (u.startsWith(API)) {
      const p = u.slice(API.length);
      key = `${method} ${p}`;
      if (/^\/accounts\/[^/]+\/workers\/scripts\/[^/]+$/.test(p) && method === 'PUT') key = 'PUT script';
      if (/^\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/subdomain$/.test(p)) key = 'POST script-subdomain';
      if (p.startsWith(`/accounts/${ACCT}/d1/database?name=`)) key = 'GET d1-list';
    } else if (u.endsWith('/api/info')) key = 'GET site-info';
    else if (u.endsWith('/api/tokens')) key = 'POST site-tokens';
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${key}` }] }), { status: 404 });
    const out = await h(parsed, calls);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl, ok, err };
}

const noSleep = () => Promise.resolve();

// ---- the token page link -------------------------------------------------------------
console.log('Token template link');
{
  const u = new URL(tokenTemplateUrl());
  const keys = JSON.parse(u.searchParams.get('permissionGroupKeys'));
  ok(u.origin + u.pathname === 'https://dash.cloudflare.com/profile/api-tokens', 'opens Cloudflare’s Create Token page');
  ok(JSON.stringify(keys) === JSON.stringify(TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }))), `pre-fills ${keys.map((k) => `${k.key}:${k.type}`).join(', ')}`);
  ok(u.searchParams.get('accountId') === '*' && u.searchParams.get('zoneId') === 'all' && u.searchParams.get('name') === 'Lumen share site setup', 'account *, zones all, a name');
}

// ---- the happy path ----------------------------------------------------------------------
console.log('Happy path (account with a workers.dev subdomain)');
{
  const cf = fakeCloudflare();
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  const accts = await s.accounts();
  ok(accts.length === 1 && accts[0].id === ACCT, 'token checked, account listed');
  const progress = [];
  const saved = [];
  const res = await s.run({ account: ACCT, sources, schemaSql, owner: 'Sam', progress: (id, st) => progress.push(`${id}:${st}`), saveDone: (d) => saved.push(d) });
  const api = cf.calls.filter((c) => c.url.startsWith(API));
  ok(api.every((c) => c.headers.Authorization === `Bearer ${TOKEN}` && c.credentials === 'omit'), 'every Cloudflare call: Bearer token, no cookies');
  const seq = api.map((c) => `${c.method} ${c.url.slice(API.length).replace(/lumen-[a-z-]+[0-9a-f]{6}/g, '<name>')}`);
  ok(JSON.stringify(seq) === JSON.stringify([
    'GET /user/tokens/verify', 'GET /accounts?per_page=50', `GET /accounts/${ACCT}/workers/subdomain`,
    `POST /accounts/${ACCT}/r2/buckets`, `POST /accounts/${ACCT}/d1/database`,
    `POST /accounts/${ACCT}/d1/database/11111111-2222-3333-4444-555555555555/query`,
    `PUT /accounts/${ACCT}/workers/scripts/<name>`, `POST /accounts/${ACCT}/workers/scripts/<name>/subdomain`,
  ]), `Cloudflare calls in order:\n      ${seq.join('\n      ')}`);
  const bucket = api.find((c) => c.url.endsWith('/r2/buckets'));
  const tail = res.names.tail;
  ok(/^[0-9a-f]{6}$/.test(tail) && bucket.body.name === `lumen-videos-${tail}`, `bucket lumen-videos-${tail} (names like lumen setup’s)`);
  ok(api.find((c) => c.url.endsWith('/d1/database') && c.method === 'POST').body.name === `lumen-${tail}`, `database lumen-${tail}`);
  const q = api.find((c) => c.url.endsWith('/query')).body.sql;
  ok(!q.includes('--') && /CREATE TABLE IF NOT EXISTS videos/.test(q) && /CREATE TABLE IF NOT EXISTS tokens/.test(q) && /schema_version/.test(q), 'schema sent without comments: videos, tokens, meta');
  const put = api.find((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/'));
  ok(put.url.endsWith(`/workers/scripts/lumen-share-${tail}`) && put.body instanceof FormData && !put.headers['Content-Type'], 'worker upload is multipart/form-data (boundary set by fetch)');
  const meta = JSON.parse(await put.body.get('metadata').text());
  ok(meta.main_module === 'index.js' && meta.compatibility_date === COMPATIBILITY_DATE, `metadata: main_module index.js, compatibility_date ${meta.compatibility_date}`);
  const b = Object.fromEntries(meta.bindings.map((x) => [x.name, x]));
  ok(b.VIDEOS?.type === 'r2_bucket' && b.VIDEOS.bucket_name === `lumen-videos-${tail}`, 'binding VIDEOS → r2_bucket');
  ok(b.DB?.type === 'd1' && b.DB.id === '11111111-2222-3333-4444-555555555555', 'binding DB → d1 (database id)');
  ok(b.AI?.type === 'ai', 'binding AI → ai');
  ok(b.OWNER_NAME?.type === 'plain_text' && b.OWNER_NAME.text === 'Sam', 'OWNER_NAME plain_text');
  ok(b.ADMIN_TOKEN?.type === 'secret_text' && /^[0-9a-f]{48}$/.test(b.ADMIN_TOKEN.text), 'ADMIN_TOKEN secret_text, 48 random hex');
  ok(b.PASSWORD_SALT?.type === 'secret_text' && /^[0-9a-f]{32}$/.test(b.PASSWORD_SALT.text), 'PASSWORD_SALT secret_text, 32 random hex');
  const mod = put.body.get('index.js');
  ok(mod.type === 'application/javascript+module' && mod.name === 'index.js' && (await mod.text()) === sources['index.js'], 'index.js part: application/javascript+module, the bundled worker source');
  ok(put.body.get('player.js')?.type === 'application/javascript+module', 'player.js part (imported by index.js)');
  ok(JSON.stringify(api.find((c) => c.url.endsWith('/subdomain') && c.method === 'POST').body) === JSON.stringify({ enabled: true, previews_enabled: false }), 'workers.dev switched on (previews off)');
  const site = `https://lumen-share-${tail}.sam.workers.dev`;
  const info = cf.calls.find((c) => c.url === `${site}/api/info`);
  ok(info && info.headers.Authorization === `Bearer ${b.ADMIN_TOKEN.text}`, `waits for ${site}/api/info with the owner key`);
  const mint = cf.calls.find((c) => c.url === `${site}/api/tokens`);
  ok(mint && mint.method === 'POST' && mint.headers.Authorization === `Bearer ${b.ADMIN_TOKEN.text}` && mint.body.name === 'Lumen for Chrome', 'mints this browser’s device key with the owner key');
  ok(res.url === site && res.admin === b.ADMIN_TOKEN.text && /^lt_/.test(res.device.token), 'returns the site URL, the owner key (shown once) and the device key');
  ok(!cf.calls.some((c) => !c.url.startsWith(API) && c.headers.Authorization === `Bearer ${TOKEN}`), 'the Cloudflare token is never sent to the new site');
  ok(saved.length && saved.every((d) => !/[0-9a-f]{32,}/.test(JSON.stringify(d))), 'progress saved for retries holds names only (no secrets)');
  ok(progress.filter((p) => p.endsWith(':ok')).length === 8, `all 8 steps reported ok`);
}

// ---- no workers.dev subdomain yet --------------------------------------------------------------
console.log('Account without a workers.dev subdomain');
{
  const cf = fakeCloudflare({ [`GET /accounts/${ACCT}/workers/subdomain`]: () => cf.err(404, 10007, 'This account does not have a workers.dev subdomain') });
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  let asked = 0;
  const res = await s.run({ account: ACCT, sources, schemaSql, askSubdomain: async () => { asked++; return 'mysite'; } });
  const put = cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/workers/subdomain'));
  ok(asked === 1 && put && put.body.subdomain === 'mysite', 'asks for a name and creates <name>.workers.dev (PUT /workers/subdomain)');
  ok(res.url.endsWith('.mysite.workers.dev'), `site address uses it: ${res.url}`);
  let threw = null;
  try { await s.createSubdomain(ACCT, 'Bad Name!'); } catch (e) { threw = e; }
  ok(threw && /lowercase/.test(threw.message), 'rejects an invalid subdomain name before calling Cloudflare');
}

// ---- R2 not switched on, then retry ----------------------------------------------------------------
console.log('R2 not switched on (needs a card on file), then retry');
{
  let r2On = false;
  const cf = fakeCloudflare({ [`POST /accounts/${ACCT}/r2/buckets`]: (b) => (r2On ? cf.ok({ name: b.name }) : cf.err(403, 10042, 'Please enable R2 through the Cloudflare Dashboard.')) });
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  let done = {};
  let err = null;
  try { await s.run({ account: ACCT, sources, schemaSql, saveDone: (d) => { done = d; } }); } catch (e) { err = e; }
  ok(err && err.step === 'r2', `stops with step "r2" (${err?.message})`);
  ok(!cf.calls.some((c) => c.url.includes('/d1/') || c.url.includes('/workers/scripts/')), 'nothing else was created');
  r2On = true;
  const firstBucket = cf.calls.find((c) => c.url.endsWith('/r2/buckets')).body.name;
  const res = await s.run({ account: ACCT, sources, schemaSql, done: { tail: firstBucket.slice(-6) } });
  const buckets = cf.calls.filter((c) => c.url.endsWith('/r2/buckets')).map((c) => c.body.name);
  ok(buckets.length === 2 && buckets[0] === buckets[1] && res.names.bucket === buckets[0], 'retry reuses the same names');
  void done;
}

// ---- things that already exist (a re-run) -------------------------------------------------------------
console.log('Bucket and database already exist (re-run)');
{
  const cf = fakeCloudflare({
    [`POST /accounts/${ACCT}/r2/buckets`]: () => cf.err(409, 10004, 'The bucket you tried to create already exists, and you own it.'),
    [`POST /accounts/${ACCT}/d1/database`]: () => cf.err(400, 7502, 'A database with that name already exists'),
    'GET d1-list': (_b, calls) => cf.ok([{ uuid: '11111111-2222-3333-4444-555555555555', name: calls.find((c) => c.url.endsWith('/d1/database') && c.method === 'POST').body.name }]),
  });
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  const res = await s.run({ account: ACCT, sources, schemaSql });
  ok(res.names.dbId === '11111111-2222-3333-4444-555555555555' && cf.calls.some((c) => c.url.includes('/d1/database?name=')), 'existing bucket reused; existing database found by name');
}

// ---- Workers AI binding refused ---------------------------------------------------------------------------
console.log('Workers AI binding refused');
{
  let n = 0;
  const cf = fakeCloudflare({ 'PUT script': () => (++n === 1 ? cf.err(400, 10021, 'Binding AI: Workers AI is not available for this account') : cf.ok({ id: 'x' })) });
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  await s.run({ account: ACCT, sources, schemaSql });
  const puts = cf.calls.filter((c) => c.method === 'PUT' && c.url.includes('/workers/scripts/'));
  const second = JSON.parse(await puts[1].body.get('metadata').text());
  ok(puts.length === 2 && !second.bindings.some((x) => x.type === 'ai'), 'publishes again without the AI binding (titles/transcripts can come later)');
}

// ---- the new site takes a while to answer ---------------------------------------------------------------
console.log('A new workers.dev address that takes a while');
{
  let n = 0;
  const cf = fakeCloudflare({ 'GET site-info': () => (++n < 3 ? new TypeError('getaddrinfo ENOTFOUND') : { status: 200, body: { api: 2, owner: '' } }) });
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  const res = await s.run({ account: ACCT, sources, schemaSql });
  ok(n === 3 && res.device.token, 'keeps trying until the site answers, then connects');
  const s2 = new CloudflareSetup(TOKEN, { fetchImpl: fakeCloudflare({ 'GET site-info': () => new TypeError('nope') }).fetchImpl, sleep: noSleep });
  let err = null;
  try { await s2.waitForSite('https://x.y.workers.dev', 'k', { timeoutMs: 0 }); } catch (e) { err = e; }
  ok(err && err.step === 'wait' && /few minutes/.test(err.message), 'gives up with a plain “try again shortly”');
}

// ---- a bad token -----------------------------------------------------------------------------------------
console.log('A token without the right permissions');
{
  const cf = fakeCloudflare({
    'GET /user/tokens/verify': () => cf.err(401, 1000, 'Invalid API Token'),
    'GET /accounts?per_page=50': () => cf.err(403, 9109, 'Unauthorized to access requested resource'),
  });
  const s = new CloudflareSetup(TOKEN, { fetchImpl: cf.fetchImpl, sleep: noSleep });
  let err = null;
  try { await s.accounts(); } catch (e) { err = e; }
  ok(err && err.status === 403 && /Unauthorized/.test(err.message), `refused with Cloudflare’s reason (${err?.message})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
