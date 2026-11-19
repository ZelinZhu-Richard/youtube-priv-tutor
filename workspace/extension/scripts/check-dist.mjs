// Validates dist/: MV3 manifest shape, every file the manifest references exists, every asset the
// HTML pages reference exists, and no API key leaked into the build. Exits non-zero on failure.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const errors = [];
const ok = [];
const fail = (m) => errors.push(m);

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json missing: run npm run build first');
  process.exit(1);
}
const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

// --- shape ---
if (m.manifest_version !== 3) fail('manifest_version must be 3');
for (const k of ['name', 'version', 'description']) if (typeof m[k] !== 'string' || !m[k]) fail(`missing ${k}`);
if (!/^\d+(\.\d+){0,3}$/.test(m.version)) fail(`invalid version ${m.version}`);
if (m.description.length > 132) fail('description longer than 132 characters');
if (m.background?.type !== 'module' || typeof m.background?.service_worker !== 'string') fail('background must be a module service worker');
if (m.browser_action || m.page_action) fail('MV2 action keys present');
if (m.background?.scripts || m.background?.page) fail('MV2 background keys present');
const allowedPerms = new Set(['sidePanel', 'storage', 'scripting', 'activeTab', 'unlimitedStorage', 'alarms']);
for (const p of m.permissions ?? []) if (!allowedPerms.has(p)) fail(`unexpected permission ${p}`);
const allowedHosts = new Set(['https://www.youtube.com/*', 'https://api.anthropic.com/*']);
for (const h of m.host_permissions ?? []) if (!allowedHosts.has(h)) fail(`unexpected host permission ${h}`);
const csp = m.content_security_policy?.extension_pages ?? '';
const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '').slice(name.length).trim();
if (directive('script-src') !== "'self'") fail(`extension_pages script-src must be exactly 'self': ${csp}`);
if (directive('default-src') !== "'none'") fail("extension_pages CSP must start from default-src 'none'");
if (directive('connect-src') !== "'self' https://api.anthropic.com") fail('connect-src must be limited to the extension and the Claude API');
// Nothing but the Claude API may appear as a remote host: no remote images, fonts, frames or scripts.
if (csp.replace('https://api.anthropic.com', '').match(/https?:|\*/)) fail(`extension_pages CSP allows a remote host: ${csp}`);
for (const d of ['img-src', 'font-src', 'frame-src', 'object-src', 'base-uri', 'form-action']) if (!directive(d)) fail(`extension_pages CSP is missing ${d}`);
if (!/connect-src 'self' https:\/\/api\.anthropic\.com/.test(csp)) fail('connect-src should be limited to the Claude API');
if (Object.keys(m.commands ?? {}).length > 4) fail('more than 4 suggested command shortcuts');

// --- referenced files ---
const refs = new Set();
refs.add(m.background.service_worker);
refs.add(m.side_panel?.default_path);
refs.add(m.options_page);
for (const v of Object.values(m.icons ?? {})) refs.add(v);
for (const v of Object.values(m.action?.default_icon ?? {})) refs.add(v);
for (const cs of m.content_scripts ?? []) for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) refs.add(f);
for (const pg of m.sandbox?.pages ?? []) refs.add(pg);
for (const r of refs) {
  if (!r) fail('empty file reference in manifest');
  else if (!existsSync(join(dist, r))) fail(`manifest references missing file: ${r}`);
  else ok.push(r);
}
for (const cs of m.content_scripts ?? []) {
  if (cs.world === 'MAIN' && cs.run_at !== 'document_start') fail('main-world script should run at document_start to observe caption requests');
}

