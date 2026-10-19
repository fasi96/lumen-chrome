// "Set up my share site" without a terminal: creates the user's own Lumen share site on
// their own Cloudflare account through Cloudflare's API, with an API token they make
// (and can delete right after). The steps are the ones `lumen setup` runs with wrangler:
//
//   1. check the token, pick the account
//   2. the account's workers.dev subdomain (made if missing, with a name the user picks)
//   3. an R2 bucket for the videos (R2 must be switched on: a card on file, still free)
//   4. a D1 database + the schema (share/schema.sql)
//   5. the worker (share/src/index.js + player.js, bundled into this extension as text at
//      build time — uploaded to Cloudflare, never run here), with its bindings and two
//      fresh secrets: ADMIN_TOKEN (the owner key) and PASSWORD_SALT
//   6. switch on <worker>.<subdomain>.workers.dev, wait for it to answer
//   7. mint this browser's device key with the owner key; the API token is forgotten
//
// Plain logic with an injectable fetch, so test/cfsetup.test.mjs checks every request
// against a fake Cloudflare. Nothing here has been run against the real API yet (see
// README: "needs a real Cloudflare account").

export const API = 'https://api.cloudflare.com/client/v4';
export const COMPATIBILITY_DATE = '2026-09-01';     // same as share/wrangler.toml.example

// The token the user makes: a pre-filled "Create token" page (Cloudflare template URL).
export const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit', label: 'Account · Workers Scripts · Edit' },
  { key: 'workers_r2', type: 'edit', label: 'Account · Workers R2 Storage · Edit' },
  { key: 'd1', type: 'edit', label: 'Account · D1 · Edit' },
  { key: 'account_settings', type: 'read', label: 'Account · Account Settings · Read' },
];
export function tokenTemplateUrl(name = 'Lumen share site setup') {
  const keys = encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }))));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;
}
export const R2_DASHBOARD = 'https://dash.cloudflare.com/?to=/:account/r2/overview';

export class CfError extends Error {
  constructor(message, { status, codes = [], step } = {}) { super(message); this.status = status; this.codes = codes; this.step = step; }
}

// What Cloudflare's errors mean for this wizard (codes from wrangler's handling, and
// messages as a fallback: both need confirming on a real account).
export const isR2Disabled = (e) => e.codes?.includes(10042) || /enable R2|R2 (is )?not enabled|purchase R2/i.test(e.message);
export const isAlreadyExists = (e) => e.codes?.includes(10004) || e.codes?.includes(7502) || /already exists/i.test(e.message);
export const isNoSubdomain = (e) => e.codes?.includes(10007) || /does not have a workers\.dev subdomain|no subdomain/i.test(e.message);

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const tail = () => hex(3);

export class CloudflareSetup {
  // token: the user's API token (kept in memory only); fetchImpl: for tests.
  constructor(token, { fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async cf(method, path, body, { form } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    let data;
    if (form) data = form;                                  // multipart: fetch sets the boundary
    else if (body !== undefined) { data = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    let r;
    try {
      r = await this.fetch(API + path, { method, headers, body: data, credentials: 'omit' });
    } catch (e) {
      throw new CfError(`Can’t reach Cloudflare (${e.message})`);
    }
    let j = {};
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || j.success === false) {
      const errs = j.errors || [];
      throw new CfError(errs.map((x) => x.message).join('; ') || `Cloudflare said ${r.status}`, { status: r.status, codes: errs.map((x) => x.code) });
    }
    return j.result;
  }

  // 1. The token works, and which accounts it can use: [{id, name}].
  async accounts() {
    try {
      const v = await this.cf('GET', '/user/tokens/verify');
      if (v && v.status && v.status !== 'active') throw new CfError(`This token is ${v.status}`);
    } catch (e) {
      // Account-owned tokens can't use /user/tokens/verify; /accounts below still tells.
      if (e.status !== 401 && e.status !== 403 && !e.codes?.includes(1000)) throw e;
    }
    const list = await this.cf('GET', '/accounts?per_page=50');
    if (!list?.length) throw new CfError('This token can’t see any Cloudflare account. Make it with the permissions listed, for your account.');
    return list.map((a) => ({ id: a.id, name: a.name }));
  }

  // 2. "<sub>.workers.dev": the account's subdomain, or null if it has none yet.
  async subdomain(account) {
    try {
      return (await this.cf('GET', `/accounts/${account}/workers/subdomain`))?.subdomain || null;
    } catch (e) {
      if (isNoSubdomain(e) || e.status === 404) return null;
      throw e;
    }
  }

  async createSubdomain(account, name) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new CfError('Use lowercase letters, numbers and dashes for the subdomain.');
    return (await this.cf('PUT', `/accounts/${account}/workers/subdomain`, { subdomain: name }))?.subdomain || name;
  }

  // 3. The bucket (reused if it's already there).
  async bucket(account, name) {
    try {
      await this.cf('POST', `/accounts/${account}/r2/buckets`, { name });
    } catch (e) {
      if (isAlreadyExists(e)) return name;
      if (isR2Disabled(e)) throw new CfError('R2 isn’t switched on for this account yet.', { ...e, step: 'r2' });
      throw e;
    }
    return name;
  }

  // 4. The database (reused by name if it's already there) and its tables.
  async database(account, name) {
    try {
      return (await this.cf('POST', `/accounts/${account}/d1/database`, { name })).uuid;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      const found = await this.cf('GET', `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`);
      const db = (found || []).find((d) => d.name === name);
      if (!db) throw e;
      return db.uuid;
    }
  }

  async applySchema(account, dbId, schemaSql) {
    // Comments out, statements kept (the API runs ;-separated statements as a batch).
    const sql = schemaSql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\n{2,}/g, '\n').trim();
    await this.cf('POST', `/accounts/${account}/d1/database/${dbId}/query`, { sql });
  }

