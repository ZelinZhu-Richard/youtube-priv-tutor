// Side-panel controller: which tab, the content-script connection, the current video's stored data,
// player events, confusion signals, smart speed, keyboard commands and streaming jobs. Views get the
// returned object and stay presentational.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { skipTarget, type TimedItem } from '../../shared/checkpoints';
import { currentChapter, currentSectionIndex, conceptsNear } from '../../shared/context';
import * as db from '../../shared/db';
import type { LearnerEvent } from '../../shared/learner';
import type { Broadcast, CommandAction, DoneResult, PlayerState, PortRequest, TutorError, VideoState } from '../../shared/messages';
import { ensureMigrated } from '../../shared/migrate';
import * as records from '../../shared/records';
import { sendToBackground, sendToContent, uid } from '../../shared/rpc';
import { DEFAULT_SETTINGS, KEYS, normalizeSettings, type Settings } from '../../shared/settings';
import { detectRewindConfusion, pauseConfusion, sectionDensity, suggestRate, type SeekEvent } from '../../shared/signals';
import { formatTime } from '../../shared/time';
import * as store from '../../shared/store';
import type { Bookmark, CaptionStatus, HistoryEntry, Mistake, PracticeProblem, StoredFrame, Transcript, VideoRecord } from '../../shared/types';
import { TutorPort } from '../port';

export type View = 'watch' | 'ask' | 'practice' | 'review' | 'transcript' | 'queue';

export interface Job {
  reqId: string;
  text: string;
  thinking: string;
  result?: DoneResult;
  error?: TutorError;
}

