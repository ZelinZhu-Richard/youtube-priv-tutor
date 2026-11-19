// Content script (isolated world). Detects the video and SPA navigation, runs the caption fallback
// chain (§3), captures frames (§4), reports player state, seeks, and pauses at checkpoints (§12.4).
import { normalizeCues, parseTimedText, removeRollingOverlap } from '../shared/captions';
import { crossedCheckpoints, type CheckpointMode, type TimedItem } from '../shared/checkpoints';
import {
  CONTENT_SOURCE,
  PAGE_SOURCE,
  type Broadcast,
  type ContentResponses,
  type FromPage,
  type PlayerData,
  type PlayerState,
  type ToContent,
  type ToPage,
  type VideoState,
} from '../shared/messages';
import { broadcast, sendToBackground, uid } from '../shared/rpc';
import type { CaptionStatus, Cue, Transcript, VideoMeta } from '../shared/types';
import {
  firstVisible,
  parsePlayerResponse,
  pickTrack,
  readTranscriptSegments,
  segmentsToCues,
  timedTextUrl,
  transcriptPanel,
  videoIdFromUrl,
  YT,
} from '../shared/youtube';
import { isNearDuplicate } from '../shared/frames';
import type { CommandAction } from '../shared/messages';
import { formatTime } from '../shared/time';
import { ensureAskButton, frameDensity, frameHash, frameJpeg, removeAskButton, showToast } from './extras';
import { captureFrame, clearCaptures, cropLast } from './frame';

/** API the on-demand fullscreen overlay (overlay.js, same isolated world) uses. */
export interface ContentApi {
  state: () => VideoState;
  capture: () => ReturnType<typeof captureFrame>;
  ensureCaptions: () => Promise<CaptionStatus>;
  findVideo: () => HTMLVideoElement | null;
  pause: () => void;
}

type Win = Window & { __ytTutorContent?: { alive: () => boolean }; __ytTutorApi?: ContentApi; __ytTutorOverlay?: { open: (action?: CommandAction) => void } };

// The isolated world outlives an extension reload, so a plain "already ran" flag would make a
// re-injected script do nothing while the old instance is dead. Run unless a live instance exists.
{
  const prev = (window as Win).__ytTutorContent;
  let prevAlive = false;
  try {
    prevAlive = !!prev?.alive();
  } catch {
    prevAlive = false;
  }
  if (!prevAlive) main();
}

