'use strict';
// Release downloads made by JavaScript actions, served by the release cache
// (docs/action-cache.md, "Release downloads from JavaScript actions").
//
// Loaded with `node --require` by the wrapper run-job.actions.sh puts in
// place of the runner's own Node (externals/node*/bin/node), which runs
// JavaScript actions and nothing else: `run:` steps and the Node a job sets
// up are untouched.
//
// It changes one kind of request: a GET of
//   https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
// for a repository on the cache's list, with no Authorization header and no
// credentials in the URL. Such a request goes to
//   <cache>/releases/v1/<owner>/<repo>/<tag>/<file>
// and everything else in the process is left exactly as it was. Both ways an
// action can download are covered: the http/https modules (@actions/tool-cache,
// @actions/http-client, most libraries) and the global fetch().
//
// Never worse than GitHub:
// - the cache does not accept the connection in time: the same request goes
//   to GitHub on a fresh connection, and the cache is skipped for the rest of
//   the process;
// - the cache does not have the file: it answers 302 to the GitHub URL, the
//   client follows it, and that request goes to GitHub untouched (fetch():
//   the original request is made instead);
// - the cache answers anything but 200/206/3xx, never answers, or drops a
//   download: the cache is skipped for the rest of the process (what the
//   caller saw is a failed attempt; tool-cache retries it, now from GitHub).
// The cache fetched the file from GitHub anonymously over TLS, so the bytes
// are the public asset. VULCAN_RELEASE_REDIRECT=0 in a step's env turns this
// off for that step (the wrapper then starts Node without it).
//
// Config: the JSON file in VULCAN_RELEASE_REDIRECT_CONFIG,
//   { "url": "http://<cache>", "repos": ["owner/repo", ...],
//     "origin"?: "https://github.com", "connectMs"?: 1500, "responseMs"?: 15000 }
// Plain CommonJS for every Node the runner ships; no dependencies.
(function main() {
  const env = process.env;
  const cfgPath = env.VULCAN_RELEASE_REDIRECT_CONFIG;
  // Not for child processes: they are the action's own business.
  delete env.VULCAN_RELEASE_REDIRECT_CONFIG;
  if (!cfgPath || env.VULCAN_RELEASE_REDIRECT === '0') return;
  // A job behind a proxy reaches GitHub through it; the fallback below would not.
  if (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return;

  let cfg, base, origin;
  try {
    cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
    base = new URL(cfg.url);
    origin = new URL(cfg.origin || 'https://github.com');
  } catch (e) { return; }
  if (base.protocol !== 'http:' || !Array.isArray(cfg.repos)) return;
  const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
  const repos = new Set(cfg.repos.filter(r => typeof r === 'string' && FULL_NAME.test(r)).map(r => r.toLowerCase()));
  if (!repos.size) return;
  const connectMs = Number(cfg.connectMs) > 0 ? Number(cfg.connectMs) : 1500;
  const responseMs = Number(cfg.responseMs) > 0 ? Number(cfg.responseMs) : 15000;
  const cacheHost = base.hostname.replace(/^\[|\]$/g, '');
  const cachePort = Number(base.port) || 80;
  const cacheBase = base.href.replace(/\/+$/, '');

  // The same rules as the cache's (cache/src/releases.ts): anything else it refuses.
  const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
  const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
  const http = require('http');
  const https = require('https');
  const net = require('net');
  const tls = require('tls');

  let off = false;               // the cache misbehaved: GitHub for the rest of the process
  const direct = new Set();      // assets the cache just redirected: their next request goes to GitHub

  const say = msg => { try { process.stderr.write(`vulcan release cache: ${msg}\n`); } catch (e) { /* closed */ } };
  const giveUp = why => { if (!off) say(`${why}; downloading from GitHub`); off = true; };

  /** The asset a URL names, or null when the URL is not one to redirect. */
  function assetOf(protocol, hostname, port, path) {
    if (protocol !== origin.protocol || hostname.toLowerCase() !== origin.hostname) return null;
    if (String(port || (protocol === 'https:' ? 443 : 80)) !== String(origin.port || (origin.protocol === 'https:' ? 443 : 80))) return null;
    const m = /^\/([^/?#]+)\/([^/?#]+)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/.exec(path);
    if (!m) return null;
    let owner, repo, tag, file;
    try { [owner, repo, tag, file] = m.slice(1, 5).map(decodeURIComponent); } catch (e) { return null; }
    const name = `${owner}/${repo}`;
    if (!FULL_NAME.test(name) || !repos.has(name.toLowerCase())) return null;
    if (!TAG.test(tag) || !FILE.test(file) || tag.includes('..') || file.includes('..')) return null;
    return {
      key: `${name.toLowerCase()}/${tag}/${file}`,
      label: `${name} ${tag}/${file}`,
      path: `/releases/v1/${owner}/${repo}/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
    };
  }

  const hasAuth = headers => !!headers && Object.keys(headers).some(k => k.toLowerCase() === 'authorization');

  // ─── http.request / https.request ─────────────────────────────────────────
  //
  // The caller gets a real ClientRequest for its GitHub URL, created by the
  // original function. Only its connection differs: createConnection dials the
  // cache and rewrites the request line to the cache's path; when the cache
  // does not accept in time, it dials GitHub instead and the request goes out
  // as the caller wrote it.

  function intercept(mod, original, args) {
    let opts;
    let cb;
    const [a, b, c] = args;
    if (typeof a === 'string' || a instanceof URL) {
      const u = new URL(String(a));
      const fromUrl = { protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: `${u.pathname}${u.search}`, auth: u.username || u.password ? 'x' : undefined };
      if (typeof b === 'function') { opts = fromUrl; cb = b; } else { opts = Object.assign(fromUrl, b || {}); cb = c; }
    } else if (a && typeof a === 'object') {
      opts = Object.assign({}, a);
      cb = b;
    } else return null;
    if (typeof cb !== 'function' && cb !== undefined) return null;
    if (String(opts.method || 'GET').toUpperCase() !== 'GET') return null;
    if (opts.auth || opts.socketPath || opts.createConnection || Array.isArray(opts.headers) || hasAuth(opts.headers)) return null;
    const protocol = opts.protocol || (mod === https ? 'https:' : 'http:');
    if ((mod === https) !== (protocol === 'https:')) return null;
    const hostname = opts.hostname || String(opts.host || 'localhost').replace(/:\d+$/, '');
    const port = opts.port || opts.defaultPort;
    const asset = assetOf(protocol, hostname, port, opts.path || '/');
    if (!asset) return null;
    if (direct.delete(asset.key)) return null;

    const firstLine = `GET ${opts.path} HTTP/1.1\r\n`;
    const cacheLine = `GET ${asset.path} HTTP/1.1\r\n`;
    let viaCache = false;
    let answered = false;
    let req = null;
    let responseTimer = null;

    function createConnection(o, done) {
      let settled = false;
      const s = net.connect({ host: cacheHost, port: cachePort });
      const timer = setTimeout(() => toGithub('did not accept the connection in time'), connectMs);
      s.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        viaCache = true;
        const write = s.write;
        s.write = function (chunk, encoding, callback) {
          s.write = write;
          const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1') : '';
          if (!text.startsWith(firstLine)) {
            // Not the request this connection was made for: send nothing.
            giveUp('unexpected request');
            s.destroy(new Error('vulcan release cache: unexpected request'));
            return false;
          }
          const out = cacheLine + text.slice(firstLine.length);
          return write.call(this, typeof chunk === 'string' ? out : Buffer.from(out, 'latin1'), typeof chunk === 'string' ? 'latin1' : encoding, callback);
        };
        responseTimer = setTimeout(() => {
          if (answered) return;
          giveUp('no answer');
          if (req) req.destroy(new Error('vulcan release cache: no answer'));
        }, responseMs);
        if (responseTimer.unref) responseTimer.unref();
        done(null, s);
      });
      s.once('error', e => toGithub(e && e.code ? e.code : 'unreachable'));
      function toGithub(why) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.destroy();
        giveUp(`cache ${why}`);
        let sock;
        try {
          sock = protocol === 'https:'
            ? tls.connect({
                host: hostname, port: Number(port) || 443, servername: o.servername || hostname, ALPNProtocols: ['http/1.1'],
                ca: o.ca, cert: o.cert, key: o.key, pfx: o.pfx, passphrase: o.passphrase,
                rejectUnauthorized: o.rejectUnauthorized, lookup: o.lookup, family: o.family,
              })
            : net.connect({ host: hostname, port: Number(port) || 80, lookup: o.lookup, family: o.family });
        } catch (e) { done(e); return; }
        done(null, sock);
      }
    }

    const reqOpts = Object.assign({}, opts, { agent: undefined, createConnection });
    req = cb ? original.call(mod, reqOpts, cb) : original.call(mod, reqOpts);
    req.prependListener('response', res => {
      answered = true;
      clearTimeout(responseTimer);
      if (!viaCache) return;
      const st = res.statusCode;
      if (st === 200 || st === 206) {
        say(`${asset.label} from the cache`);
        res.once('aborted', () => giveUp('download dropped'));
        res.once('error', () => giveUp('download dropped'));
      } else if (st >= 300 && st < 400) {
        direct.add(asset.key);   // not stored yet: the redirect to GitHub goes out untouched
      } else {
        giveUp(`answered ${st}`);
      }
    });
    req.once('close', () => clearTimeout(responseTimer));
    return req;
  }

  function wrap(mod, original) {
    return function (...args) {
      if (!off) {
        try {
          const r = intercept(mod, original, args);
          if (r) return r;
        } catch (e) { /* not ours: the original below */ }
      }
      return original.apply(this, args);
    };
  }
  for (const mod of [http, https]) {
    const request = wrap(mod, mod.request);
    mod.request = request;
    mod.get = function get(...args) { const r = request.apply(this, args); r.end(); return r; };
  }
  try { require('module').syncBuiltinESMExports(); } catch (e) { /* old Node: CommonJS callers only */ }

  // ─── fetch() ──────────────────────────────────────────────────────────────

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = async function fetch(input, init) {
      let asset = null;
      let range = null;
      try {
        if (!off) {
          const isReq = typeof Request === 'function' && input instanceof Request;
          const u = new URL(isReq ? input.url : String(input));
          const method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
          const headers = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
          if (method === 'GET' && !headers.has('authorization') && !u.username && !u.password && !u.search && !(init && init.body)) {
            asset = assetOf(u.protocol, u.hostname, u.port, u.pathname);
            range = headers.get('range');
          }
        }
      } catch (e) { asset = null; }
      if (!asset || direct.delete(asset.key)) return originalFetch.call(globalThis, input, init);

      const ac = new AbortController();
      const signal = init && init.signal;
      if (signal) {
        if (signal.aborted) return originalFetch.call(globalThis, input, init);
        signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
      }
      const timer = setTimeout(() => ac.abort(new Error('timeout')), Math.min(responseMs, connectMs * 4));
      try {
        const r = await originalFetch.call(globalThis, cacheBase + asset.path, { headers: range ? { range } : {}, redirect: 'manual', signal: ac.signal });
        clearTimeout(timer);
        if (r.status === 200 || (r.status === 206 && range)) { say(`${asset.label} from the cache`); return r; }
        if (!(r.status >= 300 && r.status < 400)) giveUp(`answered ${r.status}`);
        try { if (r.body) await r.body.cancel(); } catch (e) { /* drained */ }
      } catch (e) {
        clearTimeout(timer);
        if (signal && signal.aborted) throw e;
        giveUp('unreachable');
      }
      return originalFetch.call(globalThis, input, init);
    };
  }
})();