// --- sandbox (§13.3): isolated page, no network, no extension access ---
const sbCsp = m.content_security_policy?.sandbox ?? '';
if (!(m.sandbox?.pages ?? []).includes('sandbox/index.html')) fail('sandbox/index.html is not declared as a sandboxed page');
if (!/^sandbox allow-scripts;/.test(sbCsp)) fail(`sandbox CSP must start with "sandbox allow-scripts;": ${sbCsp}`);
if (/allow-same-origin/.test(sbCsp)) fail('sandbox CSP must not allow-same-origin (it would get extension storage access)');
if (!/connect-src 'none'/.test(sbCsp)) fail("sandbox CSP must have connect-src 'none'");
if (/https?:/.test(sbCsp)) fail('sandbox CSP must not allow remote hosts');
const sbHtml = readFileSync(join(dist, 'sandbox/index.html'), 'utf8');
if (/type="module"|crossorigin/.test(sbHtml)) fail('sandbox page must load a classic script (opaque origin cannot load modules)');
if (/chrome\./.test(readFileSync(join(dist, 'sandbox/sandbox.js'), 'utf8').replace(/\/\/.*$/gm, ''))) fail('sandbox.js references chrome.* APIs');
// Pyodide must be bundled locally, never fetched.
for (const f of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'NOTICE.txt']) {
  if (!existsSync(join(dist, 'pyodide', f))) fail(`missing bundled Pyodide file pyodide/${f}`);
}
ok.push('sandbox');

// --- HTML assets ---
for (const page of [m.side_panel.default_path, m.options_page, 'library/index.html', 'sandbox/index.html']) {
  const html = readFileSync(join(dist, page), 'utf8');
  for (const [, src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(src)) fail(`${page} loads a remote resource: ${src}`);
    else if (!existsSync(resolve(dist, dirname(page), src))) fail(`${page} references missing ${src}`);
    else ok.push(`${page} -> ${src}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) fail(`${page} has an inline script (blocked by MV3 CSP)`);
}

// --- CSS url() assets (KaTeX fonts) ---
const assets = readdirSync(join(dist, 'assets'));
for (const css of assets.filter((f) => f.endsWith('.css'))) {
  const text = readFileSync(join(dist, 'assets', css), 'utf8');
  for (const [, u] of text.matchAll(/url\(([^)]+)\)/g)) {
    const p = u.replace(/["']/g, '');
    if (p.startsWith('data:')) continue;
    if (/^https?:/.test(p)) fail(`${css} loads remote ${p}`);
    else if (!existsSync(resolve(dist, 'assets', p))) fail(`${css} references missing ${p}`);
  }
}

// --- service worker and content scripts must be single files without import() ---
for (const f of [m.background.service_worker, ...(m.content_scripts ?? []).flatMap((c) => c.js ?? []), 'overlay.js', 'sandbox/sandbox.js']) {
  const code = readFileSync(join(dist, f), 'utf8');
  if (/\bimport\s*\(\s*["'`]\.{1,2}\//.test(code)) fail(`${f} dynamically imports a chunk, which MV3 service workers and content scripts cannot do`);
  if (/^\s*import\s[^(]/m.test(code)) fail(`${f} imports another chunk; it must be self-contained`);
}
const strayChunks = readdirSync(dist).filter((f) => f.endsWith('.js') && !refs.has(f) && f !== 'overlay.js');
if (strayChunks.length) fail(`unexpected top-level chunks: ${strayChunks.join(', ')}`);

// --- secrets ---
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk(dist).filter((f) => /\.(js|html|css|json)$/.test(f))) {
  if (/sk-ant-[A-Za-z0-9_-]{20,}/.test(readFileSync(f, 'utf8'))) fail(`possible API key in ${f}`);
}

if (errors.length) {
  console.error('dist check FAILED:\n- ' + errors.join('\n- '));
  process.exit(1);
}
const size = walk(dist).reduce((n, f) => n + statSync(f).size, 0);
const pySize = walk(join(dist, 'pyodide')).reduce((n, f) => n + statSync(f).size, 0);
console.log(`dist check passed: MV3 manifest valid; ${refs.size} manifest files and ${ok.length - refs.size} page assets present; sandbox isolated; Pyodide bundled; no secrets. dist ${(size / 1e6).toFixed(1)} MB (Pyodide ${(pySize / 1e6).toFixed(1)} MB).`);
