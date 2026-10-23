'use strict';
// ESLint result cache for repositories that opt in (docs/eslint-cache.md).
//
// Loaded into every Node process of the job with NODE_OPTIONS=--require (the
// runner's .env, written by run-job.eslint.sh). In a process that never loads
// ESLint it only installs a Module._load hook. When ESLint's Node API is
// constructed without a cache of its own, this turns ESLint's result cache on
// (strategy "content": a checkout resets mtimes), in a local file that is
// first fetched from the in-VM edge and sent back after the lint.
//
// The cache must never change a job's result:
//   - The cache FILE is chosen by a hash of every result-affecting option
//     (ESLint's own cache ignores --quiet's rule filter, so a --quiet run
//     would otherwise hide warnings from the next full run), the cwd, the
//     nearest lockfile (plugin and parser versions), ESLint's version, the
//     Node version and the config file's bytes.
//   - Each entry also records a hash of the code of every enabled plugin rule,
//     parser and processor (ESLint's own config hash leaves functions out, so
//     an edited local rule would otherwise keep its old results).
//   - In "safe" mode (the default) a file whose config uses type information
//     (parserOptions.project / projectService / programs) or a rule that reads
//     other files (eslint-plugin-import's resolving rules, eslint-plugin-n's
//     package.json rules, ...) is never served from the cache and never stored:
//     ESLint's cache does not track dependencies between files, so such a file
//     could keep a result an edit elsewhere changed. Those files lint as usual.
//     A rule whose only outside input is a directory listing that can be
//     fingerprinted (@next/next/no-html-link-for-pages) is keyed on it instead.
//   - Any error anywhere, an edge that does not answer, a corrupt download:
//     ESLint runs exactly as it would without this file.
//   - VULCAN_ESLINT_CACHE=0 in a step's env turns it off for that step.
//
// Environment:
//   VULCAN_ESLINT_CACHE        safe | all ("all" also caches type-aware and
//                              cross-file files, with ESLint's documented caveat);
//                              anything else: off
//   VULCAN_ESLINT_CACHE_URL    http://127.0.0.1:7480/eslint/v1 (the edge; it adds the VM token)
//   VULCAN_ESLINT_CACHE_DIR    local directory for cache files (default: <tmpdir>/vulcan-eslint-cache)
//   VULCAN_ESLINT_CACHE_DEBUG  1: one line per decision on stderr
// Plain CommonJS for every Node ESLint supports; no dependencies.
(function main() {
  const env = process.env;
  const mode = env.VULCAN_ESLINT_CACHE;
  if (mode !== 'safe' && mode !== 'all') return;
  const base = (env.VULCAN_ESLINT_CACHE_URL || '').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(base + '/')) return;

  const Module = require('module');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const crypto = require('crypto');
  const cp = require('child_process');

  const MAX_BYTES = 8 * 1024 * 1024;
  // Absolute: ESLint resolves its cache location against its cwd, and the
  // patched LintResultCache recognises this file's caches by that path.
  const dir = path.resolve(env.VULCAN_ESLINT_CACHE_DIR || path.join(os.tmpdir(), 'vulcan-eslint-cache'));
  const debug = env.VULCAN_ESLINT_CACHE_DEBUG === '1';
  const say = msg => { if (debug) { try { process.stderr.write(`vulcan eslint cache: ${msg}\n`); } catch (e) { /* closed */ } } };
  const sha = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(String(p)).update('\0'); return h.digest('hex'); };

  const ESLINT_CLASS = /[\\/]eslint\d*[\\/]lib[\\/]eslint[\\/](flat-)?eslint\.js$/;
  const RESULT_CACHE = /[\\/]eslint\d*[\\/]lib[\\/](.+[\\/])?lint-result-cache\.js$/;
  const pkgRoot = file => file.replace(/[\\/]lib[\\/].*$/, '');

  // ─── rules that read other files ──────────────────────────────────────────

  // eslint-plugin-import / import-x rules that never resolve or read another
  // file; every other rule of theirs does (resolution, the module graph,
  // package.json), so it is cross-file.
  const IMPORT_PURE = new Set([
    'first', 'newline-after-import', 'exports-last', 'no-anonymous-default-export', 'no-default-export',
    'no-named-export', 'prefer-default-export', 'no-namespace', 'no-mutable-exports', 'no-amd', 'no-commonjs',
    'unambiguous', 'no-empty-named-blocks', 'group-exports', 'no-webpack-loader-syntax', 'dynamic-import-chunkname',
    'max-dependencies', 'no-dynamic-require', 'no-absolute-path', 'consistent-type-specifier-style', 'no-named-default',
    'prefer-namespace-import',
  ]);
  // eslint-plugin-n / eslint-plugin-node rules that read only the file.
  const NODE_PURE = new Set([
    'callback-return', 'exports-style', 'global-require', 'handle-callback-err', 'no-callback-literal',
    'no-exports-assign', 'no-mixed-requires', 'no-new-require', 'no-path-concat', 'no-process-env', 'no-process-exit',
    'no-sync', 'no-deprecated-api', 'process-exit-as-throw', 'no-restricted-import', 'no-restricted-require',
    'prefer-global/buffer', 'prefer-global/console', 'prefer-global/process', 'prefer-global/text-decoder',
    'prefer-global/text-encoder', 'prefer-global/url', 'prefer-global/url-search-params',
    'prefer-promises/dns', 'prefer-promises/fs',
  ]);
  // Other well-known rules whose result depends on files besides the one linted.
  const CROSS = new Set([
    '@nx/enforce-module-boundaries', '@nrwl/nx/enforce-module-boundaries',
    'turbo/no-undeclared-env-vars', 'prettier/prettier', 'compat/compat',
    'unicorn/no-unnecessary-polyfills', 'storybook/no-uninstalled-addons', 'jest/no-deprecated-functions',
    'boundaries/element-types', 'boundaries/entry-point', 'boundaries/external', 'boundaries/no-private',
    'boundaries/no-unknown', 'boundaries/no-unknown-files', 'boundaries/no-ignored', 'boundaries/dependencies',
    'i18next/no-literal-string', 'react-native/no-unused-styles', 'graphql/template-strings', 'graphql/named-operations',
    'graphql/required-fields', 'graphql/no-deprecated-fields', '@graphql-eslint/known-type-names',
  ]);
  const CROSS_PREFIX = ['tailwindcss/', 'better-tailwindcss/', 'readable-tailwind/', '@graphql-eslint/', 'boundaries/', 'monorepo-cop/', 'workspaces/'];
  const PAGES_RULE = '@next/next/no-html-link-for-pages';

  function crossFile(name) {
    if (CROSS.has(name) || CROSS_PREFIX.some(p => name.startsWith(p))) return true;
    let m = /^(?:import|import-x)\/(.+)$/.exec(name);
    if (m) return !IMPORT_PURE.has(m[1]);
    m = /^(?:n|node)\/(.+)$/.exec(name);
    if (m) return !NODE_PURE.has(m[1]);
    return false;
  }

  const sevOf = v => (Array.isArray(v) ? v[0] : v);
  const enabled = v => { const s = sevOf(v); return s !== 0 && s !== 'off' && s !== '0' && s !== undefined; };
  const parserOptionsOf = c => (c && c.languageOptions && c.languageOptions.parserOptions) || (c && c.parserOptions) || {};
  const typed = po => !!(po && (po.project || po.projectService || po.programs || po.EXPERIMENTAL_useProjectService));

  /** Why a file with this config must not use the cache, or null. */
  function unsafeReason(config) {
    const po = parserOptionsOf(config);
    if (typed(po) || typed(po.parserOptions)) return 'type-aware (parserOptions.project/projectService)';
    for (const [name, v] of Object.entries((config && config.rules) || {})) {
      if (enabled(v) && crossFile(name)) return `cross-file rule ${name}`;
    }
    return null;
  }

  // ─── what an entry depends on besides the file and ESLint's config hash ──

  function ruleDef(config, name) {
    try { if (typeof config.getRuleDefinition === 'function') return config.getRuleDefinition(name); } catch (e) { /* fall through */ }
    const plugins = (config && config.plugins) || {};
    const i = name.lastIndexOf('/');
    if (i < 0) return null;   // a core rule: ESLint's version is in the key
    let pid = name.slice(0, i), rid = name.slice(i + 1);
    // eslintrc: "@scope/rule" belongs to plugin "@scope/eslint-plugin"; flat config names plugins freely.
    const p = plugins[pid] || plugins[pid.replace(/^(@[^/]+)$/, '$1/eslint-plugin')];
    const defn = p && (p.definition || p);
    return (defn && defn.rules && defn.rules[rid]) || null;
  }
  const src = f => (typeof f === 'function' ? Function.prototype.toString.call(f) : '');
  function codeOf(x) {
    if (!x) return 'none';
    if (typeof x === 'function') return src(x);
    if (typeof x !== 'object') return String(x);
    const fns = [];
    for (const k of Object.keys(x).sort()) if (typeof x[k] === 'function') fns.push(k + ':' + src(x[k]));
    let meta = '';
    try { meta = JSON.stringify(x.meta || null); } catch (e) { meta = 'meta?'; }
    return fns.join('\n') + '\n' + meta;
  }

  // The rule lists the route files under pages/ and app/ of each Next.js root
  // directory (names only): fingerprint that listing.
  let otherCwd = false;   // an ESLint was given a cwd of its own: the rule's root is not known here
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
    if (config && typeof config === 'object' && depMemo.has(config)) return depMemo.get(config);
    const parts = [];
    const lo = (config && config.languageOptions) || {};
    parts.push('parser:' + codeOf(lo.parser || (config && config.parser)));
    parts.push('processor:' + codeOf(config && config.processor));
    parts.push('language:' + codeOf(config && config.language));
    for (const name of Object.keys((config && config.rules) || {}).sort()) {
      const v = config.rules[name];
      if (!enabled(v)) continue;
      parts.push(name + ':' + codeOf(ruleDef(config, name)));
      if (name === PAGES_RULE) parts.push('routes:' + routeListing(config, v));
    }
    const h = sha(...parts);
    if (config && typeof config === 'object') depMemo.set(config, h);
    return h;
  }

  // ─── LintResultCache: refuse unsafe files, record dependencies ───────────

  const ours = new Set();          // cache files this preload created
  const patchedRoots = new Set();  // ESLint installs whose LintResultCache is patched
  const skipped = new Map();       // reason -> count (debug)

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

  // Where ESLint keeps a file's results in its descriptor, and so where the
  // dependency hash must go to be saved with them: meta.data from ESLint 10
  // (file-entry-cache 10+), meta itself before.
  function entryOf(d) {
    if (!d || !d.meta) return null;
    if (d.meta.data && typeof d.meta.data === 'object') return d.meta.data;
    return d.meta;
  }

  function patchResultCache(LRC, file) {
    const proto = LRC && LRC.prototype;
    if (!proto || typeof proto.getValidCachedLintResults !== 'function' || typeof proto.setCachedLintResults !== 'function') return;
    if (proto.__vulcanPatched) { patchedRoots.add(pkgRoot(file)); return; }
    const getValid = proto.getValidCachedLintResults;
    const set = proto.setCachedLintResults;
    const refuse = (config) => {
      if (mode === 'all') return null;
      let why;
      try { why = unsafeReason(config); } catch (e) { why = 'config unreadable'; }
      if (why) skipped.set(why, (skipped.get(why) || 0) + 1);
      return why;
    };
    proto.getValidCachedLintResults = function (filePath, config) {
      if (!ours.has(this.cacheFileLocation)) return getValid.apply(this, arguments);
      try {
        if (refuse(config)) return null;
        const { value: results, d } = withDescriptor(this, () => getValid.apply(this, arguments));
        if (!results) return results;
        return entryOf(d) && entryOf(d).vulcanDeps === depsOf(config) ? results : null;
      } catch (e) { return null; }
    };
    proto.setCachedLintResults = function (filePath, config) {
      if (!ours.has(this.cacheFileLocation)) return set.apply(this, arguments);
      let d = null;
      try {
        if (refuse(config)) return undefined;
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
  function lockHash(cwd) {
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      for (const f of LOCKS) {
        let b;
        try { b = fs.readFileSync(path.join(d, f)); } catch (e) { continue; }
        return f + ':' + sha(b);
      }
      if (path.dirname(d) === d) return 'nolock';
    }
  }
  const CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
    '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc'];
  function configHash(o, cwd) {
    if (typeof o.overrideConfigFile === 'string') {
      try { return sha(fs.readFileSync(path.resolve(cwd, o.overrideConfigFile))); } catch (e) { return 'unreadable'; }
    }
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      for (const f of CONFIGS) {
        let b;
        try { b = fs.readFileSync(path.join(d, f)); } catch (e) { continue; }
        return f + ':' + sha(b);
      }
      if (path.dirname(d) === d) return 'noconfig';
    }
  }
  function keyOf(o, eslintVersion) {
    const cwd = o.cwd || process.cwd();
    const opts = JSON.stringify(o, (k, v) => (/^cache/.test(k) ? undefined : typeof v === 'function' ? 'fn:' + src(v) : v));
    return sha('v1', mode, opts, path.resolve(cwd), lockHash(cwd), configHash(o, cwd), eslintVersion, process.version).slice(0, 40);
  }
  const fileHash = f => { try { return sha(fs.readFileSync(f)); } catch (e) { return 'none'; } };

  /** Fetch the cache file into `loc`; false (and no file) on any trouble. Synchronous: the ESLint constructor reads it. */
  function download(key, loc) {
    const part = `${loc}.${process.pid}.part`;
    try {
      const r = cp.spawnSync('curl', ['-fsS', '--connect-timeout', '1', '--max-time', '10', '--max-filesize', String(MAX_BYTES), '-o', part, `${base}/${key}`],
        { stdio: 'ignore', timeout: 12000 });
      if (r.status !== 0) { try { fs.unlinkSync(part); } catch (e) { /* none */ } return false; }
      const body = fs.readFileSync(part, 'utf8');
      JSON.parse(body);   // a corrupt or truncated file must never reach ESLint
      fs.renameSync(part, loc);
      return true;
    } catch (e) {
      try { fs.unlinkSync(part); } catch (e2) { /* none */ }
      return false;
    }
  }

  async function upload(st) {
    try {
      if (typeof fetch !== 'function') return;
      const after = fileHash(st.loc);
      if (after === 'none' || after === st.before) { say(`nothing new to save (${st.key})`); return; }
      const body = fs.readFileSync(st.loc);
      if (body.length > MAX_BYTES) { say(`cache file ${body.length} bytes, over the cap; not saved`); return; }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      try {
        const r = await fetch(`${base}/${st.key}`, { method: 'PUT', body, headers: { 'content-type': 'application/json' }, signal: ac.signal });
        say(`saved ${body.length} bytes: ${r.status}`);
        try { await r.arrayBuffer(); } catch (e) { /* ignore */ }
      } finally { clearTimeout(t); }
      st.before = after;
    } catch (e) { say(`save failed: ${e && e.message}`); }
  }

  function eslintVersionOf(file) {
    try { return JSON.parse(fs.readFileSync(path.join(pkgRoot(file), 'package.json'), 'utf8')).version || '?'; } catch (e) { return '?'; }
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
    if (options.cwd && path.resolve(options.cwd) !== process.cwd()) otherCwd = true;
    fs.mkdirSync(dir, { recursive: true });
    const key = keyOf(options, eslintVersionOf(file));
    const loc = path.join(dir, `eslint-${key}.json`);
    if (!fs.existsSync(loc)) say(download(key, loc) ? `restored ${key}` : `no saved cache for ${key}`);
    return { options: { ...options, cache: true, cacheStrategy: 'content', cacheLocation: loc }, st: { key, loc, before: fileHash(loc) } };
  }

  function wrapESLint(Base, file) {
    const state = new WeakMap();
    class ESLint extends Base {
      constructor(options, ...rest) {
        let p = null;
        try { p = plan(options, file); } catch (e) { p = null; }
        if (!p) { super(options, ...rest); return; }
        try {
          ours.add(p.options.cacheLocation);
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
    module.exports = { unsafeReason, crossFile, keyOf, depsOf, lockHash, routeListing };
  }
})();