function main() {
  // ---------- per-video state (reset on navigation) ----------
  let videoId: string | null = null;
  let meta: VideoMeta | null = null;
  let metaWaiters: ((m: VideoMeta | null) => void)[] = [];
  let captions: CaptionStatus = { state: 'idle' };
  let captionJob: Promise<CaptionStatus> | null = null;
  let checkpoints: { videoId: string; mode: CheckpointMode; items: TimedItem[]; done: Set<string> } | null = null;
  let lastT = 0;
  let generation = 0;
  let transcriptCues: Cue[] = [];
  /** Frames are buffered only while the panel (or overlay) has checked in recently. */
  let engagedUntil = 0;
  const ENGAGE_MS = 45_000;
  let frameBuffer = true;
  let recentHashes: string[] = [];
  let lastSample = 0;
  let pauseDensity: number | null = null;

  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const send = (msg: Broadcast) => alive() && broadcast(msg);
  (window as Win).__ytTutorContent = { alive };
  // Leftovers from a dead instance are wired to its dead handlers; start clean.
  removeAskButton();
  document.getElementById('yt-tutor-overlay')?.remove();
  delete (window as Win).__ytTutorOverlay;

  // ---------- page-world bridge ----------
  const pending = new Map<string, (msg: FromPage) => void>();
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const msg = e.data as FromPage | undefined;
    if (!msg || msg.source !== PAGE_SOURCE) return;
    if (msg.type === 'navigated') {
      onNavigate(msg.data);
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  type PageRequest = ToPage extends infer T ? (T extends { id: string } ? Omit<T, 'id' | 'source'> : never) : never;
  function page<T extends FromPage['type']>(req: PageRequest & { type: T }, timeoutMs = 3000): Promise<Extract<FromPage, { type: T }> | null> {
    const id = uid('p');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as Extract<FromPage, { type: T }>);
      });
      window.postMessage({ ...req, id, source: CONTENT_SOURCE } as ToPage, location.origin);
    });
  }

  // ---------- video element and player state ----------
  function findVideo(): HTMLVideoElement | null {
    for (const sel of YT.videoSelectors) {
      const v = document.querySelector<HTMLVideoElement>(sel);
      if (v) return v;
    }
    return null;
  }

  const adShowing = () => !!document.querySelector(YT.playerSelector)?.classList.contains(YT.adShowingClass);

  function playerState(): PlayerState | null {
    const v = findVideo();
    if (!v) return null;
    return {
      t: v.currentTime,
      paused: v.paused,
      ended: v.ended,
      duration: Number.isFinite(v.duration) ? v.duration : meta?.lengthSeconds ?? 0,
      rate: v.playbackRate,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      density: v.paused ? pauseDensity : null,
    };
  }

  let lastSent = 0;
  function reportPlayer(force = false) {
    if (!videoId || adShowing()) return;
    const now = Date.now();
    if (!force && now - lastSent < 1000) return;
    lastSent = now;
    const p = playerState();
    if (p) send({ type: 'evt/player', videoId, player: p });
  }

  function onTimeUpdate() {
    const v = findVideo();
    if (!v || !videoId || adShowing()) return;
    const t = v.currentTime;
    // Only while a tutor UI is checking in: with the panel closed nobody would show the question,
    // so pausing would be unexplained. Skipped checkpoints stay unanswered rather than marked done.
    if (checkpoints && checkpoints.videoId === videoId && checkpoints.mode !== 'off' && Date.now() <= engagedUntil) {
      for (const id of crossedCheckpoints(lastT, t, checkpoints.items, checkpoints.done)) {
        checkpoints.done.add(id);
        const pause = checkpoints.mode === 'active';
        if (pause) v.pause();
        send({ type: 'evt/checkpoint', videoId, id, paused: pause });
      }
    }
    lastT = t;
    reportPlayer();
    maybeSample(v);
  }

  // ---------- rolling frame buffer (§13.2) ----------
  function maybeSample(v: HTMLVideoElement) {
    // Not while the tab is in the background: the learner is not looking at the video.
    if (Date.now() > engagedUntil || document.hidden || !frameBuffer || v.paused || !videoId || !alive()) return;
    const now = Date.now();
    if (now - lastSample < 15_000) return;
    lastSample = now;
    const hash = frameHash(v);
    if (!hash || isNearDuplicate(hash, recentHashes)) return;
    const jpeg = frameJpeg(v);
    if (!jpeg) return;
    recentHashes = [hash, ...recentHashes].slice(0, 8);
    sendToBackground({ type: 'bg/frame-put', videoId, t: v.currentTime, dataUrl: jpeg.dataUrl, hash, width: jpeg.width, height: jpeg.height, kind: 'sample' }).catch(() => undefined);
  }

  let boundVideo: HTMLVideoElement | null = null;
  function bindVideo() {
    const v = findVideo();
    if (!v || v === boundVideo) return;
    boundVideo = v;
    v.addEventListener('timeupdate', onTimeUpdate);
    // Seeks feed the rewind confusion signal (§13.2).
    v.addEventListener('seeking', () => {
      const to = v.currentTime;
      if (videoId && !adShowing() && Math.abs(to - lastT) > 1.5) send({ type: 'evt/seek', videoId, from: lastT, to, at: Date.now() });
    });
    v.addEventListener('pause', () => {
      pauseDensity = adShowing() ? null : frameDensity(v);
    });
    v.addEventListener('play', () => (pauseDensity = null));
    for (const ev of ['play', 'pause', 'ended', 'seeked', 'loadedmetadata', 'ratechange']) {
      v.addEventListener(ev, () => {
        if (ev === 'seeked') lastT = v.currentTime;
        reportPlayer(true);
      });
    }
  }

  // ---------- navigation ----------
  function resetForVideo(id: string | null) {
    generation++;
    videoId = id;
    meta = null;
    captions = { state: 'idle' };
    captionJob = null;
    checkpoints = null;
    lastT = 0;
    transcriptCues = [];
    recentHashes = [];
    pauseDensity = null;
    clearCaptures();
    send({ type: 'evt/video', videoId: id, meta: null });
  }

  /** The worker keeps page metadata for recent videos only; send it again when the learner turns
   *  to this tab, so a tab opened long ago still works. */
  let metaSentAt = 0;
  function resendMeta() {
    if (!meta || Date.now() - metaSentAt < 60_000) return;
    metaSentAt = Date.now();
    sendToBackground({ type: 'bg/meta-put', meta }).catch(() => undefined);
  }

  function setMeta(m: VideoMeta) {
    meta = m;
    metaSentAt = Date.now();
    for (const w of metaWaiters) w(m);
    metaWaiters = [];
    sendToBackground({ type: 'bg/meta-put', meta: m }).catch(() => undefined);
    send({ type: 'evt/video', videoId: m.videoId, meta: m });
  }

  function metaFromPlayerData(data: PlayerData | null): VideoMeta | null {
    if (!data) return null;
    const base = parsePlayerResponse(data.playerResponse);
    return base ? { ...base, chapters: data.chapters ?? [], playlist: data.playlist ?? null } : null;
  }

  function onNavigate(data: PlayerData | null) {
    const id = videoIdFromUrl(location.href);
    if (id !== videoId) resetForVideo(id);
    bindVideo();
    const m = metaFromPlayerData(data);
    if (m && m.videoId === videoId && (!meta || (!meta.chapters.length && m.chapters.length))) setMeta(m);
    else if (videoId && !meta) loadMeta();
  }

  async function loadMeta() {
    const gen = generation;
    for (let attempt = 0; attempt < 12 && gen === generation && !meta; attempt++) {
      const res = await page({ type: 'player-data' });
      if (gen !== generation || meta) return;
      const m = metaFromPlayerData(res?.data ?? null);
      if (m && m.videoId === videoId) {
        setMeta(m);
        return;
      }
      await sleep(500);
    }
    if (gen === generation && !meta) {
      for (const w of metaWaiters) w(null);
      metaWaiters = [];
    }
  }

  function waitForMeta(ms: number): Promise<VideoMeta | null> {
    if (meta) return Promise.resolve(meta);
    return new Promise((resolve) => {
      metaWaiters.push(resolve);
      setTimeout(() => resolve(meta), ms);
    });
  }

  function checkUrl() {
    const id = videoIdFromUrl(location.href);
    if (id !== videoId) {
      resetForVideo(id);
      if (id) loadMeta();
    }
    bindVideo();
    if (id) ensureAskButton(onAskButton);
  }

  // ---------- in-player "Ask" button and fullscreen overlay (§13.2) ----------
  async function openOverlay(action?: CommandAction) {
    const w = window as Win;
    if (!w.__ytTutorOverlay) {
      const r = await sendToBackground({ type: 'bg/inject-overlay' }).catch(() => ({ ok: false }));
      if (!r.ok || !w.__ytTutorOverlay) return;
    }
    w.__ytTutorOverlay!.open(action);
  }

  async function onAskButton() {
    resendMeta();
    engagedUntil = Date.now() + ENGAGE_MS;
    findVideo()?.pause();
    if (document.fullscreenElement) return openOverlay('ask-moment');
    const r = await sendToBackground({ type: 'bg/open-panel', action: 'ask-moment' }).catch(() => ({ ok: false }));
    if (!r.ok) openOverlay('ask-moment');
  }

  (window as Win).__ytTutorApi = {
    state: () => state(),
    // Same rule as the panel's capture: an ad's frame is never used as lecture context.
    capture: async () => (adShowing() ? { ok: false as const, reason: 'error' as const, message: 'An ad is playing. Try again when the video is back.' } : captureFrame(findVideo())),
    ensureCaptions: () => ensureCaptions(false),
    findVideo,
    pause: () => findVideo()?.pause(),
  };

  document.addEventListener(YT.navigateFinishEvent, () => setTimeout(checkUrl, 0));
  window.addEventListener('popstate', () => setTimeout(checkUrl, 0));
  setInterval(() => {
    if (!alive()) return;
    checkUrl();
  }, 1500);
  checkUrl();

  // ---------- captions (§3 fallback chain) ----------
  function setCaptions(s: CaptionStatus) {
    captions = s;
    if (videoId) send({ type: 'evt/captions', videoId, status: s });
  }

  async function ensureCaptions(force: boolean): Promise<CaptionStatus> {
    if (!videoId) return { state: 'none', reason: 'Not a video page.' };
    if (captions.state === 'ready' && !force) return captions;
    if (captionJob && !force) return captionJob;
    const gen = generation;
    const job = loadCaptions(gen).catch((e): CaptionStatus => ({ state: 'none', reason: `Caption loading failed: ${String(e)}` }));
    captionJob = job;
    const result = await job;
    if (gen === generation) {
      setCaptions(result);
      if (result.state !== 'ready') captionJob = null;
    }
    return result;
  }

  async function loadCaptions(gen: number): Promise<CaptionStatus> {
    const m = await waitForMeta(8000);
    if (gen !== generation) return captions;
    if (!m) return { state: 'none', reason: 'Could not read the video data from the page. Try reloading the tab.' };
    if (m.isLive) return { state: 'none', reason: 'Live streams are not supported.' };
    const track = pickTrack(m.tracks, m.originalLanguage);
    if (!track) return { state: 'none', reason: 'This video has no captions. The tutor can still answer from the screen.' };
    const cacheLang = `${track.languageCode}${track.isAuto ? ':asr' : ''}`;
    const finish = async (cues: Cue[], source: Transcript['source']): Promise<CaptionStatus> => {
      // The learner may have moved to another video while captions were loading; what was read
      // could then belong to that video, so never store it under this one.
      if (gen !== generation) return captions;
      const transcript: Transcript = {
        videoId: m.videoId,
        lang: cacheLang,
        trackName: track.name,
        isAuto: track.isAuto,
        source,
        cues,
      };
      transcriptCues = cues;
      await sendToBackground({ type: 'bg/transcript-put', transcript }).catch(() => undefined);
      return { state: 'ready', source, lang: track.languageCode, trackName: track.name, isAuto: track.isAuto, count: cues.length };
    };
    const tidy = (raw: Cue[]) => normalizeCues(track.isAuto ? removeRollingOverlap(raw) : raw);

    const cached = await sendToBackground({ type: 'bg/transcript-get', videoId: m.videoId, lang: cacheLang }).catch(() => null);
    if (gen !== generation) return captions;
    if (cached?.cues.length) {
      transcriptCues = cached.cues;
      return { state: 'ready', source: cached.source, lang: track.languageCode, trackName: track.name, isAuto: track.isAuto, count: cached.cues.length };
    }

    // 1. Captions the player already fetched (the learner has CC on).
    setCaptions({ state: 'loading', step: 'Reading captions the player loaded' });
    const seen = await page({ type: 'captured', videoId: m.videoId, lang: track.languageCode, isAuto: track.isAuto });
    let cues = seen?.data ? tidy(parseTimedText(seen.data.body)) : [];
    if (cues.length) return finish(cues, 'player');

    // 2. Switch captions on briefly so the player fetches them (with its own proof-of-origin token).
    //    Not during an ad: the player would fetch the ad's captions instead.
    if (adShowing()) {
      setCaptions({ state: 'loading', step: 'Waiting for the ad to finish' });
      for (let i = 0; i < 120 && adShowing() && gen === generation; i++) await sleep(1000);
    }
    if (gen !== generation) return captions;
    setCaptions({ state: 'loading', step: 'Asking the player for captions' });
    const trig = await page({ type: 'trigger-captions', videoId: m.videoId, lang: track.languageCode, isAuto: track.isAuto, timeoutMs: 7000 }, 9000);
    cues = trig?.data ? tidy(parseTimedText(trig.data.body)) : [];
    if (cues.length) return finish(cues, 'player');
    // A late-arriving response (slow network) is still recorded by the page script; check once more.
    const late = await page({ type: 'captured', videoId: m.videoId, lang: track.languageCode, isAuto: track.isAuto });
    cues = late?.data ? tidy(parseTimedText(late.data.body)) : [];
    if (cues.length) return finish(cues, 'player');

    // 3. Direct fetch of the track. Often empty nowadays; cheap to try.
    if (gen !== generation) return captions;
    setCaptions({ state: 'loading', step: 'Fetching the caption track' });
    try {
      const res = await fetch(timedTextUrl(track.baseUrl, 'json3'), { credentials: 'include' });
      if (res.ok) cues = tidy(parseTimedText(await res.text()));
    } catch {
      cues = [];
    }
    if (cues.length) return finish(cues, 'direct');

    // 4. Scrape the "Show transcript" panel.
    if (gen !== generation) return captions;
    setCaptions({ state: 'loading', step: 'Reading the transcript panel' });
    cues = normalizeCues(await scrapeTranscriptPanel(m.lengthSeconds, () => gen !== generation));
    if (cues.length) return finish(cues, 'panel');

    return { state: 'none', reason: 'YouTube lists captions for this video, but none could be loaded. Try again, or turn CC on in the player and retry.' };
  }

  function clickFirst(selectors: readonly string[], root: ParentNode = document): boolean {
    const el = firstVisible<HTMLElement>(root, selectors);
    el?.click();
    return !!el;
  }

  async function scrapeTranscriptPanel(lengthSeconds: number, stale: () => boolean): Promise<Cue[]> {
    let rows = readTranscriptSegments(document);
    let opened = false;
    let expanded = false;
    if (!rows.length) {
      // The visible "Show transcript" button sits inside the description, behind "...more".
      if (!firstVisible(document, YT.transcriptButtonSelectors)) {
        expanded = clickFirst(YT.descriptionExpandSelectors);
        if (expanded) await sleep(500);
      }
      opened = clickFirst(YT.transcriptButtonSelectors);
      if (!opened) {
        if (expanded) clickFirst(YT.descriptionCollapseSelectors);
        return [];
      }
      for (let i = 0; i < 25 && !rows.length && !stale(); i++) {
        await sleep(300);
        rows = readTranscriptSegments(document);
      }
      if (stale()) return []; // navigated away: these rows would be the next video's
      if (rows.length) {
        // Let the list finish rendering.
        await sleep(400);
        rows = readTranscriptSegments(document);
      }
    }
    if (stale()) return [];
    const cues = segmentsToCues(rows, lengthSeconds);
    if (opened) {
      const panel = transcriptPanel(document);
      if (panel) clickFirst(YT.transcriptCloseSelectors, panel);
    }
    if (expanded) clickFirst(YT.descriptionCollapseSelectors);
    return cues;
  }

  // ---------- messages from the panel ----------
  function state(): VideoState {
    return { url: location.href, videoId, meta, captions, player: playerState(), playlist: meta?.playlist ?? null };
  }

  async function handle(msg: ToContent): Promise<ContentResponses[ToContent['type']]> {
    const v = findVideo();
    switch (msg.type) {
      case 'cs/ping':
        return { ok: true, videoId };
      case 'cs/get-state':
        if (videoId && !meta) loadMeta();
        return state();
      case 'cs/ensure-captions':
        return ensureCaptions(!!msg.force);
      case 'cs/capture-frame':
        if (adShowing()) return { ok: false, reason: 'error', message: 'An ad is playing. Try again when the video is back.' };
        return captureFrame(v);
      case 'cs/crop':
        return cropLast(msg.captureId, msg.rect);
      case 'cs/seek':
        if (!v) return { ok: false };
        v.currentTime = Math.max(0, msg.t);
        lastT = v.currentTime;
        if (msg.play) await v.play().catch(() => undefined);
        return { ok: true };
      case 'cs/play':
        if (!v) return { ok: false };
        await v.play().catch(() => undefined);
        return { ok: true };
      case 'cs/pause':
        v?.pause();
        return { ok: !!v };
      case 'cs/arm-checkpoints':
        checkpoints = msg.videoId === videoId ? { videoId: msg.videoId, mode: msg.mode, items: msg.items, done: new Set(msg.done) } : null;
        return { ok: true };
      case 'cs/set-rate':
        if (!v) return { ok: false, rate: 1 };
        v.playbackRate = Math.min(2, Math.max(0.5, msg.rate));
        return { ok: true, rate: v.playbackRate };
      case 'cs/engage':
        resendMeta();
        engagedUntil = Date.now() + ENGAGE_MS;
        frameBuffer = msg.frameBuffer;
        return { ok: true };
      case 'cs/toast':
        showToast(msg.text);
        return { ok: true };
      case 'cs/command':
        resendMeta();
        if (document.fullscreenElement) {
          openOverlay(msg.action);
          return { ok: true, handled: true };
        }
        return { ok: true, handled: false };
      case 'cs/bookmark-data': {
        resendMeta();
        if (!v || !videoId) return { ok: false, message: 'No video.' };
        const t = v.currentTime;
        const cue = transcriptCues.filter((c) => c.start <= t + 0.5).pop();
        const jpeg = adShowing() ? null : frameJpeg(v);
        showToast(`Bookmarked ${formatTime(t)}`);
        return { ok: true, videoId, t, caption: cue?.text ?? '', dataUrl: jpeg?.dataUrl ?? null, hash: frameHash(v), width: jpeg?.width ?? 0, height: jpeg?.height ?? 0 };
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('cs/')) return false;
    handle(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String(e) }));
    return true;
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
