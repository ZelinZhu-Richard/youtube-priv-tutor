// Code sandbox (§13.3). Runs in the manifest's sandboxed page: opaque origin, no chrome.* APIs, no
// access to extension storage, and a CSP with connect-src 'none'. Each job runs in a blob Worker so
// an infinite loop can be killed; JavaScript gets a fresh worker per run, Python keeps one worker
// with Pyodide loaded. Pyodide's files arrive from the parent page as buffers and are served to
// Pyodide through a fetch shim, so nothing is fetched at runtime.

interface RunMsg {
  type: 'run';
  id: string;
  language: 'javascript' | 'python';
  src: string;
  timeoutMs: number;
}
interface AssetsMsg {
  type: 'py-assets';
  assets: PyAssets;
}
interface PyAssets {
  pyodideMjs: string;
  asmMjs: string;
  wasm: ArrayBuffer;
  stdlib: ArrayBuffer;
  lock: string;
}

// Defence in depth only: the page CSP (connect-src 'none') is what actually blocks the network.
// Worker is on the list because a nested worker would start with an untouched global.
const LOCKDOWN = `for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker']) { try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch {} }`;

const JS_WORKER = `${LOCKDOWN}
const AsyncFunction = (async () => {}).constructor;
self.onmessage = async (e) => {
  const logs = [], results = [];
  try {
    // Async, so exercises and tests may use await; the run is over when the body settles.
    await new AsyncFunction('__logs', '__results', e.data.src)(logs, results);
    self.postMessage({ stdout: logs.join('\\n').slice(-20000), error: null, tests: results });
  } catch (err) {
    self.postMessage({ stdout: logs.join('\\n').slice(-20000), error: String((err && err.stack) || err), tests: results });
  }
};`;

const PY_WORKER = `let py = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const a = m.assets;
      const files = { 'pyodide.asm.wasm': [a.wasm, 'application/wasm'], 'python_stdlib.zip': [a.stdlib, 'application/zip'], 'pyodide-lock.json': [a.lock, 'application/json'] };
      self.fetch = async (url) => {
        const name = String(url).split('/').pop().split('?')[0];
        const f = files[name];
        if (!f) throw new Error('Network access is disabled in the sandbox: ' + url);
        return new Response(f[0], { headers: { 'Content-Type': f[1] } });
      };
      const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      const { loadPyodide } = await import(blobUrl(a.pyodideMjs));
      const asm = await import(blobUrl(a.asmMjs));
      py = await loadPyodide({ indexURL: 'https://pyodide.invalid/', createPyodideModule: asm.default, lockFileContents: JSON.parse(a.lock), stdout: () => {}, stderr: () => {} });
      for (const k of ['XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker']) { try { Object.defineProperty(self, k, { value: undefined }); } catch {} }
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: String((err && err.stack) || err) });
    }
  } else if (m.type === 'run') {
    try {
      self.postMessage({ type: 'result', json: py.runPython(m.src) });
    } catch (err) {
      self.postMessage({ type: 'result', json: JSON.stringify({ stdout: '', error: String(err), tests: [] }) });
    }
  }
};`;

const workerUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
const JS_URL = workerUrl(JS_WORKER);
const PY_URL = workerUrl(PY_WORKER);

let assets: PyAssets | null = null;
let py: { worker: Worker; ready: Promise<void> } | null = null;

const reply = (msg: unknown) => window.parent.postMessage(msg, '*');

function result(id: string, r: { stdout: string; error: string | null; tests: unknown[] } | null, ms: number, timedOut = false) {
  reply({ type: 'result', id, result: { json: r ? JSON.stringify(r) : null, ms, timedOut } });
}

function runJs(m: RunMsg) {
  const t0 = performance.now();
  const w = new Worker(JS_URL);
  const timer = setTimeout(() => {
    w.terminate();
    result(m.id, { stdout: '', error: null, tests: [] }, performance.now() - t0, true);
  }, m.timeoutMs);
  w.onmessage = (e) => {
    clearTimeout(timer);
    w.terminate();
    result(m.id, e.data, performance.now() - t0);
  };
  w.onerror = (e) => {
    clearTimeout(timer);
    w.terminate();
    result(m.id, { stdout: '', error: e.message || 'Worker error', tests: [] }, performance.now() - t0);
  };
  w.postMessage({ src: m.src });
}

function startPython(): { worker: Worker; ready: Promise<void> } {
  const worker = new Worker(PY_URL);
  const ready = new Promise<void>((resolve, reject) => {
    const onInit = (e: MessageEvent) => {
      if (e.data?.type === 'ready') resolve();
      else if (e.data?.type === 'init-error') reject(new Error(e.data.error));
      else return;
      worker.removeEventListener('message', onInit);
    };
    worker.addEventListener('message', onInit);
    // Copies, so the assets survive a worker restart after a timeout.
    worker.postMessage({ type: 'init', assets: { ...assets!, wasm: assets!.wasm.slice(0), stdlib: assets!.stdlib.slice(0) } });
  });
  return { worker, ready };
}

async function runPy(m: RunMsg) {
  if (!assets) return result(m.id, { stdout: '', error: 'Python is not available (the Pyodide files were not provided).', tests: [] }, 0);
  py ??= startPython();
  try {
    // Never wait on start-up forever: a stuck init would hold up every later run.
    await Promise.race([py.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out loading Pyodide')), 60_000))]);
  } catch (e) {
    py.worker.terminate();
    py = null;
    return result(m.id, { stdout: '', error: `Python failed to start: ${String(e)}`, tests: [] }, 0);
  }
  const t0 = performance.now();
  const { worker } = py;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      py = null; // restart on next run
      result(m.id, { stdout: '', error: null, tests: [] }, performance.now() - t0, true);
      resolve();
    }, m.timeoutMs);
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== 'result') return;
      clearTimeout(timer);
      worker.removeEventListener('message', onMsg);
      reply({ type: 'result', id: m.id, result: { json: e.data.json, ms: performance.now() - t0, timedOut: false } });
      resolve();
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'run', src: m.src });
  });
}

let queue = Promise.resolve();

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const m = e.data as RunMsg | AssetsMsg;
  if (m?.type === 'py-assets') assets = m.assets;
  else if (m?.type === 'run') {
    // A run that throws must report its error and leave the queue usable for the next one.
    queue = queue
      .then(() => (m.language === 'python' ? runPy(m) : runJs(m)))
      .catch((err) => result(m.id, { stdout: '', error: `The sandbox could not run this: ${String(err)}`, tests: [] }, 0));
  }
});

reply({ type: 'ready' });
