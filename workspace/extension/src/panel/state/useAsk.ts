// Asking: context chips (frame, crop, caption range, earlier frames), sending, streaming, retry,
// keyboard commands, and voice input.
import { useEffect, useRef, useState } from 'preact/hooks';
import { conceptsNear, defaultCaptionRange } from '../../shared/context';
import { detectBackwardReference, nearestFrame, previousDistinct, hashedFrames } from '../../shared/frames';
import { splitDataUrl, type Rect } from '../../shared/image';
import type { AskRequest, CommandAction, FrameResult, TutorError } from '../../shared/messages';
import { uid } from '../../shared/rpc';
import { formatTime } from '../../shared/time';
import type { AskKind, Depth } from '../../shared/types';
import type { App } from './useApp';

export type FrameOk = Extract<FrameResult, { ok: true }>;

export interface Pending {
  req: AskRequest;
  text: string;
  thinking: string;
  error: TutorError | null;
}

/** Kinds that are about the screen and cannot be answered without the frame. */
const SCREEN_KINDS: AskKind[] = ['explain-screen', 'extract'];

export function useAsk(app: App) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [alts, setAlts] = useState<Record<string, string[]>>({});
  const [frame, setFrame] = useState<FrameOk | null>(null);
  const [frameErr, setFrameErr] = useState<string | null>(null);
  const [includeFrame, setIncludeFrame] = useState(true);
  const [includeCaptions, setIncludeCaptions] = useState(true);
  const [crop, setCrop] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [draft, setDraft] = useState('');
  const [earlier, setEarlier] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deltaBuf = useRef('');
  const raf = useRef(0);

  useEffect(() => {
    setPending(null);
    setAlts({});
    setFrame(null);
    setFrameErr(null);
    setCrop(null);
    setEarlier(new Set());
  }, [app.videoId]);

  const busy = !!pending && !pending.error;
  app.askBusyRef.current = busy;

  async function capture(): Promise<{ frame: FrameOk | null; error: string | null }> {
    setFrameErr(null);
    const r: FrameResult = await app.cs({ type: 'cs/capture-frame' }).catch((e) => ({ ok: false, reason: 'error', message: String(e) }) as FrameResult);
    if (r.ok) {
      setFrame(r);
      setCrop(null);
      return { frame: r, error: null };
    }
    setFrame(null);
    setFrameErr(r.message);
    return { frame: null, error: r.message };
  }

  // Entering the Ask view while paused captures the frame for the context chips (local only).
  const prevView = useRef(app.view);
  useEffect(() => {
    if (app.view === 'ask' && prevView.current !== 'ask' && app.player?.paused && (!frame || Math.abs(frame.t - app.t) > 1.5)) capture();
    prevView.current = app.view;
  }, [app.view]);

  /** Earlier stored frames for a question that points back (§13.2), unless the learner picked some. */
  function earlierFor(question: string, now: number): string[] {
    if (earlier.size) return [...earlier];
    const ref = detectBackwardReference(question);
    if (!ref) return [];
    const frames = app.data.frames;
    if (ref.kind === 'time') {
      const f = nearestFrame(frames, ref.t, 45);
      return f && Math.abs(f.t - now) > 5 ? [f.id] : [];
    }
    // Slide changes are counted by comparing hashes, so only frames with a real hash take part.
    const hashed = hashedFrames(frames);
    const current = nearestFrame(hashed.filter((f) => f.t <= now + 1), now, 30);
    const f = previousDistinct(hashed, now, current?.hash ?? null, ref.steps);
    return f ? [f.id] : [];
  }

  async function ask(kind: AskKind, question: string, opts: { depth?: Depth; parentId?: string } = {}) {
    const { videoId, meta } = app;
    if (!videoId || !meta) return;
    if (!app.keyInfo?.hasKey) {
      app.setNotice('Add your Anthropic API key in Settings first.');
      return;
    }
    if (busy) return;
    // The frame chip is the learner's choice of what gets sent; never override it silently.
    if (!includeCaptions && kind === 'lost') {
      app.setView('ask');
      app.setNotice('"I\'m lost" works from the captions, and you chose not to send them. Turn captions back on to use it.');
      return;
    }
    if (!includeFrame && SCREEN_KINDS.includes(kind)) {
      app.setView('ask');
      app.setNotice('This needs the frame, and you chose not to send it. Turn the frame back on to use it.');
      return;
    }
    app.setView('ask');
    const st = await app.cs({ type: 'cs/get-state' }).catch(() => null);
    const p = st?.player ?? app.player;
    const now = p?.t ?? app.t;
    const dur = p?.duration || meta.lengthSeconds;
    let f: FrameOk | null = null;
    let frameNote: string | null = null;
    /** A selected region belongs to the frame it was drawn on; a fresh capture invalidates it. */
    let cropValid = true;
    const textOnly = kind === 'depth' || kind === 'goal' || kind === 'recap' || kind === 'primer';
    if (!textOnly && includeFrame) {
      if (frame && Math.abs(frame.t - now) < 1.5) f = frame;
      else {
        cropValid = false;
        const r = await capture();
        f = r.frame;
        if (!f) frameNote = r.error ?? 'the frame could not be captured';
      }
      if (f?.lowQuality) frameNote = `The player is at ${f.qualityLabel}; small on-screen text may be unreadable.`;
    } else if (!textOnly) frameNote = 'the learner removed it';
    const fp = f ? splitDataUrl(f.dataUrl) : null;
    const cp = crop && cropValid && f && !textOnly ? splitDataUrl(crop.dataUrl) : null;
    const wantCaptions = includeCaptions && !textOnly;
    const req: AskRequest = {
      type: 'ask',
      reqId: uid('q'),
      videoId,
      kind,
      question,
      t: now,
      paused: p?.paused ?? true,
      frame: f && fp ? { mediaType: fp.mediaType as 'image/jpeg', data: fp.data, width: f.width, height: f.height, qualityLabel: f.qualityLabel } : null,
      frameNote,
      crop: cp && crop ? { mediaType: cp.mediaType as 'image/png', data: cp.data, width: crop.width, height: crop.height } : null,
      captionRange: wantCaptions && app.captions.state === 'ready' ? defaultCaptionRange(now, dur) : null,
      includeTranscript: includeCaptions,
      depth: opts.depth,
      parentId: opts.parentId,
      fallbackLanguage: navigator.language || 'English',
      earlierFrameIds: textOnly ? [] : earlierFor(question, now),
      keepFrame: true,
    };
    if (kind === 'lost') app.learn({ type: 'lost', concepts: conceptsNear(app.map, now), note: `I'm lost at ${formatTime(now)}` });
    if (kind === 'depth' && opts.depth === 'simpler') {
      const parent = app.data.history.find((h) => h.id === opts.parentId);
      if (parent) app.learn({ type: 'simpler', concepts: parent.concepts, note: `Simpler at ${formatTime(parent.at)}` });
    }
    send(req);
  }

  function send(req: AskRequest) {
    setPending({ req, text: '', thinking: '', error: null });
    deltaBuf.current = '';
    const reqId = req.reqId;
    app.port.request(req, {
      onThinking: (d) => setPending((pp) => (pp && pp.req.reqId === reqId ? { ...pp, thinking: pp.thinking + d } : pp)),
      onDelta: (d) => {
        deltaBuf.current += d;
        if (raf.current) return;
        raf.current = requestAnimationFrame(() => {
          raf.current = 0;
          const add = deltaBuf.current;
          deltaBuf.current = '';
          setPending((pp) => (pp && pp.req.reqId === reqId ? { ...pp, text: pp.text + add } : pp));
        });
      },
      onDone: async (res, info) => {
        if (res.kind !== 'ask') return;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        if (res.alternatives.length) setAlts((a) => ({ ...a, [res.entry.id]: res.alternatives }));
        await app.reload();
        app.learn({ type: 'asked', concepts: res.entry.concepts });
        setPending(null);
        setCrop(null);
        setEarlier(new Set());
        if (info.truncated) app.setNotice('The answer hit the length limit and was cut off.');
      },
      onError: (error) => {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        if (error.code === 'aborted') setPending(null);
        else setPending((pp) => (pp && pp.req.reqId === reqId ? { ...pp, error } : pp));
      },
    });
  }

  function submitDraft() {
    const q = draft.trim();
    if (!q && !crop) return;
    setDraft('');
    ask('question', q || 'Explain this.');
  }

  async function applyRegion(rect: Rect) {
    setSelecting(false);
    if (!frame) return;
    const r = await app.cs({ type: 'cs/crop', captureId: frame.captureId, rect }).catch((e) => ({ ok: false as const, message: String(e) }));
    if (r.ok) {
      setCrop({ dataUrl: r.dataUrl, width: r.width, height: r.height });
      setIncludeFrame(true);
      inputRef.current?.focus();
    } else setFrameErr(r.message);
  }

  function toggleEarlier(id: string) {
    setEarlier((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < 3) n.add(id);
      return n;
    });
  }

  // Keyboard commands from the service worker.
  app.commandHandler.current = (action: CommandAction) => {
    app.cs({ type: 'cs/pause' }).catch(() => undefined);
    if (action === 'ask-moment') {
      app.setView('ask');
      capture();
      setTimeout(() => inputRef.current?.focus(), 50);
    } else if (action === 'im-lost') ask('lost', '');
    else if (action === 'explain-screen') ask('explain-screen', '');
  };
  useEffect(() => {
    if (app.videoId && app.meta && app.pendingCommand.current) {
      const a = app.pendingCommand.current;
      app.pendingCommand.current = null;
      app.commandHandler.current(a);
    }
  }, [app.videoId, app.meta]);

  return {
    pending,
    setPending,
    alts,
    frame,
    frameErr,
    includeFrame,
    setIncludeFrame,
    includeCaptions,
    setIncludeCaptions,
    crop,
    setCrop,
    selecting,
    setSelecting,
    draft,
    setDraft,
    earlier,
    toggleEarlier,
    inputRef,
    busy,
    capture,
    ask,
    send,
    submitDraft,
    applyRegion,
  };
}

export type Ask = ReturnType<typeof useAsk>;

// ---------- voice input (§13.2), off unless enabled in Settings ----------

interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export function useVoice(enabled: boolean, onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRec | null>(null);
  const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec; SpeechRecognition?: new () => SpeechRec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
  const supported = enabled && !!Ctor;
  function start() {
    if (!supported || rec.current) return;
    setError(null);
    const r = new Ctor!();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((x) => x[0].transcript)
        .join('');
      onText(text, Array.from(e.results).every((x) => x.isFinal));
    };
    r.onerror = (e) => setError(e.error === 'not-allowed' ? 'Microphone access is blocked. Allow it from the Settings page (Voice input).' : `Speech recognition: ${e.error}`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    r.start();
    setListening(true);
  }
  function stop() {
    rec.current?.stop();
  }
  return { supported, listening, error, start, stop };
}
