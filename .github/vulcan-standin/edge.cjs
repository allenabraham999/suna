'use strict';
// Stand-in for vulcan-edge + vcache's /eslint/v1: files in a directory that
// the Actions cache carries from job to job. Loopback only.
const http = require('http'), fs = require('fs'), path = require('path');
const [dir, port] = process.argv.slice(2);
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  const m = /^\/eslint\/v1\/([0-9a-f]{24,64})$/.exec(req.url);
  if (!m) return res.writeHead(404).end();
  const f = path.join(dir, m[1]);
  console.log(new Date().toISOString(), req.method, m[1]);
  if (req.method === 'GET') return fs.readFile(f, (e, b) => (e ? res.writeHead(404).end('miss') : res.writeHead(200, { 'content-length': b.length }).end(b)));
  if (req.method === 'PUT') {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => { fs.writeFileSync(f + '.part', Buffer.concat(c)); fs.renameSync(f + '.part', f); res.writeHead(204).end(); });
    return;
  }
  res.writeHead(405).end();
}).listen(Number(port), '127.0.0.1');
