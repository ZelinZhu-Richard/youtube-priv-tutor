// Builds the extension into dist/ with four plain Vite builds:
//   1. extension pages (side panel + options) as ES modules
//   2. the service worker as a single ES module
//   3. the content script as a single classic (IIFE) script
//   4. the main-world page script as a single classic (IIFE) script
// Content scripts cannot be ES modules, so they are built separately and self-contained.
import { build } from 'vite';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = resolve(root, 'src');
// Build into a staging folder and swap it in at the end. Chrome loads the unpacked extension
// straight from dist/, so emptying dist/ during a build left it without background.js for several
// seconds; a reload or service-worker restart in that window failed with "An unknown error
// occurred when fetching the script" and left the old worker (or none) running.
const distDir = resolve(root, 'dist');
const prevDir = resolve(root, '.dist-prev');
const outDir = resolve(root, '.dist-next');

const common = {
  configFile: false,
  logLevel: 'warn',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
};

const quiet = { reportCompressedSize: false, chunkSizeWarningLimit: 4000 };

// 1. Extension pages. root = src so the HTML lands at dist/panel/index.html and dist/options/index.html.
await build({
  ...common,
  root: src,
  base: './',
  publicDir: resolve(root, 'public'),
  build: {
    ...quiet,
    outDir,
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: false,
    rolldownOptions: {
      input: {
        panel: resolve(src, 'panel/index.html'),
        options: resolve(src, 'options/index.html'),
        library: resolve(src, 'library/index.html'),
      },
    },
  },
});

async function single(entry, fileName, format, name) {
  await build({
    ...common,
    root,
    publicDir: false,
    build: {
      ...quiet,
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'chrome116',
      lib: { entry: resolve(src, entry), formats: [format], fileName: () => fileName, name },
      // One self-contained file: MV3 service workers cannot use dynamic import(), and content
      // scripts cannot load chunks at all.
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
}

// 2-4. Service worker, content script, page-world script.
await single('background/index.ts', 'background.js', 'es');
await single('content/index.ts', 'content.js', 'iife', 'ytTutorContent');
await single('page/index.ts', 'page.js', 'iife', 'ytTutorPage');
// 5. Fullscreen overlay, injected on demand into the content script's world.
await single('overlay/index.ts', 'overlay.js', 'iife', 'ytTutorOverlay');
// 6. Code sandbox runner (classic script: the sandboxed page has an opaque origin, so no module/CORS loads).
await single('sandbox/index.ts', 'sandbox/sandbox.js', 'iife', 'ytTutorSandbox');

// Pyodide, copied from node_modules (restored by npm install), so Python runs with no remote code.
const pyodideSrc = resolve(root, 'node_modules', 'pyodide');
const pyodideOut = resolve(outDir, 'pyodide');
mkdirSync(pyodideOut, { recursive: true });
for (const f of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) cpSync(resolve(pyodideSrc, f), resolve(pyodideOut, f));
const pyVersion = JSON.parse(readFileSync(resolve(pyodideSrc, 'package.json'), 'utf8')).version;
writeFileSync(
  resolve(pyodideOut, 'NOTICE.txt'),
  `Pyodide ${pyVersion} (https://github.com/pyodide/pyodide), Mozilla Public License 2.0.\nUnmodified files from the "pyodide" npm package; source at https://github.com/pyodide/pyodide/tree/${pyVersion}.\n`,
);

// Manifest: copy, stamping the version from package.json so they never drift.
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

rmSync(prevDir, { recursive: true, force: true });
if (existsSync(distDir)) renameSync(distDir, prevDir);
renameSync(outDir, distDir);
rmSync(prevDir, { recursive: true, force: true });

console.log('Built extension into', distDir);
