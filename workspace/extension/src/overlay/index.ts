// Fullscreen overlay (§13.2). Injected on demand (scripting.executeScript) into the content
// script's isolated world when the player is fullscreen or the side panel cannot open. Lives inside
// the player element so it shows in fullscreen; Shadow DOM keeps YouTube's CSS out. Math renders
// as MathML so no fonts or stylesheets have to be loaded into YouTube's page.
import { defaultCaptionRange } from '../shared/context';
import { splitDataUrl } from '../shared/image';
import { createRenderer } from '../shared/markdown';
import { TUTOR_PORT, type AskRequest, type CommandAction, type PortEvent } from '../shared/messages';
import { extractAlternatives } from '../shared/prompt';
import { uid } from '../shared/rpc';
import { YT } from '../shared/youtube';
import type { ContentApi } from '../content/index';

type Win = Window & { __ytTutorApi?: ContentApi; __ytTutorOverlay?: { open: (action?: CommandAction) => void } };
const w = window as Win;

const render = createRenderer({ mathOutput: 'mathml' });

// YouTube enforces Trusted Types: assigning a plain string to innerHTML throws (observed on the live
// site). The strings passed here are our own static markup or the output of the escaping Markdown
// renderer (raw HTML escaped, http(s) links only, no images, KaTeX with trust: false).
type TT = { createPolicy: (name: string, rules: { createHTML: (s: string) => string }) => { createHTML: (s: string) => unknown } };
let policy: { createHTML: (s: string) => unknown } | null = null;
try {
  policy = (window as unknown as { trustedTypes?: TT }).trustedTypes?.createPolicy('youtube-tutor-overlay', { createHTML: (s) => s }) ?? null;
} catch {
  policy = null;
}
const trusted = (s: string) => (policy ? policy.createHTML(s) : s) as unknown as string;

const CSS = `
:host { all: initial; }
.box { position: absolute; right: 16px; bottom: 64px; width: min(460px, 46%); max-height: 70%; display: flex; flex-direction: column; gap: 8px;
  background: rgba(20, 23, 25, 0.94); color: #ece7dd; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 12px;
  font: 14px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,0.4); z-index: 80; }
.head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; color: #b9c9c5; }
.head .sp { flex: 1; }
button { font: inherit; color: inherit; cursor: pointer; }
.x, .chip { background: transparent; border: 1px solid rgba(255,255,255,0.18); border-radius: 7px; padding: 3px 9px; font-size: 12.5px; }
.x { border-color: transparent; font-size: 16px; padding: 0 6px; }
.chip:hover, .x:hover { border-color: #72c4b8; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
textarea { resize: none; min-height: 38px; max-height: 110px; background: rgba(255,255,255,0.06); color: #ece7dd; border: 1px solid rgba(255,255,255,0.18);
  border-radius: 8px; padding: 8px 10px; font: inherit; }
textarea:focus { outline: none; border-color: #72c4b8; }
.ans { overflow-y: auto; font-family: 'Iowan Old Style', Charter, Georgia, serif; font-size: 15px; line-height: 1.55; }
.ans:empty { display: none; }
.ans p { margin: 0 0 .6em; } .ans pre { white-space: pre-wrap; background: rgba(255,255,255,0.06); padding: 8px; border-radius: 6px; font: 12.5px/1.45 ui-monospace, Menlo, monospace; }
.ans code { font: 0.9em ui-monospace, Menlo, monospace; } .ans a { color: #72c4b8; }
.ans .code-head { display: flex; justify-content: space-between; font: 11px ui-monospace, monospace; color: #9aa; }
.ans .code-head .copy { display: none; }
.ans .ts { font: 600 12px ui-monospace, monospace; color: #72c4b8; background: rgba(114,196,184,0.15); border: 0; border-radius: 5px; padding: 2px 5px; }
.status { font-size: 12.5px; color: #9aa0a3; }
`;

