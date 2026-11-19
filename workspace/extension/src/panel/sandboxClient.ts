// Talks to the sandboxed code runner (sandbox/index.html) through a hidden iframe. Used by the side
// panel and the library page. Pyodide's files are read from the extension package here (same
// origin) and handed to the sandbox, which has no network and no extension access.
import { buildJsHarness, buildPyHarness, parseHarnessResult } from '../shared/practice';
import { uid } from '../shared/rpc';
import type { RunResult } from '../shared/types';

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let pyAssetsSent: Promise<void> | null = null;
let onReady: (() => void) | null = null;
const pending = new Map<string, (r: { json: string | null; ms: number; timedOut: boolean }) => void>();

/** Drops the sandbox frame so the next run starts a fresh one (after it failed to start or went silent). */
function resetFrame() {
  frame?.remove();
  frame = null;
  ready = null;
  pyAssetsSent = null;
  for (const resolve of pending.values()) resolve({ json: null, ms: 0, timedOut: false });
  pending.clear();
}

let listening = false;
function ensureFrame(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    // The sandbox page may fail to load at all; never wait on it forever.
    const timer = setTimeout(() => {
      resetFrame();
      reject(new Error('The code sandbox did not start. Try again, or reload the extension.'));
    }, 10_000);
    const started = () => {
      clearTimeout(timer);
      resolve();
    };
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('sandbox/index.html');
    frame.title = 'Code sandbox';
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    onReady = started;
    if (!listening) {
      listening = true;
      window.addEventListener('message', (e: MessageEvent) => {
        if (!frame || e.source !== frame.contentWindow) return;
        const m = e.data as { type: string; id?: string; result?: { json: string | null; ms: number; timedOut: boolean } };
        if (m.type === 'ready') onReady?.();
        else if (m.type === 'result' && m.id) {
          pending.get(m.id)?.(m.result!);
          pending.delete(m.id);
        }
      });
    }
    document.body.appendChild(frame);
  });
  return ready;
}

const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

async function sendPyAssets(): Promise<void> {
  pyAssetsSent ??= (async () => {
    const base = chrome.runtime.getURL('pyodide/');
    const [pyodideMjs, asmMjs, wasm, stdlib, lock] = await Promise.all(
      PYODIDE_FILES.map(async (f) => {
        const res = await fetch(base + f);
        if (!res.ok) throw new Error(`Missing ${f} in the extension package`);
        return f.endsWith('.wasm') || f.endsWith('.zip') ? res.arrayBuffer() : res.text();
      }),
    );
    frame!.contentWindow!.postMessage({ type: 'py-assets', assets: { pyodideMjs, asmMjs, wasm, stdlib, lock } }, '*');
  })().catch((e) => {
    pyAssetsSent = null;
    throw e;
  });
  return pyAssetsSent;
}

/** Runs code with tests in the sandbox. Never throws; failures come back in the result. */
export async function runCode(language: 'javascript' | 'python', code: string, tests: { name: string; code: string }[] = [], timeoutMs?: number): Promise<RunResult> {
  try {
    await ensureFrame();
    if (language === 'python') await sendPyAssets();
  } catch (e) {
    return { ok: false, stdout: '', error: String(e), tests: [], timedOut: false, ms: 0 };
  }
  const id = uid('run');
  const src = language === 'python' ? buildPyHarness(code, tests) : buildJsHarness(code, tests);
  const limit = timeoutMs ?? (language === 'python' ? 20_000 : 8_000);
  const r = await new Promise<{ json: string | null; ms: number; timedOut: boolean }>((resolve) => {
    // The sandbox enforces `limit` itself. This outer timer only covers a sandbox that has gone
    // silent; Python gets extra time because the first run also loads Pyodide.
    const timer = setTimeout(resetFrame, limit + (language === 'python' ? 60_000 : 5_000));
    pending.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    frame!.contentWindow!.postMessage({ type: 'run', id, language, src, timeoutMs: limit }, '*');
  });
  if (r.timedOut || !r.json) return { ok: false, stdout: '', error: r.timedOut ? null : 'No result from the sandbox.', tests: [], timedOut: r.timedOut, ms: r.ms };
  return parseHarnessResult(r.json, r.ms);
}

export function languageOf(lang: string): 'javascript' | 'python' | null {
  const l = lang.toLowerCase();
  if (['js', 'javascript', 'mjs', 'node'].includes(l)) return 'javascript';
  if (['py', 'python', 'python3'].includes(l)) return 'python';
  return null;
}