export interface VideoData {
  video: VideoRecord | null;
  history: HistoryEntry[];
  bookmarks: Bookmark[];
  frames: StoredFrame[];
  mistakes: Mistake[];
  problems: PracticeProblem[];
}
const EMPTY: VideoData = { video: null, history: [], bookmarks: [], frames: [], mistakes: [], problems: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useApp() {
  const port = useMemo(() => new TutorPort(), []);
  const [tab, setTab] = useState<{ id: number; url: string } | null>(null);
  const [content, setContent] = useState<'unknown' | 'ok' | 'missing'>('unknown');
  const [vs, setVs] = useState<VideoState | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [captions, setCaptions] = useState<CaptionStatus>({ state: 'idle' });
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keyInfo, setKeyInfo] = useState<{ hasKey: boolean; hint: string } | null>(null);
  const [data, setData] = useState<VideoData>(EMPTY);
  const [loadedVid, setLoadedVid] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [view, setViewState] = useState<View>('watch');
  const [notice, setNotice] = useState<string | null>(null);
  const [due, setDue] = useState(0);
  const [confusion, setConfusion] = useState<{ from: number; to: number; why: string } | null>(null);
  const [speed, setSpeed] = useState<{ section: number; rate: number; reason: string; base: number } | null>(null);
  const manualAt = useRef(0);
  const pendingCommand = useRef<CommandAction | null>(null);
  const commandHandler = useRef<(a: CommandAction) => void>(() => undefined);
  const saved = useRef({ progress: 0, watched: 0, spent: 0, lastTick: 0 });
  const seeks = useRef<SeekEvent[]>([]);
  const pausedAt = useRef<number | null>(null);
  const baseRate = useRef<number | null>(null);

  const videoId = vs?.videoId ?? null;
  /** The video on screen now; lets late async work for a previous video be dropped. */
  const currentVideo = useRef(videoId);
  currentVideo.current = videoId;
  const meta = vs?.meta ?? null;
  const video = data.video;
  const map = video?.map ?? null;
  const t = player?.t ?? 0;
  const duration = player?.duration || meta?.lengthSeconds || 0;
  const known = useMemo(() => new Set(video?.known ?? []), [video?.known]);
  const doneIds = useMemo(() => new Set((video?.checkpointResults ?? []).map((r) => r.checkpointId)), [video?.checkpointResults]);
  const sectionIdx = map ? currentSectionIndex(map.sections, t) : -1;
  const section = sectionIdx >= 0 && map ? map.sections[sectionIdx] : null;
  const chapter = meta ? currentChapter(meta.chapters, t) : null;

  const setView = (v: View, manual = true) => {
    if (manual) manualAt.current = Date.now();
    setViewState(v);
  };

  const cs = useCallback(
    <M extends Parameters<typeof sendToContent>[1]>(msg: M) => (tab ? sendToContent(tab.id, msg) : Promise.reject(new Error('No YouTube tab'))),
    [tab],
  );
  const seek = useCallback((s: number) => void cs({ type: 'cs/seek', t: s }).catch(() => undefined), [cs]);

  // ---------- jobs (streaming requests other than questions) ----------
  const runJob = useCallback(
    (key: string, req: Exclude<PortRequest, { type: 'ping' } | { type: 'cancel' } | { type: 'ask' }>, onDone?: (r: DoneResult) => void) => {
      const reqId = req.reqId;
      const upd = (f: (j: Job) => Job) => setJobs((all) => (all[key]?.reqId === reqId ? { ...all, [key]: f(all[key]) } : all));
      setJobs((all) => ({ ...all, [key]: { reqId, text: '', thinking: '' } }));
      port.request(req, {
        onThinking: (d) => upd((j) => ({ ...j, thinking: j.thinking + d })),
        onDelta: (d) => upd((j) => ({ ...j, text: j.text + d })),
        onDone: (res, info) => {
          upd((j) => ({ ...j, result: res }));
          if (info.truncated) setNotice('The answer hit the length limit and was cut off.');
          onDone?.(res);
        },
        onError: (error) => upd((j) => ({ ...j, error })),
      });
    },
    [port],
  );
  const clearJob = (key: string) => setJobs(({ [key]: _, ...rest }) => rest);

  // ---------- settings, key, migration ----------
  const refreshKey = () => sendToBackground({ type: 'bg/has-key' }).then(setKeyInfo).catch(() => setKeyInfo({ hasKey: false, hint: '' }));
  const refreshDue = () => db.dueCardsFromDb().then((c) => setDue(c.length)).catch(() => undefined);
  useEffect(() => {
    store.getSettings().then(setSettings);
    refreshKey();
    ensureMigrated().catch(() => undefined).finally(refreshDue);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes[KEYS.settings]) setSettings(normalizeSettings(changes[KEYS.settings].newValue));
      if (changes[KEYS.apiKey]) refreshKey(); // never read the key itself here
    };
    chrome.storage.onChanged.addListener(onChange);
    const timer = setInterval(refreshDue, 60_000);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(timer);
    };
  }, []);

  // ---------- which tab ----------
  useEffect(() => {
    let wid: number | null = null;
    const update = async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id !== undefined) setTab((cur) => (cur && cur.id === active.id && cur.url === (active.url ?? '') ? cur : { id: active.id!, url: active.url ?? '' }));
    };
    chrome.windows.getCurrent().then((w) => (wid = w.id ?? null));
    update();
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (wid === null || info.windowId === wid) update();
    };
    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (change.url) setTab((cur) => (cur && cur.id === id ? { id, url: change.url! } : cur));
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const isYouTube = !!tab && /^https:\/\/www\.youtube\.com\//.test(tab.url);

  useEffect(() => {
    if (!tab || !isYouTube) {
      setContent('unknown');
      setVs(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let ok = await sendToContent(tab.id, { type: 'cs/ping' }).then(() => true, () => false);
      if (!ok) {
        const r = await sendToBackground({ type: 'bg/inject', tabId: tab.id }).catch(() => ({ ok: false }));
        if (r.ok) {
          await sleep(400);
          ok = await sendToContent(tab.id, { type: 'cs/ping' }).then(() => true, () => false);
        }
      }
      if (cancelled) return;
      setContent(ok ? 'ok' : 'missing');
      if (!ok) return;
      for (let i = 0; i < 10 && !cancelled; i++) {
        const st = await sendToContent(tab.id, { type: 'cs/get-state' }).catch(() => null);
        if (st) {
          setVs(st);
          setPlayer(st.player);
          setCaptions(st.captions);
          if (!st.videoId || st.meta) break;
        }
        await sleep(600);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab?.id, tab?.url]);

  // ---------- stored data for the current video ----------
  /** Reloads the current video's stored data; with `kinds`, only those stores (frames change every ~15 s). */
  const reload = useCallback(async (vid: string, kinds?: string[]) => {
    const want = (k: string) => !kinds || kinds.includes(k);
    const [v, history, bookmarks, frames, mistakes, problems] = await Promise.all([
      want('video') || want('cards') ? db.getVideo(vid) : undefined,
      want('history') ? db.byVideo('history', vid) : undefined,
      want('bookmarks') ? db.byVideo('bookmarks', vid) : undefined,
      want('frames') || want('bookmarks') ? db.byVideo('frames', vid) : undefined,
      want('mistakes') || want('cards') ? db.byVideo('mistakes', vid) : undefined,
      want('problems') ? db.byVideo('problems', vid) : undefined,
    ]);
    // A request started for a previous video can finish after navigation; never install its data.
    if (currentVideo.current !== vid) return;
    setData((d) => ({
      video: v === undefined ? d.video : v,
      history: history ? history.sort((a, b) => a.createdAt - b.createdAt) : d.history,
      bookmarks: bookmarks ? bookmarks.sort((a, b) => a.t - b.t) : d.bookmarks,
      frames: frames ? frames.sort((a, b) => a.t - b.t) : d.frames,
      mistakes: mistakes ? mistakes.sort((a, b) => b.createdAt - a.createdAt) : d.mistakes,
      problems: problems ? problems.sort((a, b) => a.createdAt - b.createdAt || a.level - b.level) : d.problems,
    }));
  }, []);

  useEffect(() => {
    setData(EMPTY);
    setLoadedVid(null);
    setJobs({});
    setTranscript(null);
    setCaptions({ state: 'idle' });
    setConfusion(null);
    // An unanswered checkpoint belongs to the video it fired on.
    setCheckpointHit(null);
    setSpeed(null);
    baseRate.current = null;
    seeks.current = [];
    saved.current = { progress: 0, watched: 0, spent: 0, lastTick: 0 };
    if (!videoId) return;
    let cancelled = false;
    (async () => {
      await ensureMigrated().catch(() => undefined);
      await reload(videoId);
      if (cancelled) return;
      setLoadedVid(videoId);
      cs({ type: 'cs/engage', frameBuffer: settings.frameBuffer }).catch(() => undefined);
      const status = await cs({ type: 'cs/ensure-captions' }).catch(() => null);
      if (!cancelled && status) setCaptions(status);
    })();
    chrome.storage.session.get(KEYS.pendingCommand).then((r) => {
      const p = r[KEYS.pendingCommand] as { action: CommandAction; tabId: number; at: number } | undefined;
      if (p && tab && p.tabId === tab.id && Date.now() - p.at < 10_000) {
        chrome.storage.session.remove(KEYS.pendingCommand).catch(() => undefined);
        pendingCommand.current = p.action;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // The content script buffers frames only while the panel keeps checking in, so closing the panel
  // or switching to another tab stops it within a minute.
  useEffect(() => {
    if (!videoId) return;
    const beat = () => void cs({ type: 'cs/engage', frameBuffer: settings.frameBuffer }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, 20_000);
    return () => clearInterval(timer);
  }, [videoId, cs, settings.frameBuffer]);

  useEffect(() => {
    if (videoId && captions.state === 'ready') db.get('transcripts', videoId).then((tr) => setTranscript(tr && tr.videoId === videoId ? tr : null));
  }, [videoId, captions.state]);

  // §12.1: prepare the lesson automatically when the panel is open on a video with captions.
  useEffect(() => {
    if (settings.prepareLessonAutomatically && keyInfo?.hasKey && videoId && loadedVid === videoId && meta?.videoId === videoId && captions.state === 'ready' && !map && !jobs.map) {
      runJob('map', { type: 'map', reqId: uid('m'), videoId });
    }
  }, [settings.prepareLessonAutomatically, keyInfo?.hasKey, videoId, loadedVid, meta, captions.state, map, jobs.map]);

  // Arm checkpoints in the content script (§12.4).
  useEffect(() => {
    if (!videoId || content !== 'ok') return;
    const items: TimedItem[] = (map?.checkpoints ?? []).filter((c) => !known.has(c.sectionIndex)).map((c) => ({ id: c.id, at: c.at }));
    cs({ type: 'cs/arm-checkpoints', videoId, mode: settings.checkpointMode, items, done: [...doneIds] }).catch(() => undefined);
  }, [videoId, content, map, settings.checkpointMode, known, doneIds]);

  // ---------- broadcasts ----------
  const [checkpointHit, setCheckpointHit] = useState<{ id: string; paused: boolean } | null>(null);
  useEffect(() => {
    const onMsg = (msg: Broadcast, sender: chrome.runtime.MessageSender) => {
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('evt/')) return;
      if (msg.type === 'evt/data') {
        if (msg.kinds.includes('cards')) refreshDue();
        if (videoId && (msg.videoId === videoId || msg.videoId === null)) reload(videoId, msg.kinds);
        return;
      }
      if (msg.type === 'evt/command') {
        if (tab && msg.tabId === tab.id) {
          chrome.storage.session.remove(KEYS.pendingCommand).catch(() => undefined);
          pendingCommand.current = msg.action;
          if (videoId && meta) {
            pendingCommand.current = null;
            commandHandler.current(msg.action);
          }
        }
        return;
      }
      if (!tab || sender.tab?.id !== tab.id) return;
      switch (msg.type) {
        case 'evt/video':
          setVs((cur) => ({ url: cur?.url ?? '', videoId: msg.videoId, meta: msg.meta ?? (cur?.videoId === msg.videoId ? cur.meta : null), captions: { state: 'idle' }, player: cur?.player ?? null }));
          break;
        case 'evt/captions':
          if (msg.videoId === videoId || !videoId) setCaptions(msg.status);
          break;
        case 'evt/player':
          if (msg.videoId === videoId) setPlayer(msg.player);
          break;
        case 'evt/seek':
          if (msg.videoId === videoId) onSeekEvent({ from: msg.from, to: msg.to, at: msg.at });
          break;
        case 'evt/checkpoint':
          if (msg.videoId === videoId) {
            setCheckpointHit({ id: msg.id, paused: msg.paused });
            if (msg.paused) setView('watch');
          }
          break;
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  });

  // ---------- learner model ----------
  const learn = useCallback(
    async (ev: LearnerEvent) => {
      if (!videoId) return;
      const v = await records.learn(videoId, ev);
      setData((d) => (d.video?.videoId === videoId ? { ...d, video: v } : d));
    },
    [videoId],
  );

  const updateVideo = useCallback(
    async (fn: (v: VideoRecord) => Partial<VideoRecord>) => {
      if (!videoId) return;
      const v = await db.updateVideo(videoId, fn);
      setData((d) => (d.video?.videoId === videoId ? { ...d, video: v } : d));
      records.notifyChanged(videoId, ['video']);
    },
    [videoId],
  );

  // ---------- confusion signals (§13.2) ----------
  function confusionAllowed() {
    return settings.checkpointMode !== 'off';
  }
  function onSeekEvent(e: SeekEvent) {
    seeks.current = [...seeks.current.filter((s) => e.at - s.at < 5 * 60_000), e];
    const hit = detectRewindConfusion(seeks.current, e.at);
    if (hit && confusionAllowed() && !confusion) {
      seeks.current = [];
      setConfusion({ ...hit, why: 'rewound' });
      learn({ type: 'lost', concepts: conceptsNear(map, (hit.from + hit.to) / 2, hit.to - hit.from + 30, 5), note: `rewound ${formatTime(hit.from)}–${formatTime(hit.to)} twice` });
    }
  }

  // Long pause on a dense frame. Called on player events and, because a paused player sends no
  // events, on a timer while paused. Fires at most once per pause.
  const pauseFlagged = useRef(false);
  function checkLongPause() {
    if (!player?.paused || player.ended || pausedAt.current === null || pauseFlagged.current) return;
    if (!confusionAllowed() || confusion) return;
    if (!pauseConfusion((Date.now() - pausedAt.current) / 1000, player.density ?? null)) return;
    pauseFlagged.current = true;
    setConfusion({ from: Math.max(0, player.t - 60), to: player.t, why: 'paused' });
    learn({ type: 'lost', concepts: conceptsNear(map, player.t), note: `long pause at ${formatTime(player.t)}` });
  }
  const longPause = useRef(checkLongPause);
  longPause.current = checkLongPause;
  useEffect(() => {
    if (!player?.paused || player.ended || !videoId || loadedVid !== videoId) return;
    const timer = setInterval(() => longPause.current(), 5000);
    return () => clearInterval(timer);
  }, [player?.paused, player?.ended, videoId, loadedVid]);

  // ---------- player-driven state (§12.2), progress, time spent, signals, smart speed ----------
  const prevPlayer = useRef<PlayerState | null>(null);
  useEffect(() => {
    const prev = prevPlayer.current;
    prevPlayer.current = player;
    if (!player || !videoId || loadedVid !== videoId) return;
    const now = Date.now();
    // Time spent: wall-clock while playing, counted from player updates (about 1/s).
    const tick = saved.current.lastTick;
    saved.current.lastTick = now;
    if (!player.paused && tick && now - tick < 5000) saved.current.spent += (now - tick) / 1000;
    if (now - saved.current.progress > 10_000 && player.t > 5) {
      saved.current.progress = now;
      const add = Math.floor(saved.current.spent);
      saved.current.spent -= add;
      updateVideo((v) => ({ lastT: player.t, timeSpentSec: v.timeSpentSec + add }));
    }
    if (map && now - saved.current.watched > 15_000) {
      saved.current.watched = now;
      learn({ type: 'watched', t: player.t });
    }
    // Long pause on a dense frame.
    if (player.paused && !player.ended) {
      pausedAt.current ??= now;
      checkLongPause();
    } else {
      pausedAt.current = null;
      pauseFlagged.current = false;
    }
    // Smart speed: on entering a section, apply its suggested rate (setting on only).
    if (settings.smartSpeed && map && sectionIdx >= 0 && !player.paused && speed?.section !== sectionIdx) {
      baseRate.current ??= player.rate || 1;
      const shaky = map.concepts.some((c) => c.definedAt !== null && c.definedAt >= map.sections[sectionIdx].start && c.definedAt < map.sections[sectionIdx].end && video?.learner.concepts[c.name]?.state === 'shaky');
      const s = suggestRate({ known: known.has(sectionIdx), shaky, density: sectionDensity(map, sectionIdx), base: baseRate.current });
      setSpeed({ section: sectionIdx, rate: s.rate, reason: s.reason, base: baseRate.current });
      if (Math.abs(s.rate - player.rate) > 0.01) cs({ type: 'cs/set-rate', rate: s.rate }).catch(() => undefined);
    }
    if (!prev) return;
    const recentlyManual = now - manualAt.current < 8000;
    if (player.ended && !prev.ended) setView('review', false);
    else if (player.paused && !prev.paused && !player.ended) {
      if (view === 'watch' && !checkpointHit?.paused) setView('ask', false);
    } else if (!player.paused && prev.paused) {
      if (!recentlyManual && view === 'ask' && !askBusyRef.current && !typingRef.current) setView('watch', false);
    }
  }, [player]);

  // Smart speed switched off: restore the learner's own rate.
  useEffect(() => {
    if (!settings.smartSpeed && baseRate.current !== null) {
      cs({ type: 'cs/set-rate', rate: baseRate.current }).catch(() => undefined);
      baseRate.current = null;
      setSpeed(null);
    }
  }, [settings.smartSpeed]);

  const askBusyRef = useRef(false);
  const typingRef = useRef(false);

  const skip = map ? skipTarget(map.sections, known, t) : null;

  return {
    port,
    tab,
    isYouTube,
    content,
    vs,
    videoId,
    meta,
    player,
    t,
    duration,
    captions,
    setCaptions,
    transcript,
    settings,
    keyInfo,
    data,
    video,
    map,
    known,
    doneIds,
    section,
    sectionIdx,
    chapter,
    skip,
    view,
    setView,
    notice,
    setNotice,
    due,
    refreshDue,
    jobs,
    runJob,
    clearJob,
    cs,
    seek,
    learn,
    updateVideo,
    reload: () => (videoId ? reload(videoId) : Promise.resolve()),
    confusion,
    setConfusion,
    speed,
    checkpointHit,
    setCheckpointHit,
    pendingCommand,
    commandHandler,
    askBusyRef,
    typingRef,
  };
}

export type App = ReturnType<typeof useApp>;