  // 5. The worker module with its bindings and secrets (one multipart upload).
  workerForm({ sources, bucket, dbId, owner, admin, salt, ai = true }) {
    const metadata = {
      main_module: 'index.js',
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        { type: 'r2_bucket', name: 'VIDEOS', bucket_name: bucket },
        { type: 'd1', name: 'DB', id: dbId },
        ...(ai ? [{ type: 'ai', name: 'AI' }] : []),
        { type: 'plain_text', name: 'OWNER_NAME', text: owner || '' },
        { type: 'secret_text', name: 'ADMIN_TOKEN', text: admin },
        { type: 'secret_text', name: 'PASSWORD_SALT', text: salt },
      ],
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    for (const [name, text] of Object.entries(sources)) {
      form.append(name, new Blob([text], { type: 'application/javascript+module' }), name);
    }
    return form;
  }

  async uploadWorker(account, script, opts) {
    try {
      await this.cf('PUT', `/accounts/${account}/workers/scripts/${script}`, undefined, { form: this.workerForm(opts) });
      return { ai: opts.ai !== false };
    } catch (e) {
      // Workers AI is optional (titles/transcripts later): if the account refuses the
      // binding, publish without it rather than fail the whole setup.
      if (opts.ai !== false && /\bai\b|workers ai/i.test(e.message)) {
        await this.cf('PUT', `/accounts/${account}/workers/scripts/${script}`, undefined, { form: this.workerForm({ ...opts, ai: false }) });
        return { ai: false };
      }
      throw e;
    }
  }

  // 6. On workers.dev.
  async enableWorkersDev(account, script) {
    await this.cf('POST', `/accounts/${account}/workers/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false });
  }

  // Waits until the new site answers its API with the owner key (a brand-new
  // workers.dev subdomain can take a few minutes to appear in DNS).
  async waitForSite(url, admin, { timeoutMs = 180000, every = 3000 } = {}) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await this.fetch(`${url}/api/info`, { headers: { Authorization: `Bearer ${admin}` }, credentials: 'omit' });
        if (r.ok) return await r.json();
        last = `answered ${r.status}`;
      } catch (e) { last = e.message; }
      await this.sleep(every);
    }
    throw new CfError(`Your share site didn’t answer yet (${last}). It can take a few minutes for a new workers.dev address; try again shortly.`, { step: 'wait' });
  }

  // 7. This browser's device key, made with the owner key.
  async mintDeviceKey(url, admin, name) {
    const r = await this.fetch(`${url}/api/tokens`, {
      method: 'POST', credentials: 'omit',
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new CfError(`Couldn’t make this browser’s key (${r.status})`, { step: 'device' });
    return r.json();
  }

  // The whole thing. progress(step, state, detail) drives the page; askSubdomain() is
  // called if the account has no workers.dev subdomain yet (returns the chosen name).
  // done: names already created on an earlier try (so a retry reuses them).
  async run({ account, sources, schemaSql, owner = '', deviceName = 'Lumen for Chrome', done = {}, progress = () => {}, askSubdomain, saveDone = () => {} }) {
    const t = done.tail || tail();
    const names = { tail: t, script: done.script || `lumen-share-${t}`, bucket: done.bucket || `lumen-videos-${t}`, db: done.db || `lumen-${t}` };
    const step = async (id, fn) => {
      progress(id, 'run');
      try {
        const out = await fn();
        progress(id, 'ok', out);
        return out;
      } catch (e) {
        progress(id, 'fail', e.message);
        e.step ??= id;
        throw e;
      }
    };
    const sub = await step('subdomain', async () => {
      const s = await this.subdomain(account);
      if (s) return s;
      if (!askSubdomain) throw new CfError('This account has no workers.dev subdomain yet.', { step: 'subdomain' });
      return this.createSubdomain(account, await askSubdomain());
    });
    await step('bucket', () => this.bucket(account, names.bucket));
    saveDone({ ...names });
    const dbId = await step('database', () => (done.dbId ? done.dbId : this.database(account, names.db)));
    saveDone({ ...names, dbId });
    await step('schema', () => this.applySchema(account, dbId, schemaSql));
    // Fresh secrets on every try: nobody has the site yet, so nothing depends on them.
    // They go straight to Cloudflare; only the owner key is shown once at the end.
    const admin = hex(24);
    const salt = hex(16);
    await step('worker', () => this.uploadWorker(account, names.script, { sources, bucket: names.bucket, dbId, owner, admin, salt }));
    saveDone({ ...names, dbId, uploaded: true });
    await step('workersdev', () => this.enableWorkersDev(account, names.script));
    const url = `https://${names.script}.${sub}.workers.dev`;
    const info = await step('wait', () => this.waitForSite(url, admin));
    const key = await step('device', () => this.mintDeviceKey(url, admin, deviceName));
    return { url, admin, device: key, owner: info.owner || owner, names: { ...names, dbId } };
  }
}
