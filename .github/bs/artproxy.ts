// Experimental pull-through cache for immutable artifacts (npm tarballs,
// GitHub release assets). In-VM stand-in for a host-local cache.
//   GET /npm/<path> -> https://registry.npmjs.org/<path>  (tarballs cached; metadata passed through, tarball URLs rewritten)
//   GET /gh/<owner>/<repo>/releases/download/<tag>/<file> -> https://github.com/... (cached)
import { mkdirSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 7471);
const HOST = process.env.HOST ?? '127.0.0.1';
const DIR = process.env.DIR ?? '/tmp/ap';
const SELF = process.env.SELF ?? `http://${HOST}:${PORT}`;
mkdirSync(join(DIR, 'tmp'), { recursive: true });
const inflight = new Map<string, Promise<string | null>>();
let hits = 0, misses = 0, pass = 0, bytesServed = 0;

function keyPath(k: string) {
  const h = createHash('sha256').update(k).digest('hex');
  mkdirSync(join(DIR, h.slice(0, 2)), { recursive: true });
  return join(DIR, h.slice(0, 2), h);
}

async function fill(upstream: string, dest: string): Promise<string | null> {
  const tmp = join(DIR, 'tmp', `${process.pid}-${Math.random().toString(36).slice(2)}`);
  const r = await fetch(upstream, { redirect: 'follow', headers: { 'user-agent': 'artproxy-experiment' } });
  if (r.status !== 200 || !r.body) { await r.body?.cancel(); return null; }
  await Bun.write(tmp, r);
  const want = r.headers.get('content-length');
  if (want && Number(want) !== statSync(tmp).size) { unlinkSync(tmp); return null; }
  renameSync(tmp, dest);
  return dest;
}

async function cached(key: string, upstream: string): Promise<Response> {
  const p = keyPath(key);
  if (existsSync(p)) {
    hits++; bytesServed += statSync(p).size;
    return new Response(Bun.file(p), { headers: { 'x-artproxy': 'hit', 'content-type': 'application/octet-stream' } });
  }
  let f = inflight.get(key);
  if (!f) {
    misses++;
    f = fill(upstream, p).catch(e => { console.error('fill', upstream, String(e)); return null; }).finally(() => inflight.delete(key));
    inflight.set(key, f);
  }
  const got = await f;
  if (!got) return Response.redirect(upstream, 302);
  bytesServed += statSync(got).size;
  return new Response(Bun.file(got), { headers: { 'x-artproxy': 'miss', 'content-type': 'application/octet-stream' } });
}

Bun.serve({
  hostname: HOST, port: PORT, idleTimeout: 120,
  async fetch(req) {
    const u = new URL(req.url);
    const p = u.pathname;
    if (p === '/stats') return Response.json({ hits, misses, pass, bytesServed, inflight: inflight.size });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method', { status: 405 });
    if (p.startsWith('/npm/')) {
      const up = `https://registry.npmjs.org/${p.slice(5)}${u.search}`;
      if (/\/-\/[^/]+\.tgz$/.test(p)) return cached('npm:' + p, up);
      pass++;
      const r = await fetch(up, { headers: { accept: req.headers.get('accept') ?? 'application/json', 'accept-encoding': 'identity' } });
      const body = (await r.text()).replaceAll('https://registry.npmjs.org/', `${SELF}/npm/`);
      return new Response(body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
    }
    const m = /^\/gh\/([^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+)$/.exec(p);
    if (m) return cached('gh:' + m[1], `https://github.com/${m[1]}`);
    return new Response('not found', { status: 404 });
  },
});
console.log(`artproxy on ${HOST}:${PORT} dir ${DIR}`);
