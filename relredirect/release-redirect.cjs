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
// Never worse than GitHub: until the first byte of an answer reaches the
// caller, any trouble sends the same request to GitHub instead, so the caller
// sees GitHub's answer and nothing else. That covers the cache not accepting
// the connection in time, not having the file (it answers 302; the caller
// never sees it), answering anything but 200/206, or not answering in time.
// Except for a plain miss, the cache is then skipped for the rest of the
// process. A download the cache drops halfway is a failed attempt the caller
// sees (tool-cache retries it, now from GitHub).
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
      label: `${name} ${tag}/${file}`,
      path: `/releases/v1/${owner}/${repo}/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
    };
  }

  const hasAuth = headers => !!headers && Object.keys(headers).some(k => k.toLowerCase() === 'authorization');

  // ─── http.request / https.request ─────────────────────────────────────────
  //
  // The caller gets a real ClientRequest for its GitHub URL, created by the
  // original function. Only its connection differs (createConnection): a
  // stream that holds the request until it is complete, sends it to the cache
  // with the cache's path in the request line, and looks at the status line.
  // 200/206: the cache's answer flows to the caller. Anything else, or no
  // answer in time: the request goes to GitHub, byte for byte as the caller
  // wrote it, and GitHub's answer flows to the caller.

  function relay(o, asset, target) {
    const { Duplex } = require('stream');
    let request = Buffer.alloc(0);
    let up = null;          // the connection whose answer the caller gets
    let started = false;
    let timeoutMs = 0;
    const d = new Duplex({
      write(chunk, encoding, cb) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        if (up) { up.write(b, cb); return; }
        request = Buffer.concat([request, b]);
        cb();
        if (!started && request.indexOf('\r\n\r\n') !== -1) { started = true; viaCache(); }
      },
      read() { if (up && up.isPaused()) up.resume(); },
      final(cb) { if (up) up.end(); cb(); },
      destroy(err, cb) { if (up) up.destroy(); cb(err); },
    });
    d.setTimeout = (ms, cb) => { timeoutMs = ms; if (cb) d.once('timeout', cb); if (up) up.setTimeout(ms); return d; };
    d.setNoDelay = () => d;
    d.setKeepAlive = () => d;
    d.ref = () => d;
    d.unref = () => d;

    function use(sock, fromCache, head) {
      up = sock;
      let ended = false;
      sock.on('data', c => { if (!d.push(c)) sock.pause(); });
      sock.on('end', () => { ended = true; d.push(null); });
      sock.on('timeout', () => d.emit('timeout'));
      sock.on('error', e => { if (fromCache) giveUp('download dropped'); d.destroy(e); });
      sock.on('close', () => { if (!ended && !d.destroyed) { if (fromCache) giveUp('download dropped'); d.destroy(new Error('socket hang up')); } });
      if (timeoutMs) sock.setTimeout(timeoutMs);
      if (head) d.push(head);
    }

    function toGithub() {
      let sock;
      try {
        sock = target.protocol === 'https:'
          ? tls.connect({
              host: target.hostname, port: Number(target.port) || 443, servername: o.servername || target.hostname, ALPNProtocols: ['http/1.1'],
              ca: o.ca, cert: o.cert, key: o.key, pfx: o.pfx, passphrase: o.passphrase,
              rejectUnauthorized: o.rejectUnauthorized, lookup: o.lookup, family: o.family,
            })
          : net.connect({ host: target.hostname, port: Number(target.port) || 80, lookup: o.lookup, family: o.family });
      } catch (e) { d.destroy(e); return; }
      use(sock, false, null);
      sock.write(request);
    }

    function viaCache() {
      const first = request.indexOf('\r\n');
      const line = request.toString('latin1', 0, first);
      if (off || line !== `GET ${target.path} HTTP/1.1`) { toGithub(); return; }
      let settled = false;
      let answer = Buffer.alloc(0);
      const c = net.connect({ host: cacheHost, port: cachePort });
      let timer = setTimeout(() => fail('did not accept the connection in time'), connectMs);
      const fail = (why, quiet) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        c.removeAllListeners('data');
        c.destroy();
        if (!quiet) giveUp(`cache ${why}`);
        toGithub();
      };
      c.once('connect', () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail('did not answer in time'), responseMs);
        c.write(Buffer.concat([Buffer.from(`GET ${asset.path} HTTP/1.1`, 'latin1'), request.subarray(first)]));
      });
      c.on('data', chunk => {
        if (settled) return;
        answer = Buffer.concat([answer, chunk]);
        const eol = answer.indexOf('\r\n');
        if (eol === -1 && answer.length < 64) return;
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(answer.toString('latin1', 0, eol === -1 ? answer.length : eol));
        const st = m ? Number(m[1]) : 0;
        if (st === 200 || st === 206) {
          settled = true;
          clearTimeout(timer);
          c.removeAllListeners('data');
          c.removeAllListeners('error');
          c.removeAllListeners('close');
          say(`${asset.label} from the cache`);
          use(c, true, answer);
        } else {
          fail(`answered ${st || 'something else'}`, st >= 300 && st < 400);   // 3xx: not stored yet, a plain miss
        }
      });
      c.once('error', e => fail(e && e.code ? e.code : 'unreachable'));
      c.once('close', () => fail('closed the connection'));
    }
    return d;
  }

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
    const path = opts.path || '/';
    const asset = assetOf(protocol, hostname, port, path);
    if (!asset) return null;
    const target = { protocol, hostname, port, path };
    const reqOpts = Object.assign({}, opts, { agent: undefined, createConnection: o => relay(o, asset, target) });
    return cb ? original.call(mod, reqOpts, cb) : original.call(mod, reqOpts);
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
      if (!asset) return originalFetch.call(globalThis, input, init);

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