function build() {
  const api = w.__ytTutorApi;
  if (!api) return null;
  const host = document.createElement('div');
  host.id = 'yt-tutor-overlay';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = trusted(`<style>${CSS}</style>
    <div class="box" role="dialog" aria-label="Ask the tutor">
      <div class="head">YouTube Tutor <span class="sp"></span><button class="x" data-close aria-label="Close">×</button></div>
      <div class="ans" aria-live="polite"></div>
      <div class="status"></div>
      <div class="row">
        <button class="chip" data-kind="lost">I'm lost</button>
        <button class="chip" data-kind="explain-screen">Explain this screen</button>
      </div>
      <textarea rows="1" placeholder="Ask about this moment… (Enter to send, Esc to close)"></textarea>
    </div>`);
  const ans = root.querySelector('.ans') as HTMLDivElement;
  const status = root.querySelector('.status') as HTMLDivElement;
  const input = root.querySelector('textarea') as HTMLTextAreaElement;
  let port: chrome.runtime.Port | null = null;
  let reqId: string | null = null;
  let text = '';

  // Keep YouTube's keyboard shortcuts (space, f, k, arrows) from firing while typing here.
  for (const ev of ['keydown', 'keyup', 'keypress']) host.addEventListener(ev, (e) => e.stopPropagation());
  host.addEventListener('click', (e) => e.stopPropagation());
  host.addEventListener('dblclick', (e) => e.stopPropagation());

  /** Set when this overlay is closed, so a question still being prepared is never sent from a dead UI. */
  let closed = false;
  const close = () => {
    closed = true;
    if (reqId) port?.postMessage({ type: 'cancel', reqId });
    host.remove();
  };
  root.querySelector('[data-close]')!.addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent;
    if (k.key === 'Escape') close();
    if (k.key === 'Enter' && !k.shiftKey && !k.isComposing && document.activeElement === host && root.activeElement === input) {
      k.preventDefault();
      if (input.value.trim()) ask('question', input.value.trim());
    }
  });
  ans.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button.ts');
    const v = api.findVideo();
    if (b?.dataset.t && v) v.currentTime = Number(b.dataset.t);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.kind as AskRequest['kind'], '')));

  const connect = () => {
    if (port) return port;
    port = chrome.runtime.connect({ name: TUTOR_PORT });
    port.onDisconnect.addListener(() => {
      port = null;
      if (reqId) status.textContent = 'Connection lost. Try again.';
      reqId = null;
    });
    port.onMessage.addListener((m: PortEvent) => {
      if (m.type === 'pong' || m.reqId !== reqId) return;
      if (m.type === 'thinking' && !text) status.textContent = 'Thinking…';
      if (m.type === 'delta') {
        text += m.text;
        status.textContent = '';
        ans.innerHTML = trusted(render(text));
        ans.scrollTop = ans.scrollHeight;
      }
      if (m.type === 'done') {
        reqId = null;
        if (m.result.kind === 'ask') ans.innerHTML = trusted(render(extractAlternatives(m.result.entry.answer).body));
        status.textContent = 'Saved to your notes for this video.';
      }
      if (m.type === 'error') {
        reqId = null;
        status.textContent = m.error.message;
      }
    });
    return port;
  };

  /** True from the moment a question is accepted until its request is sent or abandoned. */
  let preparing = false;
  async function ask(kind: AskRequest['kind'], question: string) {
    if (reqId || preparing) return;
    preparing = true;
    try {
      await prepareAndSend(kind, question);
    } finally {
      preparing = false;
    }
  }

  async function prepareAndSend(kind: AskRequest['kind'], question: string) {
    api!.pause();
    const st = api!.state();
    if (!st.videoId || !st.meta) {
      status.textContent = 'The video data has not loaded yet.';
      return;
    }
    status.textContent = 'Capturing the frame…';
    // The state above was read before captions loaded; use the status this call returns.
    const captions = await api!.ensureCaptions();
    const f = await api!.capture();
    // The learner may have moved to another video while captions loaded; the frame just captured
    // would then be the new video's, so do not send or store it under the old one.
    if (closed) return;
    if (api!.state().videoId !== st.videoId) {
      status.textContent = 'The video changed. Ask again.';
      return;
    }
    const parts = f.ok ? splitDataUrl(f.dataUrl) : null;
    const t = st.player?.t ?? 0;
    text = '';
    ans.textContent = '';
    input.value = '';
    reqId = uid('o');
    const req: AskRequest = {
      type: 'ask',
      reqId,
      videoId: st.videoId,
      kind,
      question,
      t,
      paused: true,
      frame: f.ok && parts ? { mediaType: parts.mediaType as 'image/jpeg', data: parts.data, width: f.width, height: f.height, qualityLabel: f.qualityLabel } : null,
      frameNote: f.ok ? null : f.message,
      crop: null,
      captionRange: captions.state === 'ready' ? defaultCaptionRange(t, st.player?.duration ?? st.meta.lengthSeconds) : null,
      fallbackLanguage: navigator.language || 'English',
      keepFrame: true,
    };
    status.textContent = 'Asking…';
    connect().postMessage(req);
  }

  return {
    host,
    focus: () => setTimeout(() => input.focus(), 0),
    run: (action?: CommandAction) => {
      if (action === 'im-lost') ask('lost', '');
      else if (action === 'explain-screen') ask('explain-screen', '');
    },
  };
}

let ui: ReturnType<typeof build> = null;

w.__ytTutorOverlay = {
  open(action?: CommandAction) {
    const player = document.querySelector(YT.playerSelector);
    if (!player) return;
    if (!ui || !ui.host.isConnected) {
      ui = build();
      if (!ui) return;
      player.appendChild(ui.host);
    }
    ui.focus();
    ui.run(action);
  },
};
