'use strict';
// ESLint result cache for repositories that opt in (docs/eslint-cache.md).
//
// Loaded into every Node process of the job with NODE_OPTIONS=--require (the
// runner's .env, written by run-job.eslint.sh). In a process that never loads
// ESLint it installs one Module._load hook and nothing else. When ESLint's
// Node API is constructed without a cache of its own, this turns ESLint's
// result cache on (strategy "content": a checkout resets mtimes), in a local
// file first fetched from the in-VM edge and sent back after the lint.
//
// The cache must never change a job's result, above all never turn a failing
// lint green. A file's cached result is used only when every input it
// depends on is known and is part of what the cache checks:
//   - The cache FILE is chosen by a hash of every result-affecting option
//     (ESLint's own cache ignores --quiet's rule filter), the cwd, every
//     lockfile, package.json and tsconfig.json from the cwd up, the config
//     file's bytes, ESLint's version and the Node version.
//   - Each entry also records a hash of the code its rules run: the source
//     of every enabled rule, parser and processor, plus the contents of every
//     module this process loaded from outside node_modules (local plugins,
//     their helpers, workspace packages: whatever no lockfile covers), seen
//     through require.cache and a module.registerHooks load hook. A Node
//     without registerHooks (< 22.15 / 23.5) cannot see ESM imports, so the
//     cache stays off there.
//   - Rules are allowlisted (mode "safe", the default): ESLint's core rules
//     and the rules of known single-file plugins. A rule of any other plugin,
//     a --rulesdir rule, or a type-aware config (parserOptions.project /
//     projectService / programs) is never served from the cache and never
//     stored: ESLint's cache does not track dependencies between files. A
//     local rule is allowed only when its module and everything it imports
//     are local files that read nothing (no fs, no process.env, no packages
//     beyond a few pure AST helpers). @next/next/no-html-link-for-pages is
//     keyed on the route listing it reads.
//   - Any error anywhere, an edge that does not answer, a corrupt download:
//     ESLint runs exactly as it would without this file.
//   - VULCAN_ESLINT_CACHE=0 in a step's env turns it off for that step.
//
// Environment:
//   VULCAN_ESLINT_CACHE        safe | all ("all" also caches unknown plugins'
//                              and type-aware files, with ESLint's documented
//                              caveat); anything else: off
//   VULCAN_ESLINT_CACHE_URL    http://127.0.0.1:7480/eslint/v1 (the edge; it adds the VM token)
//   VULCAN_ESLINT_CACHE_DIR    local directory for cache files (default: <tmpdir>/vulcan-eslint-cache)
//   VULCAN_ESLINT_CACHE_DEBUG  1: one line per decision on stderr
// Plain CommonJS; no dependencies.
(function main() {
  const env = process.env;
  const mode = env.VULCAN_ESLINT_CACHE;
  if (mode !== 'safe' && mode !== 'all') return;
  const base = (env.VULCAN_ESLINT_CACHE_URL || '').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(base + '/')) return;

  // Only what the hook needs, up front; the rest when ESLint shows up.
  const Module = require('module');
  const path = require('path');
  const fs = require('fs');
  let crypto = null;

  const MAX_BYTES = 8 * 1024 * 1024;
  const GET_BUDGET_MS = 4000;      // all downloads of this process together
  const PUT_BUDGET_MS = 4000;      // all uploads of this process together
  const debug = env.VULCAN_ESLINT_CACHE_DEBUG === '1';
  const say = msg => { if (debug) { try { process.stderr.write(`vulcan eslint cache: ${msg}\n`); } catch (e) { /* closed */ } } };
  const sha = (...parts) => {
    crypto = crypto || require('crypto');
    const h = crypto.createHash('sha256');
    for (const p of parts) h.update(typeof p === 'string' || Buffer.isBuffer(p) ? p : String(p)).update('\0');
    return h.digest('hex');
  };
  let dirMemo = null;
  // Absolute: ESLint resolves its cache location against its cwd, and the
  // patched LintResultCache recognises this file's caches by that path.
  const cacheDir = () => (dirMemo = dirMemo || path.resolve(env.VULCAN_ESLINT_CACHE_DIR || path.join(require('os').tmpdir(), 'vulcan-eslint-cache')));

  const ESLINT_CLASS = /[\\/]eslint\d*[\\/]lib[\\/]eslint[\\/](flat-)?eslint\.js$/;
  const RESULT_CACHE = /[\\/]eslint\d*[\\/]lib[\\/](.+[\\/])?lint-result-cache\.js$/;
  const pkgRoot = file => file.replace(/[\\/]lib[\\/].*$/, '');
  const inNodeModules = f => /[\\/]node_modules[\\/]/.test(f);

  // ─── modules loaded from outside node_modules ────────────────────────────

  const loaded = new Set();   // file paths seen by the load hook
  let hooks = false;
  function watchModules() {
    if (hooks) return true;
    if (typeof Module.registerHooks !== 'function') return false;
    const { fileURLToPath } = require('url');
    Module.registerHooks({
      load(url, context, next) {
        try { if (url.startsWith('file:') && !url.includes('/node_modules/')) loaded.add(fileURLToPath(url.replace(/[?#].*$/, ''))); } catch (e) { /* not a path */ }
        return next(url, context);
      },
    });
    hooks = true;
    return true;
  }
  const realOf = f => { try { return fs.realpathSync(f); } catch (e) { return null; } };
  let localMemo = { n: -1, files: [], hash: '', sources: new Map() };
  /** Every loaded module whose real path is outside node_modules, with its contents. */
  function localModules() {
    const names = new Set(loaded);
    for (const k of Object.keys(Module._cache || {})) names.add(k);
    if (names.size === localMemo.n) return localMemo;
    const files = [];
    for (const f of names) {
      if (!path.isAbsolute(f) || f === __filename) continue;
      const r = realOf(f);
      if (r && !inNodeModules(r) && !files.includes(r)) files.push(r);
    }
    files.sort();
    const sources = new Map();
    const parts = [];
    for (const f of files) {
      let b;
      try { b = fs.readFileSync(f); } catch (e) { throw new Error(`cannot read ${f}`); }
      sources.set(f, b.toString('utf8'));
      parts.push(f, b);
    }
    localMemo = { n: names.size, files, hash: sha(...parts), sources };
    return localMemo;
  }
  const src = f => (typeof f === 'function' ? Function.prototype.toString.call(f) : '');
  /** The local module that defines this function, or null (it comes from node_modules). */
  function definedIn(fn) {
    const s = src(fn);
    if (s.length < 12) return null;
    for (const [f, text] of localModules().sources) if (text.includes(s)) return f;
    return null;
  }

  // A local rule's module graph may import only local files and these.
  const PURE_IMPORTS = new Set(['@typescript-eslint/utils', '@typescript-eslint/types', 'eslint-visitor-keys', 'esquery', 'estraverse',
    'esutils', '@eslint-community/eslint-utils', 'eslint-utils', 'path', 'node:path']);
  const READS = /\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|lstatSync|realpathSync|openSync|globSync|createRequire|execSync|spawnSync)\b|process\s*\.\s*(?:env|cwd|argv)\b|require\s*\.\s*resolve\b|import\s*\.\s*meta\s*\.\s*(?:resolve|dirname|filename)\b|\brequire\s*\(\s*[^'"\s)]|\bimport\s*\(\s*[^'"\s)]/;
  const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  function resolveLocal(from, spec) {
    const p = path.resolve(path.dirname(from), spec);
    for (const c of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, path.join(p, 'index.js'), path.join(p, 'index.mjs'), path.join(p, 'index.cjs')]) {
      try { if (fs.statSync(c).isFile()) return realOf(c); } catch (e) { /* next */ }
    }
    return null;
  }
  const pureMemo = new Map();
  /** Why a local module (and what it imports) may read something the cache does not see, or null. */
  function impureReason(file, seen = new Set()) {
    if (pureMemo.has(file)) return pureMemo.get(file);
    if (seen.has(file)) return null;
    seen.add(file);
    let why = null;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
    if (text === null) why = `cannot read ${file}`;
    else if (READS.test(text)) why = `${path.basename(file)} reads files, the environment or loads modules dynamically`;
    else {
      for (const m of text.matchAll(SPEC)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const r = resolveLocal(file, spec);
          if (!r || inNodeModules(r)) { why = `${path.basename(file)} imports ${spec}`; break; }
          const sub = impureReason(r, seen);
          if (sub) { why = sub; break; }
        } else if (!PURE_IMPORTS.has(spec)) { why = `${path.basename(file)} imports ${spec}`; break; }
      }
    }
    pureMemo.set(file, why);
    return why;
  }

  // ─── which rules may be cached ───────────────────────────────────────────

  // Plugins whose rules read only the file being linted (plus settings and
  // the installed packages, both in the key): prefix -> the rules of theirs
  // that do read other files (never cached).
  const PLUGINS = {
    'react/': [], 'react-hooks/': [], 'jsx-a11y/': [], 'react-refresh/': [], '@stylistic/': [], '@stylistic/js/': [], '@stylistic/ts/': [],
    '@stylistic/jsx/': [], '@typescript-eslint/': [], 'promise/': [], 'simple-import-sort/': [], 'unused-imports/': [], 'regexp/': [],
    'sonarjs/': [], 'security/': [], 'perfectionist/': [], 'eslint-comments/': [], '@eslint-community/eslint-comments/': [],
    'jest/': [], 'vitest/': [], 'testing-library/': [], 'jsdoc/': [], 'es-x/': [], 'no-only-tests/': [],
    '@next/next/': [],
    'unicorn/': ['no-unnecessary-polyfills', 'expiring-todo-comments', 'prefer-node-protocol'],
  };
  // eslint-plugin-import / import-x / n: only these single-file rules.
  const ONLY = {
    'import/': ['first', 'newline-after-import', 'exports-last', 'no-anonymous-default-export', 'no-default-export', 'no-named-export',
      'prefer-default-export', 'no-namespace', 'no-mutable-exports', 'no-amd', 'no-commonjs', 'unambiguous', 'no-empty-named-blocks',
      'group-exports', 'no-webpack-loader-syntax', 'dynamic-import-chunkname', 'max-dependencies', 'no-dynamic-require', 'no-absolute-path',
      'consistent-type-specifier-style', 'no-named-default'],
    'n/': ['callback-return', 'exports-style', 'global-require', 'handle-callback-err', 'no-callback-literal', 'no-exports-assign',
      'no-mixed-requires', 'no-new-require', 'no-path-concat', 'no-process-env', 'no-process-exit', 'no-sync', 'process-exit-as-throw',
      'no-restricted-import', 'no-restricted-require', 'prefer-global/buffer', 'prefer-global/console', 'prefer-global/process',
      'prefer-global/text-decoder', 'prefer-global/text-encoder', 'prefer-global/url', 'prefer-global/url-search-params',
      'prefer-promises/dns', 'prefer-promises/fs'],
  };
  ONLY['import-x/'] = ONLY['import/'];
  ONLY['node/'] = ONLY['n/'];
  const PAGES_RULE = '@next/next/no-html-link-for-pages';

  /** 'pure' | 'local' (must pass the module check) | 'unknown' for a rule name. */
  function knownPure(name, builtins) {
    if (!name.includes('/')) return builtins && builtins.has(name) ? 'pure' : 'unknown';
    for (const [p, rules] of Object.entries(ONLY)) if (name.startsWith(p)) return rules.includes(name.slice(p.length)) ? 'pure' : 'unknown';
    const prefix = Object.keys(PLUGINS).filter(p => name.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (prefix) return PLUGINS[prefix].includes(name.slice(prefix.length)) ? 'unknown' : 'pure';
    return 'local';
  }

  const sevOf = v => (Array.isArray(v) ? v[0] : v);
  const enabled = v => { const s = sevOf(v); return s !== 0 && s !== 'off' && s !== '0' && s !== undefined; };
  const parserOptionsOf = c => (c && c.languageOptions && c.languageOptions.parserOptions) || (c && c.parserOptions) || {};
  const typed = po => !!(po && (po.project || po.projectService || po.programs || po.EXPERIMENTAL_useProjectService));

  function ruleDef(config, name) {
    try { if (typeof config.getRuleDefinition === 'function') { const d = config.getRuleDefinition(name); if (d) return d; } } catch (e) { /* fall through */ }
    const plugins = (config && config.plugins) || {};
    const i = name.lastIndexOf('/');
    if (i < 0) return null;
    const pid = name.slice(0, i), rid = name.slice(i + 1);
    const p = plugins[pid] || plugins[pid.replace(/^(@[^/]+)$/, '$1/eslint-plugin')] || plugins[`eslint-plugin-${pid}`];
    const defn = p && (p.definition || p);
    return (defn && defn.rules && defn.rules[rid]) || null;
  }
  const createOf = d => (typeof d === 'function' ? d : d && typeof d.create === 'function' ? d.create : null);

  const reasonMemo = new WeakMap();
  /** Why a file with this config must not use the cache, or null. `builtins`: core rule names of that ESLint. */
  function unsafeReason(config, builtins) {
    if (config && typeof config === 'object' && reasonMemo.has(config)) return reasonMemo.get(config);
    let why = null;
    const po = parserOptionsOf(config);
    if (typed(po) || typed(po.parserOptions)) why = 'type-aware (parserOptions.project/projectService)';
    for (const [name, v] of Object.entries((config && config.rules) || {})) {
      if (why) break;
      if (!enabled(v)) continue;
      const k = knownPure(name, builtins);
      if (k === 'unknown') { why = `rule ${name} is not known to read only its file`; break; }
      const create = createOf(ruleDef(config, name));
      // A known name is trusted only when its code is not a local file (a
      // local plugin registered under a known plugin's name is local).
      const local = create ? definedIn(create) : null;
      if (k === 'pure' && !local) continue;
      if (!local) { why = `rule ${name} is not known to read only its file`; break; }
      const imp = impureReason(local);
      if (imp) why = `local rule ${name}: ${imp}`;
    }
    if (config && typeof config === 'object') reasonMemo.set(config, why);
    return why;
  }

  // ─── what an entry depends on besides the file and ESLint's config hash ──

  function codeOf(x) {
    if (!x) return 'none';
    if (typeof x === 'function') return src(x);
    if (typeof x !== 'object') return String(x);
    // eslintrc: { definition, filePath, id } for parsers and plugins.
    if (x.definition && typeof x.definition === 'object') return `${x.filePath || x.id || ''}\n${codeOf(x.definition)}`;
    const fns = [];
    for (const k of Object.keys(x).sort()) if (typeof x[k] === 'function') fns.push(k + ':' + src(x[k]));
    let meta = '';
    try { meta = JSON.stringify(x.meta || null); } catch (e) { meta = 'meta?'; }
    return fns.join('\n') + '\n' + meta;
  }
  function processorOf(config) {
    const p = config && config.processor;
    if (typeof p !== 'string') return codeOf(p);
    // eslintrc / flat "plugin/name": the plugin's processor object.
    const i = p.lastIndexOf('/');
    const plugins = (config && config.plugins) || {};
    const pl = i > 0 && plugins[p.slice(0, i)];
    const defn = pl && (pl.definition || pl);
    return p + ':' + codeOf(defn && defn.processors && defn.processors[p.slice(i + 1)]);
  }

  let otherCwd = false;   // an ESLint was given a cwd of its own: the rule's root is not known here
  // The rule lists the route files under pages/ and app/ of each Next.js root
  // directory (names only): fingerprint that listing.
  function routeListing(config, ruleOptions) {
    if (otherCwd) throw new Error('ESLint cwd differs from the process cwd');
    const cwd = process.cwd();
    const custom = Array.isArray(ruleOptions) ? ruleOptions[1] : undefined;
    const rootDir = config && config.settings && config.settings.next && config.settings.next.rootDir;
    if (typeof rootDir === 'string' ? /[*?[\]{}!]/.test(rootDir) : Array.isArray(rootDir) && rootDir.some(d => typeof d !== 'string' || /[*?[\]{}!]/.test(d))) {
      throw new Error('settings.next.rootDir is a glob');
    }
    const roots = typeof rootDir === 'string' ? [rootDir] : Array.isArray(rootDir) ? rootDir : [cwd];
    const dirs = [];
    if (typeof custom === 'string') dirs.push(custom);
    for (const r of roots) for (const d of (typeof custom === 'string' ? ['app', 'src/app'] : ['pages', 'src/pages', 'app', 'src/app'])) dirs.push(path.join(r, d));
    const out = [];
    let n = 0;
    const walk = (d, rel) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { out.push(rel + ' -'); return; }
      ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of ents) {
        if (++n > 50000) throw new Error('route listing too large');
        out.push(rel + '/' + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(d, e.name), rel + '/' + e.name);
      }
    };
    for (const d of dirs) walk(path.resolve(cwd, d), d);
    return out.join('\n');
  }

  const depMemo = new WeakMap();
  /** Hash of the code and outside inputs this config's results depend on; throws when it cannot be known. */
  function depsOf(config) {
    const locals = localModules();
    const memo = config && typeof config === 'object' ? depMemo.get(config) : null;
    if (memo && memo.local === locals.hash) return memo.h;
    const parts = ['local:' + locals.hash];
    const lo = (config && config.languageOptions) || {};
    parts.push('parser:' + codeOf(lo.parser || (config && config.parser)));
    parts.push('processor:' + processorOf(config));
    parts.push('language:' + codeOf(config && config.language));
    for (const name of Object.keys((config && config.rules) || {}).sort()) {
      const v = config.rules[name];
      if (!enabled(v)) continue;
      parts.push(name + ':' + codeOf(ruleDef(config, name)));
      if (name === PAGES_RULE) parts.push('routes:' + routeListing(config, v));
    }
    const h = sha(...parts);
    if (config && typeof config === 'object') depMemo.set(config, { local: locals.hash, h });
    return h;
  }

  // ─── LintResultCache: refuse unsafe files, record dependencies ───────────

  const ours = new Map();          // cache file -> { builtins } for caches this preload created
  const patchedRoots = new Set();  // ESLint installs whose LintResultCache is patched
  const skipped = new Map();       // reason -> count (debug)

  // Where ESLint keeps a file's results in its descriptor, and so where the
  // dependency hash must go to be saved with them: meta.data from ESLint 10
  // (file-entry-cache 10+), meta itself before.
  function entryOf(d) {
    if (!d || !d.meta) return null;
    if (d.meta.data && typeof d.meta.data === 'object') return d.meta.data;
    return d.meta;
  }
  // The file descriptor ESLint itself looked up while running `fn`. Asking
  // file-entry-cache again is not the same: for a file it has no entry for,
  // every call hands out a fresh descriptor, dropping what was just set.
  function withDescriptor(lrc, fn) {
    const fec = lrc.fileEntryCache;
    const orig = fec.getFileDescriptor;
    let d = null;
    fec.getFileDescriptor = function () { d = orig.apply(this, arguments); return d; };
    try { return { value: fn(), d }; } finally { fec.getFileDescriptor = orig; }
  }

  function patchResultCache(LRC, file) {
    const proto = LRC && LRC.prototype;
    if (!proto || typeof proto.getValidCachedLintResults !== 'function' || typeof proto.setCachedLintResults !== 'function') return;
    if (proto.__vulcanPatched) { patchedRoots.add(pkgRoot(file)); return; }
    const getValid = proto.getValidCachedLintResults;
    const set = proto.setCachedLintResults;
    const refuse = (lrc, config) => {
      if (mode === 'all') return null;
      let why;
      try { why = unsafeReason(config, ours.get(lrc.cacheFileLocation).builtins); } catch (e) { why = 'config unreadable'; }
      if (why) skipped.set(why, (skipped.get(why) || 0) + 1);
      return why;
    };
    proto.getValidCachedLintResults = function (filePath, config) {
      if (!ours.has(this.cacheFileLocation)) return getValid.apply(this, arguments);
      try {
        if (refuse(this, config)) return null;
        const { value: results, d } = withDescriptor(this, () => getValid.apply(this, arguments));
        if (!results) return results;
        return entryOf(d) && entryOf(d).vulcanDeps === depsOf(config) ? results : null;
      } catch (e) { return null; }
    };
    proto.setCachedLintResults = function (filePath, config) {
      if (!ours.has(this.cacheFileLocation)) return set.apply(this, arguments);
      let d = null;
      try {
        if (refuse(this, config)) return undefined;
        const deps = depsOf(config);
        d = withDescriptor(this, () => set.apply(this, arguments)).d;
        const e = entryOf(d);
        if (e && e.results) e.vulcanDeps = deps;
      } catch (err) {
        // Unknown dependencies: make sure nothing of this file is reused.
        const e = entryOf(d);
        if (e) e.vulcanDeps = 'unknown';
      }
      return undefined;
    };
    Object.defineProperty(proto, '__vulcanPatched', { value: true });
    patchedRoots.add(pkgRoot(file));
  }

  // ─── the cache file: key, download, upload ───────────────────────────────

  const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
  /** Every lockfile, package.json and tsconfig.json from cwd to the filesystem root. */
  function projectFiles(cwd) {
    const parts = [];
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      for (const f of [...LOCKS, 'package.json', 'tsconfig.json']) {
        let b;
        try { b = fs.readFileSync(path.join(d, f)); } catch (e) { continue; }
        parts.push(path.join(d, f), b);
      }
      if (path.dirname(d) === d) break;
    }
    return sha(...parts);
  }
  const CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
    '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc'];
  /** The config file ESLint will use from this cwd, or null. */
  function configFile(o, cwd) {
    if (typeof o.overrideConfigFile === 'string') return path.resolve(cwd, o.overrideConfigFile);
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      for (const f of CONFIGS) if (fs.existsSync(path.join(d, f))) return path.join(d, f);
      if (path.dirname(d) === d) return null;
    }
  }
  function keyOf(o, eslintVersion, cfgFile) {
    const cwd = o.cwd || process.cwd();
    const opts = JSON.stringify(o, (k, v) => (/^cache/.test(k) ? undefined : typeof v === 'function' ? 'fn:' + src(v) : v));
    let cfg = 'noconfig';
    if (cfgFile) { try { cfg = cfgFile + ':' + sha(fs.readFileSync(cfgFile)); } catch (e) { cfg = 'unreadable'; } }
    return sha('v2', mode, opts, path.resolve(cwd), projectFiles(cwd), cfg, eslintVersion, process.version).slice(0, 40);
  }
  const fileHash = f => { try { return sha(fs.readFileSync(f)); } catch (e) { return 'none'; } };

  const spent = { get: 0, put: 0 };
  // The edge failed to answer: no more tries from any process of this job for a while.
  const downMark = () => path.join(cacheDir(), 'edge-down');
  const edgeDown = () => { try { return Date.now() - fs.statSync(downMark()).mtimeMs < 5 * 60_000; } catch (e) { return false; } };
  const markDown = () => { try { fs.writeFileSync(downMark(), ''); } catch (e) { /* best effort */ } };

  /** Fetch the cache file into `loc`: true, or why not (and no file). Synchronous: the ESLint constructor reads it. */
  function download(key, loc) {
    const missMark = `${loc}.miss`;
    if (fs.existsSync(missMark)) return 'miss (remembered)';
    if (edgeDown()) return 'edge down (remembered)';
    const left = GET_BUDGET_MS - spent.get;
    if (left < 500) return 'time budget spent';
    const part = `${loc}.${process.pid}.part`;
    const t0 = Date.now();
    try {
      const r = require('child_process').spawnSync('curl', ['-sS', '-o', part, '-w', '%{http_code}', '--connect-timeout', '0.5',
        '--max-time', String(Math.min(3, left / 1000)), '--max-filesize', String(MAX_BYTES), `${base}/${key}`],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: left + 500 });
      const code = String(r.stdout || '').trim();
      if (r.status !== 0 || code !== '200') {
        try { fs.unlinkSync(part); } catch (e) { /* none */ }
        if (r.status === 0 && code === '404') { try { fs.writeFileSync(missMark, ''); } catch (e) { /* best effort */ } return 'miss'; }
        if (r.status !== 0 || code === '000') markDown();
        return `edge answered ${code || 'nothing'} (curl ${r.status})`;
      }
      JSON.parse(fs.readFileSync(part, 'utf8'));   // a corrupt or truncated file must never reach ESLint
      fs.renameSync(part, loc);
      return true;
    } catch (e) {
      try { fs.unlinkSync(part); } catch (e2) { /* none */ }
      return 'unusable download';
    } finally { spent.get += Date.now() - t0; }
  }

  async function upload(st) {
    const t0 = Date.now();
    try {
      if (typeof fetch !== 'function' || edgeDown()) return;
      const left = PUT_BUDGET_MS - spent.put;
      if (left < 500) { say('upload time budget spent'); return; }
      const after = fileHash(st.loc);
      if (after === 'none' || after === st.before) { say(`nothing new to save (${st.key})`); return; }
      const body = fs.readFileSync(st.loc);
      if (body.length > MAX_BYTES) { say(`cache file ${body.length} bytes, over the cap; not saved`); return; }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), Math.min(3000, left));
      try {
        const r = await fetch(`${base}/${st.key}`, { method: 'PUT', body, headers: { 'content-type': 'application/json' }, signal: ac.signal });
        say(`saved ${body.length} bytes: ${r.status}`);
        try { await r.arrayBuffer(); } catch (e) { /* ignore */ }
      } finally { clearTimeout(t); }
      st.before = after;
    } catch (e) { say(`save failed: ${e && e.message}`); markDown(); } finally { spent.put += Date.now() - t0; }
  }

  function eslintVersionOf(file) {
    try { return JSON.parse(fs.readFileSync(path.join(pkgRoot(file), 'package.json'), 'utf8')).version || '?'; } catch (e) { return '?'; }
  }
  const builtinsMemo = new Map();
  /** Core rule names of the ESLint at `file`; null when unknown (then no core rule counts as known). */
  function builtinsOf(file) {
    const root = pkgRoot(file);
    if (!builtinsMemo.has(root)) {
      let names = null;
      try { names = new Set(require(path.join(root, 'lib', 'unsupported-api.js')).builtinRules.keys()); } catch (e) { names = null; }
      builtinsMemo.set(root, names);
    }
    return builtinsMemo.get(root);
  }

  /** The options to construct ESLint with, plus this file's state; null to leave ESLint alone. */
  function plan(options, file) {
    if (options === undefined) options = {};
    if (!options || typeof options !== 'object') return null;
    // The caller's own cache: hands off. (The CLI always passes cacheLocation,
    // .eslintcache by default, so only `cache` says the caller chose one.)
    if (options.cache) return null;
    if (options.concurrency !== undefined && options.concurrency !== 'off') { say('multithread linting; cache off'); return null; }
    if (!patchedRoots.has(pkgRoot(file))) { say('ESLint result cache not recognised; cache off'); return null; }
    // Without a load hook, an ESM config's local imports are invisible.
    if (!watchModules()) { say(`this Node (${process.version}) has no module.registerHooks; cache off`); return null; }
    const cwd = options.cwd || process.cwd();
    const cfgFile = configFile(options, cwd);
    // A TypeScript config may load its imports through a transpiler the hook does not see.
    if (cfgFile && /\.[cm]?ts$/.test(cfgFile)) { say('TypeScript config file; cache off'); return null; }
    if (options.cwd && path.resolve(options.cwd) !== process.cwd()) otherCwd = true;
    const builtins = builtinsOf(file);
    fs.mkdirSync(cacheDir(), { recursive: true });
    const key = keyOf(options, eslintVersionOf(file), cfgFile);
    const loc = path.join(cacheDir(), `eslint-${key}.json`);
    if (!fs.existsSync(loc)) { const r = download(key, loc); say(r === true ? `restored ${key}` : `no saved cache for ${key}: ${r}`); }
    return { options: { ...options, cache: true, cacheStrategy: 'content', cacheLocation: loc }, st: { key, loc, before: fileHash(loc) }, builtins };
  }

  function wrapESLint(Base, file) {
    const state = new WeakMap();
    class ESLint extends Base {
      constructor(options, ...rest) {
        let p = null;
        try { p = plan(options, file); } catch (e) { p = null; }
        if (!p) { super(options, ...rest); return; }
        try {
          ours.set(p.options.cacheLocation, { builtins: p.builtins });
          super(p.options, ...rest);
        } catch (e) {
          // Whatever went wrong with the cache, ESLint as the caller asked.
          ours.delete(p.options.cacheLocation);
          try { fs.unlinkSync(p.options.cacheLocation); } catch (e2) { /* none */ }
          say(`construct with cache failed (${e && e.message}); cache off`);
          super(options, ...rest);
          return;
        }
        state.set(this, p.st);
      }
      async lintFiles(...args) {
        const results = await super.lintFiles(...args);
        const st = state.get(this);
        if (st) {
          if (debug && skipped.size) say(`not cached: ${[...skipped].map(([k, v]) => `${v} x ${k}`).join(', ')}`);
          await upload(st);
        }
        return results;
      }
    }
    try { Object.defineProperty(ESLint, 'name', { value: Base.name }); } catch (e) { /* cosmetic */ }
    return ESLint;
  }

  const load = Module._load;
  const wrapped = new WeakSet();
  Module._load = function (request, parent, isMain) {
    const exp = load.apply(this, arguments);
    try {
      if (!exp || (typeof exp !== 'object' && typeof exp !== 'function') || wrapped.has(exp)) return exp;
      const looksLikeCache = typeof exp === 'function' && exp.prototype && typeof exp.prototype.setCachedLintResults === 'function';
      const hasClass = typeof exp.ESLint === 'function' || typeof exp.FlatESLint === 'function';
      if (!looksLikeCache && !hasClass) return exp;
      const file = Module._resolveFilename(request, parent, isMain);
      if (looksLikeCache && RESULT_CACHE.test(file)) { wrapped.add(exp); patchResultCache(exp, file); return exp; }
      if (hasClass && ESLINT_CLASS.test(file)) {
        wrapped.add(exp);
        // Watch module loads from here on: the config and its plugins load after this.
        watchModules();
        for (const k of ['ESLint', 'FlatESLint']) {
          if (typeof exp[k] === 'function') {
            const W = wrapESLint(exp[k], file);
            try { exp[k] = W; } catch (e) { /* frozen exports: leave ESLint alone */ }
          }
        }
      }
    } catch (e) { /* never in the way */ }
    return exp;
  };

  if (env.VULCAN_ESLINT_CACHE_TEST === '1') {
    module.exports = { unsafeReason, knownPure, impureReason };
  }
})();
