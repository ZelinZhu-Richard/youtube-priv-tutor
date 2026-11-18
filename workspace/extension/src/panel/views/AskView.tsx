// Asking state: the conversation, and the composer with its context chips (§12.2, §12.3, §13.2).
import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { defaultCaptionRange } from '../../shared/context';
import { formatTime } from '../../shared/time';
import type { Depth } from '../../shared/types';
import { uid } from '../../shared/rpc';
import type { Ask } from '../state/useAsk';
import { useVoice } from '../state/useAsk';
import type { App } from '../state/useApp';
import { Banner, Filmstrip, Icon, Prose, Thinking, Ts } from '../ui';

const PENDING_LABEL: Record<string, string> = {
  lost: "I'm lost",
  'explain-screen': 'Explain this screen',
  extract: 'Extract from screen',
  walkthrough: 'Walk me through it',
  recap: 'Where was I?',
  goal: 'Goal',
  primer: 'Primer',
  question: '',
};

/** Follows new text only while the reader is at the bottom; scrolling up stops it until they return. */
function useStickToBottom(scrollRef: RefObject<HTMLElement>, deps: unknown[], resetKey: unknown) {
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef.current]);
  useEffect(() => {
    stick.current = true; // a new question starts following again
  }, [resetKey]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, deps);
}

export function AskView({ app, ask, scrollRef }: { app: App; ask: Ask; scrollRef: RefObject<HTMLElement> }) {
  const p = ask.pending;
  useStickToBottom(scrollRef, [p?.text, p?.thinking, app.data.history.length], p?.req.reqId);
  const history = app.data.history.slice(-30);
  return (
    <div class="thread">
      {history.length === 0 && !p && (
        <div class="empty">
          <h2>Ask about this moment</h2>
          <p class="small">The tutor sees the captions around now and the frame below. Click the frame to point at part of it; pick an earlier frame for questions about a previous screen.</p>
        </div>
      )}
      {history.map((h) => (
        <div key={h.id}>
          <div class="q">
            <Ts t={h.at} onSeek={app.seek} />
            <span class="text">{h.question}</span>
            {h.hadCrop && <span class="pill">region</span>}
          </div>
          <div class="answer-wrap" style={{ marginTop: 6 }}>
            <Prose md={h.answer} onSeek={app.seek} />
          </div>
          {ask.alts[h.id] && (
            <div class="chips" style={{ marginTop: 8 }}>
              {ask.alts[h.id].map((a) => (
                <button type="button" class="chip" key={a} onClick={() => ask.ask('question', a)} disabled={ask.busy}>
                  {a}
                </button>
              ))}
            </div>
          )}
          <div class="answer-tools">
            {(['simpler', 'example', 'formal'] as Depth[]).map((d) => (
              <button type="button" key={d} class="btn ghost small" disabled={ask.busy} onClick={() => ask.ask('depth', '', { depth: d, parentId: h.id })}>
                {{ simpler: 'Simpler', example: 'Example', formal: 'Formal' }[d]}
              </button>
            ))}
          </div>
        </div>
      ))}
      {p && (
        <div>
          <div class="q">
            <Ts t={p.req.t} onSeek={app.seek} />
            <span class="text">{p.req.question || PENDING_LABEL[p.req.kind] || p.req.depth}</span>
            {!!p.req.earlierFrameIds?.length && <span class="pill">+ earlier frame</span>}
          </div>
          <div class="answer-wrap live" style={{ marginTop: 6 }}>
            {p.text ? <Prose md={p.req.kind === 'lost' ? p.text.replace(/\n\s*\**ALTERNATIVES[\s\S]*$/i, '') : p.text} onSeek={app.seek} /> : !p.error && <Thinking text={p.thinking} />}
            {p.error && (
              <Banner
                kind="error"
                action={
                  p.error.retryable ? (
                    <button type="button" class="btn small" onClick={() => ask.send({ ...p.req, reqId: uid('q') })}>
                      Retry
                    </button>
                  ) : ['no-key', 'auth', 'permission'].includes(p.error.code) ? (
                    <button type="button" class="btn small" onClick={() => chrome.runtime.openOptionsPage()}>
                      Settings
                    </button>
                  ) : (
                    <button type="button" class="btn ghost small" onClick={() => ask.setPending(null)}>
                      Dismiss
                    </button>
                  )
                }
              >
                {p.error.message}
              </Banner>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Composer({ app, ask }: { app: App; ask: Ask }) {
  const voice = useVoice(app.settings.voiceInput, (text) => ask.setDraft(text));
  const range = defaultCaptionRange(app.t, app.duration);
  const earlierFrames = app.data.frames.filter((f) => f.kind !== 'ask' && f.t < app.t - 5);
  const holdKey = (e: KeyboardEvent) => e.altKey && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV');
  return (
    <div class="composer">
      {app.view === 'ask' && (
        <>
          <div class="context-chips" aria-label="What the tutor will see">
            {ask.frame ? (
              <span class={`ctx ${ask.includeFrame ? '' : 'off'}`}>
                <img src={ask.frame.dataUrl} alt={`Frame at ${formatTime(ask.frame.t)}`} title="Click to point at part of the frame" onClick={() => ask.setSelecting(true)} />
                <span>Frame {formatTime(ask.frame.t)}</span>
                <button type="button" class="x" title="Re-capture the frame now" aria-label="Re-capture frame" onClick={() => ask.capture()}>
                  <Icon.refresh />
                </button>
                <button type="button" class="x" title={ask.includeFrame ? 'Do not send the frame' : 'Send the frame'} aria-label="Toggle frame" onClick={() => ask.setIncludeFrame(!ask.includeFrame)}>
                  {ask.includeFrame ? '×' : '+'}
                </button>
              </span>
            ) : (
              <button type="button" class="ctx" onClick={() => ask.capture()} title="Capture the current frame">
                <span style={{ padding: '4px 6px' }}>+ Capture frame</span>
              </button>
            )}
            {ask.crop && (
              <span class="ctx">
                <img src={ask.crop.dataUrl} alt="Selected region" />
                <span>Region</span>
                <button type="button" class="x" aria-label="Remove region" onClick={() => ask.setCrop(null)}>
                  ×
                </button>
              </span>
            )}
            {app.captions.state === 'ready' && (
              <span class={`ctx ${ask.includeCaptions ? '' : 'off'}`} style={{ padding: '4px 4px 4px 8px' }}>
                <span>
                  Captions {formatTime(range[0])}–{formatTime(range[1])}
                </span>
                <button type="button" class="x" aria-label="Toggle captions" onClick={() => ask.setIncludeCaptions(!ask.includeCaptions)}>
                  {ask.includeCaptions ? '×' : '+'}
                </button>
              </span>
            )}
            {ask.earlier.size > 0 && <span class="ctx" style={{ padding: '4px 8px' }}>+ {ask.earlier.size} earlier frame{ask.earlier.size > 1 ? 's' : ''}</span>}
            {ask.frame?.lowQuality && <span class="ctx warn">{ask.frame.qualityLabel}: small text may be unreadable. Raise the quality in the player.</span>}
            {ask.frame?.via === 'tab' && <span class="ctx warn">Screenshot fallback (player overlays may show)</span>}
            {ask.frameErr && <span class="ctx err">{ask.frameErr}</span>}
          </div>
          {earlierFrames.length > 0 && (
            <details>
              <summary class="small muted">Attach an earlier frame ({earlierFrames.length} kept)</summary>
              <Filmstrip frames={earlierFrames} selected={ask.earlier} onPick={(f) => ask.toggleEarlier(f.id)} label="Earlier frames to attach" />
            </details>
          )}
          <div class="quick">
            <button type="button" class="btn ghost small" disabled={ask.busy} onClick={() => ask.ask('lost', '')}>
              I'm lost
            </button>
            <button type="button" class="btn ghost small" disabled={ask.busy} onClick={() => ask.ask('explain-screen', ask.draft.trim())}>
              Explain screen
            </button>
            <button type="button" class="btn ghost small" disabled={ask.busy} onClick={() => ask.ask('walkthrough', '')}>
              Walk me through it
            </button>
            <button type="button" class="btn ghost small" disabled={ask.busy} onClick={() => ask.ask('extract', '')}>
              Extract code / LaTeX
            </button>
          </div>
        </>
      )}
      {voice.error && <span class="ctx err">{voice.error}</span>}
      <div class="input-row">
        <label class="sr-only" for="q">
          Your question
        </label>
        <textarea
          id="q"
          ref={ask.inputRef}
          rows={1}
          value={ask.draft}
          placeholder={voice.listening ? 'Listening…' : ask.crop ? 'Ask about the selected region… (or just send)' : 'Ask about this moment…'}
          onFocus={() => {
            app.typingRef.current = true;
            if (app.view === 'watch') {
              app.setView('ask');
              if (!ask.frame) ask.capture();
            }
          }}
          onBlur={() => (app.typingRef.current = false)}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            ask.setDraft(el.value);
            el.style.height = 'auto';
            el.style.height = `${Math.min(160, el.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (voice.supported && holdKey(e) && !e.repeat) {
              e.preventDefault();
              voice.start();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (!ask.busy) ask.submitDraft();
            }
          }}
          onKeyUp={(e) => {
            if (voice.listening && (e.key === 'Alt' || e.key === 'v' || e.key === 'V')) voice.stop();
          }}
        />
        {voice.supported && (
          <button
            type="button"
            class={`btn mic ${voice.listening ? 'on' : ''}`}
            title="Hold to dictate (or hold Alt+V in the question box)"
            aria-label="Hold to dictate"
            onPointerDown={() => voice.start()}
            onPointerUp={() => voice.stop()}
            onPointerLeave={() => voice.listening && voice.stop()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        )}
        {ask.busy ? (
          <button type="button" class="btn" onClick={() => ask.pending && app.port.cancel(ask.pending.req.reqId)}>
            Stop
          </button>
        ) : (
          <button type="button" class="btn primary" aria-label="Send" disabled={!ask.draft.trim() && !ask.crop} onClick={ask.submitDraft}>
            <Icon.send />
          </button>
        )}
      </div>
    </div>
  );
}
