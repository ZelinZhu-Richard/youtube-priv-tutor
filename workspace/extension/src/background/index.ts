// Service worker: holds the API key, builds prompts, calls Claude and streams to the panel (or the
// fullscreen overlay) over a long-lived port, stores frames and bookmarks, keeps the review badge
// current, routes keyboard commands, and runs the one-time data migration.
import type Anthropic from '@anthropic-ai/sdk';
import { mergeIntoChunks } from '../shared/captions';
import { chooseTranscriptMode, conceptsNear, currentChapter, currentSectionIndex, estimateTokens, renderCues, selectWindow } from '../shared/context';
import * as db from '../shared/db';
import { DHASH_H, DHASH_W, dHash, FRAME_PREFIX, MAX_ASK_FRAMES, NO_HASH, pruneIds, pruneSampleIds, toGray } from '../shared/frames';
import { mergeNotation, NOTATION_SCHEMA } from '../shared/glossary';
import { base64ToBytes, bytesToBase64, splitDataUrl } from '../shared/image';
import { conceptsInState, learnerDigest } from '../shared/learner';
import { carryOver, connectionsText, earlierInPlaylist, findConnections } from '../shared/library';
import type { AskRequest, BackgroundResponses, CommandAction, DoneResult, PortEvent, PortRequest, ToBackground } from '../shared/messages';
import { TUTOR_PORT } from '../shared/messages';
import { ensureMigrated } from '../shared/migrate';
import { normalizeProblems, PRACTICE_SCHEMA, visibleSteps } from '../shared/practice';
import {
  buildMessages,
  cheatSheetRequestText,
  contextBlocks,
  durableUserText,
  extractAlternatives,
  feynmanRequestText,
  gradeRequestText,
  mapRequestText,
  notationFromFrameText,
  parseVerdict,
  practiceRequestText,
  PREREQ_GRADE_SCHEMA,
  prereqGradeText,
  problemGradeText,
  profileText,
  quizRequestText,
  teachBackRequestText,
  turnText,
  videoContextText,
  type FrameInput,
} from '../shared/prompt';
import * as records from '../shared/records';
import { broadcast, uid } from '../shared/rpc';
import { isTrustedSender, YOUTUBE_URL } from '../shared/trust';
import { KEYS, type Settings } from '../shared/settings';
import { addUsage, getProfile, getSettings } from '../shared/store';
import { summarizeRun } from '../shared/practice';
import type { HistoryEntry, LearnerProfile, NotationEntry, Transcript, VideoMeta, VideoRecord } from '../shared/types';
import { normalizeQuiz, normalizeVideoMap, QUIZ_SCHEMA, VIDEO_MAP_SCHEMA } from '../shared/videoMap';
import { streamClaude, toTutorError, TutorApiError } from './llm';

// ---------- setup ----------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

// The API key, settings and profile live in storage.local. Content scripts run inside the YouTube
// page's process and need none of it, so only extension pages and this worker may read it.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

/** True when the tab is a YouTube page. Tabs on other sites are never injected into or captured. */
async function isYouTubeTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.url && YOUTUBE_URL.test(tab.url) ? tab : null;
}

async function startup() {
  await ensureMigrated().catch((e) => console.warn('migration failed; first-build data left in place', e));
  if (!(await chrome.alarms.get('badge'))) chrome.alarms.create('badge', { periodInMinutes: 30 });
  await refreshBadge();
}
chrome.runtime.onInstalled.addListener(() => void startup());
chrome.runtime.onStartup.addListener(() => void startup());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'badge') void refreshBadge();
});

/** Toolbar badge: number of review cards due (§13.4). */
async function refreshBadge(): Promise<number> {
  const due = (await db.dueCardsFromDb().catch(() => [])).length;
  await chrome.action.setBadgeText({ text: due ? String(Math.min(due, 999)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#1f5f5b' });
  return due;
}

async function getApiKey(): Promise<string | null> {
  const r = await chrome.storage.local.get(KEYS.apiKey);
  const k = r[KEYS.apiKey];
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

const sessionMeta = async (videoId: string) => ((await chrome.storage.session.get(`m:${videoId}`))[`m:${videoId}`] as VideoMeta | undefined) ?? null;

/** Page metadata for recently visited videos, in memory-backed session storage. Only the most
 * recent few are kept, so a long browsing session cannot fill the quota. */
const MAX_SESSION_META = 24;
async function putSessionMeta(meta: VideoMeta) {
  const order = (((await chrome.storage.session.get('metaOrder')).metaOrder as string[] | undefined) ?? []).filter((id) => id !== meta.videoId);
  order.push(meta.videoId);
  const drop = order.splice(0, Math.max(0, order.length - MAX_SESSION_META));
  if (drop.length) await chrome.storage.session.remove(drop.map((id) => `m:${id}`));
  await chrome.storage.session.set({ [`m:${meta.videoId}`]: meta, metaOrder: order });
}

/** Creates or refreshes the stored video record from page metadata (only for videos the learner engages with). */
async function touchVideo(meta: VideoMeta): Promise<VideoRecord> {
  if (meta.playlist) await db.put('playlists', { id: meta.playlist.id, title: meta.playlist.title, videoIds: meta.playlist.videoIds });
  return db.updateVideo(meta.videoId, (cur) => ({
    title: meta.title || cur.title,
    channel: meta.channel || cur.channel,
    lengthSeconds: meta.lengthSeconds || cur.lengthSeconds,
    chapters: meta.chapters.length ? meta.chapters : cur.chapters,
    playlist: meta.playlist ? { id: meta.playlist.id, title: meta.playlist.title, index: Math.max(0, meta.playlist.videoIds.indexOf(meta.videoId)) } : cur.playlist,
  }));
}

// ---------- keyboard commands (also grant activeTab, which the tab-capture fallback needs) ----------

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id || tab.windowId === undefined) return;
  const action = command as CommandAction;
  if (action === 'bookmark') {
    void bookmark(tab.id);
    return;
  }
  // Must be called synchronously in the user-gesture handler. Hidden in fullscreen, where the
  // content script shows its overlay instead.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  const tabId = tab.id;
  // Exactly one UI answers a shortcut. In fullscreen the page's overlay takes it and says so;
  // only otherwise is it handed to the side panel. (No content script yet: the panel takes it.)
  chrome.tabs
    .sendMessage(tabId, { type: 'cs/command', action })
    .catch(() => null)
    .then((r: { handled?: boolean } | null) => {
      if (r?.handled) return;
      const at = Date.now();
      chrome.storage.session.set({ [KEYS.pendingCommand]: { action, tabId, at } }).catch(() => undefined);
      broadcast({ type: 'evt/command', action, tabId, at });
    });
});

async function bookmark(tabId: number, note = ''): Promise<BackgroundResponses['bg/bookmark']> {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'cs/bookmark-data' }).catch((e) => ({ ok: false as const, message: String(e) }));
  if (!r.ok) return { ok: false, message: r.message };
  const meta = await sessionMeta(r.videoId);
  if (meta) await touchVideo(meta);
  let frameId: string | null = null;
  if (r.dataUrl && r.hash) frameId = await storeFrame(r.videoId, r.t, r.dataUrl, r.hash, r.width, r.height, 'bookmark');
  const b = await records.addBookmark({ videoId: r.videoId, t: r.t, frameId, caption: r.caption, note });
  return { ok: true, bookmark: b };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = splitDataUrl(dataUrl);
  if (!parts) throw new Error('bad data URL');
  return new Blob([base64ToBytes(parts.data) as BlobPart], { type: parts.mediaType });
}

async function storeFrame(videoId: string, t: number, dataUrl: string, hash: string, width: number, height: number, kind: 'sample' | 'bookmark' | 'ask'): Promise<string> {
  const id = uid(FRAME_PREFIX[kind]);
  await db.put('frames', { id, videoId, t, blob: dataUrlToBlob(dataUrl), hash, width, height, kind, createdAt: Date.now() });
  if (kind === 'sample') await db.delMany('frames', pruneSampleIds(await db.keysByVideo('frames', videoId), 40));
  if (kind === 'ask') await db.delMany('frames', pruneIds(await db.keysByVideo('frames', videoId), FRAME_PREFIX.ask, MAX_ASK_FRAMES));
  records.notifyChanged(videoId, ['frames']);
  return id;
}

/** Perceptual hash of a stored image, so frames saved with a question compare with sampled ones. */
async function hashImage(blob: Blob): Promise<string> {
  try {
    const bmp = await createImageBitmap(blob);
    const g = new OffscreenCanvas(DHASH_W, DHASH_H).getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0, DHASH_W, DHASH_H);
    bmp.close();
    return dHash(toGray(g.getImageData(0, 0, DHASH_W, DHASH_H).data, DHASH_W, DHASH_H));
  } catch {
    return NO_HASH;
  }
}

async function blobToFrameInput(blob: Blob, width: number, height: number): Promise<FrameInput> {
  return { mediaType: (blob.type === 'image/png' ? 'image/png' : 'image/jpeg') as FrameInput['mediaType'], data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), width, height };
}

// ---------- one-off messages ----------

chrome.runtime.onMessage.addListener((msg: ToBackground | { type: 'evt/data'; kinds: string[] }, sender, sendResponse) => {
  if (msg?.type === 'evt/data') {
    if (msg.kinds.includes('cards')) void refreshBadge();
    return false;
  }
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('bg/')) return false;
  // Only this extension's own pages and its content scripts on YouTube may ask for anything.
  if (!isTrustedSender(sender, chrome.runtime.id)) return false;
  handleMessage(msg as ToBackground, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, message: String(e) }));
  return true;
});

async function handleMessage(msg: ToBackground, sender: chrome.runtime.MessageSender): Promise<BackgroundResponses[ToBackground['type']]> {
  switch (msg.type) {
    case 'bg/transcript-get': {
      const t = await db.get('transcripts', msg.videoId);
      return t && t.lang === msg.lang ? t : null;
    }
    case 'bg/transcript-put': {
      await db.put('transcripts', msg.transcript);
      const meta = await sessionMeta(msg.transcript.videoId);
      if (meta) await touchVideo(meta);
      records.notifyChanged(msg.transcript.videoId, ['video']);
      return { ok: true };
    }
    case 'bg/meta-put':
      await putSessionMeta(msg.meta);
      if (await db.get('videos', msg.meta.videoId)) await touchVideo(msg.meta);
      return { ok: true };
    case 'bg/has-key': {
      const k = await getApiKey();
      // The hint is part of the key: give it to the extension's own pages only, never to the
      // content script inside YouTube's page.
      const ownPage = !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
      return { hasKey: !!k, hint: k && ownPage ? `…${k.slice(-4)}` : '' };
    }
    case 'bg/inject':
      try {
        // Clicking the toolbar icon grants activeTab on whatever site is open; never inject there.
        if (!(await isYouTubeTab(msg.tabId))) return { ok: false, message: 'Not a YouTube tab.' };
        await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['page.js'], world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['content.js'] });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    case 'bg/capture-tab':
      return captureTab(sender, msg.rect, msg.viewportWidth);
    case 'bg/frame-put': {
      if (!(await db.get('videos', msg.videoId))) {
        const meta = await sessionMeta(msg.videoId);
        if (!meta) return { ok: false, id: null };
        await touchVideo(meta);
      }
      return { ok: true, id: await storeFrame(msg.videoId, msg.t, msg.dataUrl, msg.hash, msg.width, msg.height, msg.kind) };
    }
    case 'bg/bookmark':
      return bookmark(msg.tabId, msg.note);
    case 'bg/open-panel': {
      const tab = sender.tab;
      if (!tab?.id) return { ok: false };
      try {
        // Works when Chrome forwards the click's user gesture with the message; otherwise the
        // content script falls back to its overlay.
        await chrome.sidePanel.open({ tabId: tab.id });
        const at = Date.now();
        await chrome.storage.session.set({ [KEYS.pendingCommand]: { action: msg.action, tabId: tab.id, at } });
        broadcast({ type: 'evt/command', action: msg.action, tabId: tab.id, at });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }
    case 'bg/inject-overlay':
      try {
        if (!sender.tab?.id) return { ok: false };
        await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ['overlay.js'] });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    case 'bg/badge':
      return { ok: true, due: await refreshBadge() };
  }
}

async function captureTab(sender: chrome.runtime.MessageSender, rect: { x: number; y: number; width: number; height: number }, viewportWidth: number): Promise<BackgroundResponses['bg/capture-tab']> {
  if (sender.tab?.id === undefined) return { ok: false, reason: 'error', message: 'No tab to capture.' };
  // captureVisibleTab photographs whichever tab is in front. Only do it while the requesting
  // YouTube tab is that tab, so a screenshot can never show another site.
  const tab = await isYouTubeTab(sender.tab.id);
  if (!tab || !tab.active) return { ok: false, reason: 'error', message: 'The video tab is not in front, so no screenshot was taken.' };
  const windowId = tab.windowId;
  let shot: string;
  try {
    shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    // The learner may have switched tabs while the screenshot was being taken; discard it if so.
    const after = await isYouTubeTab(sender.tab.id);
    if (!after?.active) return { ok: false, reason: 'error', message: 'The video tab is not in front, so no screenshot was taken.' };
  } catch (e) {
    return {
      ok: false,
      reason: 'denied',
      message: `The screenshot fallback needs a one-time grant on this tab: click the YouTube Tutor toolbar icon (or press Alt+Shift+A) while the video tab is active, then try again. (${String(e)})`,
    };
  }
  try {
    const bmp = await createImageBitmap(dataUrlToBlob(shot));
    const scale = viewportWidth > 0 ? bmp.width / viewportWidth : 1;
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(rect.width * scale)));
    const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(rect.height * scale)));
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { ok: true, dataUrl: `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}` };
  } catch (e) {
    return { ok: false, reason: 'error', message: `Could not crop the screenshot: ${String(e)}` };
  }
}

// ---------- the tutor port (side panel, library page, fullscreen overlay) ----------


chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TUTOR_PORT || !isTrustedSender(port.sender, chrome.runtime.id)) return;
  const inflight = new Map<string, AbortController>();
  let open = true;
  const post = (e: PortEvent) => {
    if (!open) return;
    try {
      port.postMessage(e);
    } catch {
      open = false;
    }
  };
  port.onDisconnect.addListener(() => {
    open = false;
    for (const ac of inflight.values()) ac.abort();
    inflight.clear();
  });
  port.onMessage.addListener((msg: PortRequest) => {
    if (msg.type === 'ping') return post({ type: 'pong' });
    if (msg.type === 'cancel') {
      inflight.get(msg.reqId)?.abort();
      return;
    }
    const ac = new AbortController();
    inflight.set(msg.reqId, ac);
    run(msg, ac.signal, post)
      .catch((e) => post({ type: 'error', reqId: msg.reqId, error: toTutorError(e) }))
      .finally(() => {
        inflight.delete(msg.reqId);
        // Grading may have added review cards; the worker does not receive its own broadcasts.
        void refreshBadge();
      });
  });
});

interface Ctx {
  apiKey: string;
  settings: Settings;
  profile: LearnerProfile;
  video: VideoRecord;
  meta: Pick<VideoMeta, 'videoId' | 'title' | 'channel' | 'lengthSeconds' | 'chapters'>;
  transcript: Transcript | null;
  library: VideoRecord[];
}

async function loadCtx(videoId: string): Promise<Ctx> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new TutorApiError({ code: 'no-key', message: 'Add your Anthropic API key in Settings to ask the tutor.', retryable: false });
  const meta = await sessionMeta(videoId);
  let video = meta ? await touchVideo(meta) : await db.getVideo(videoId);
  if (!video || (!meta && !video.title)) throw new TutorApiError({ code: 'unknown', message: 'The video data has not loaded yet. Wait a second, or reload the YouTube tab.', retryable: true });
  video = video!;
  const [settings, profile, transcript, library] = await Promise.all([getSettings(), getProfile(), db.get('transcripts', videoId), db.getAll('videos')]);
  return {
    apiKey,
    settings,
    profile,
    video,
    meta: { videoId, title: video.title, channel: video.channel, lengthSeconds: video.lengthSeconds, chapters: video.chapters },
    transcript: transcript ?? null,
    library: library.map(db.completeVideo),
  };
}

/** The cached prefix for this video: profile, video context, lesson map and connections. */
function qaContext(ctx: Ctx, forceFull = false, withhold = false) {
  const chunks = ctx.transcript && !withhold ? mergeIntoChunks(ctx.transcript.cues) : [];
  const tokens = estimateTokens(renderCues(chunks));
  const mode = !ctx.transcript || withhold ? 'none' : forceFull ? 'full' : chooseTranscriptMode(ctx.meta.lengthSeconds, tokens, ctx.settings.fullTranscriptMinutes);
  const text = videoContextText({ meta: ctx.meta, chunks, trackLabel: ctx.transcript?.trackName ?? null, isAuto: !!ctx.transcript?.isAuto, mode, withheld: withhold });
  const connections = connectionsText(findConnections(ctx.video, ctx.library));
  const blocks = contextBlocks(text, forceFull ? null : ctx.video.map, { profile: profileText(ctx.profile), connections });
  return { mode, text, chunks, blocks };
}

type Post = (e: PortEvent) => void;
type Call = (messages: Anthropic.Beta.BetaMessageParam[], opts: { schema?: Record<string, unknown>; streamText: boolean }) => ReturnType<typeof streamClaude>;
type StreamResult = Awaited<ReturnType<typeof streamClaude>>;

const one = (blocks: Anthropic.Beta.BetaTextBlockParam[], text: string, images: FrameInput[] = []): Anthropic.Beta.BetaMessageParam[] => [
  {
    role: 'user',
    content: [
      ...blocks,
      ...images.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: f.mediaType, data: f.data } })),
      { type: 'text' as const, text },
    ],
  },
];

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    throw new TutorApiError({ code: 'unknown', message: 'The model returned malformed JSON. Try again.', retryable: true });
  }
}

async function run(msg: Exclude<PortRequest, { type: 'ping' } | { type: 'cancel' }>, signal: AbortSignal, post: Post) {
  // Problem grading is keyed by problem, everything else by video.
  const problem = msg.type === 'grade-problem' ? await db.get('problems', msg.problemId) : null;
  if (msg.type === 'grade-problem' && !problem) throw new TutorApiError({ code: 'unknown', message: 'That practice problem is no longer stored.', retryable: false });
  const videoId = msg.type === 'grade-problem' ? problem!.videoId : msg.videoId;
  const ctx = await loadCtx(videoId);
  const done = (result: DoneResult, r: StreamResult) => {
    addUsage(r.usage).catch(() => undefined);
    post({ type: 'done', reqId: msg.reqId, result, usage: r.usage, servedBy: r.servedBy, truncated: r.stopReason === 'max_tokens' });
  };
  const call: Call = (messages, opts) =>
    streamClaude({
      apiKey: ctx.apiKey,
      model: ctx.settings.model,
      effort: ctx.settings.effort,
      messages,
      schema: opts.schema,
      signal,
      onText: opts.streamText ? (d) => post({ type: 'delta', reqId: msg.reqId, text: d }) : undefined,
      onThinking: (d) => post({ type: 'thinking', reqId: msg.reqId, text: d }),
    });
  post({ type: 'started', reqId: msg.reqId, model: ctx.settings.model });
  const needMap = () => {
    if (!ctx.video.map) throw new TutorApiError({ code: 'no-map', message: 'Prepare the lesson first so the tutor knows the sections.', retryable: false });
    return ctx.video.map;
  };

  switch (msg.type) {
    case 'map': {
      const { map, r } = await generateMap(ctx, call);
      return done({ kind: 'map', map }, r);
    }
    case 'ask':
      return ask(ctx, msg, call, done, post);
    case 'grade': {
      const map = needMap();
      const cp = map.checkpoints.find((c) => c.id === msg.checkpointId);
      if (!cp) throw new TutorApiError({ code: 'no-map', message: 'That checkpoint is no longer in the lesson map.', retryable: false });
      const cues = ctx.transcript ? selectWindow(ctx.transcript.cues, cp.at - 120, cp.at + 10) : [];
      const r = await call(one(qaContext(ctx).blocks, gradeRequestText(cp, msg.answer, cues, msg.confidence)), { streamText: true });
      const p = parseVerdict(r.text, ['correct', 'partial', 'incorrect'] as const);
      const result = {
        checkpointId: cp.id,
        question: cp.question,
        at: cp.at,
        answer: msg.answer,
        verdict: p.verdict ?? ('partial' as const),
        feedback: p.body,
        concepts: p.concepts.length ? p.concepts : cp.concepts,
        confidence: msg.confidence,
        misconception: p.fields.misconception ?? '',
        correction: p.fields.correction ?? '',
        createdAt: Date.now(),
      };
      await records.saveCheckpointResult(videoId, result);
      return done({ kind: 'grade', result }, r);
    }
    case 'teachback': {
      const map = needMap();
      const section = map.sections[msg.sectionIndex];
      if (!section) throw new TutorApiError({ code: 'no-map', message: 'That section is no longer in the lesson map.', retryable: false });
      const cues = ctx.transcript ? mergeIntoChunks(selectWindow(ctx.transcript.cues, section.start, section.end)) : [];
      const r = await call(one(qaContext(ctx).blocks, teachBackRequestText(section, msg.sectionIndex, msg.text, cues)), { streamText: true });
      const p = parseVerdict(r.text, ['solid', 'gaps'] as const);
      const fallback = map.concepts.filter((c) => c.definedAt !== null && c.definedAt >= section.start && c.definedAt < section.end).map((c) => c.name);
      const result = { sectionIndex: msg.sectionIndex, text: msg.text, verdict: p.verdict ?? ('gaps' as const), feedback: p.body, concepts: p.concepts.length ? p.concepts : fallback, createdAt: Date.now() };
      await records.saveTeachBack(videoId, result);
      return done({ kind: 'teachback', result }, r);
    }
    case 'quiz': {
      const missed = ctx.video.checkpointResults.filter((c) => c.verdict === 'partial' || c.verdict === 'incorrect').map((c) => c.question);
      const r = await call(one(qaContext(ctx).blocks, quizRequestText(conceptsInState(ctx.video.learner, 'shaky'), missed, msg.upTo)), { schema: QUIZ_SCHEMA as unknown as Record<string, unknown>, streamText: false });
      const items = normalizeQuiz(safeJson(r.text));
      await db.updateVideo(videoId, () => ({ quiz: items }));
      records.notifyChanged(videoId, ['video']);
      return done({ kind: 'quiz', items }, r);
    }
    case 'practice': {
      const map = needMap();
      const section = msg.sectionIndex !== null ? map.sections[msg.sectionIndex] : null;
      const avoid = (await db.byVideo('problems', videoId)).filter((p) => p.concept.toLowerCase() === msg.concept.toLowerCase()).map((p) => p.statement).slice(-6);
      const r = await call(one(qaContext(ctx).blocks, practiceRequestText(msg.concept, section?.title ?? null, avoid)), { schema: PRACTICE_SCHEMA as unknown as Record<string, unknown>, streamText: false });
      const setId = uid('set');
      const problems = normalizeProblems(safeJson(r.text), { videoId, concept: msg.concept, setId, id: (i) => `${setId}-${i}` });
      if (!problems.length) throw new TutorApiError({ code: 'unknown', message: 'No problems came back. Try again.', retryable: true });
      await db.putMany('problems', problems);
      records.notifyChanged(videoId, ['problems']);
      return done({ kind: 'practice', problems }, r);
    }
    case 'grade-problem': {
      const p = problem!;
      const shown = visibleSteps(p).shown.length;
      const r = await call(
        one(qaContext(ctx).blocks, problemGradeText(p, { answer: msg.answer, code: msg.code, runSummary: msg.run ? summarizeRun(msg.run) : null, hintsUsed: msg.hintsUsed, confidence: msg.confidence }, shown)),
        { streamText: true },
      );
      const v = parseVerdict(r.text, ['correct', 'partial', 'incorrect'] as const);
      const attempt = { answer: msg.answer, code: msg.code, run: msg.run, hintsUsed: msg.hintsUsed, confidence: msg.confidence, verdict: v.verdict ?? ('partial' as const), feedback: v.body, misconception: v.fields.misconception ?? '', createdAt: Date.now() };
      const updated = await records.recordAttempt(p, attempt);
      return done({ kind: 'grade-problem', attempt, problem: updated }, r);
    }
    case 'prereq-grade': {
      const r = await call(one(qaContext(ctx).blocks, prereqGradeText(msg.checks)), { schema: PREREQ_GRADE_SCHEMA as unknown as Record<string, unknown>, streamText: false });
      const res = ((safeJson(r.text) as { results?: { index: number; ok: boolean; gap: string }[] }).results ?? []).filter((x) => typeof x.index === 'number');
      const checks = msg.checks.map((c, i) => {
        const g = res.find((x) => x.index === i);
        return { ...c, ok: g ? !!g.ok : false, gap: g?.gap ?? '' };
      });
      await db.updateVideo(videoId, () => ({ prereqChecks: checks }));
      for (const c of checks.filter((x) => !x.ok)) {
        await records.addMistake({ videoId, at: null, source: 'prereq', question: c.question, answer: c.response ?? '', misconception: c.gap ?? '', correction: c.answer, confidence: null, concepts: [c.prerequisite] }, ctx.video.title);
      }
      records.notifyChanged(videoId, ['video']);
      return done({ kind: 'prereq', checks }, r);
    }
    case 'feynman': {
      needMap();
      const r = await call(one(qaContext(ctx).blocks, feynmanRequestText(msg.text)), { streamText: true });
      const p = parseVerdict(r.text, ['solid', 'gaps'] as const);
      const missing = (p.fields.missing ?? '').split(/[;；]/).map((x) => x.trim()).filter(Boolean);
      const result = { text: msg.text, verdict: p.verdict ?? ('gaps' as const), feedback: p.body, missing, createdAt: Date.now() };
      await records.saveFeynman(videoId, result);
      return done({ kind: 'feynman', result }, r);
    }
    case 'cheatsheet': {
      const bookmarks = (await db.byVideo('bookmarks', videoId)).sort((a, b) => a.t - b.t);
      const r = await call(one(qaContext(ctx).blocks, cheatSheetRequestText(bookmarks)), { streamText: true });
      await db.updateVideo(videoId, () => ({ cheatSheet: { markdown: r.text, createdAt: Date.now() } }));
      records.notifyChanged(videoId, ['video']);
      return done({ kind: 'cheatsheet', markdown: r.text }, r);
    }
    case 'notation': {
      const r = await call(one(qaContext(ctx).blocks, notationFromFrameText(msg.t), [msg.frame]), { schema: NOTATION_SCHEMA as unknown as Record<string, unknown>, streamText: false });
      const raw = ((safeJson(r.text) as { entries?: { symbol?: string; meaning?: string }[] }).entries ?? []).slice(0, 30);
      const entries: NotationEntry[] = raw
        .filter((e) => typeof e.symbol === 'string' && e.symbol.trim() && typeof e.meaning === 'string')
        .map((e) => ({ symbol: e.symbol!.trim().slice(0, 120), meaning: e.meaning!.trim().slice(0, 300), definedAt: msg.t, source: 'frame' as const }));
      const v = await db.updateVideo(videoId, (cur) => ({ glossaryExtra: mergeNotation(cur.glossaryExtra, cur.map, entries) }));
      records.notifyChanged(videoId, ['video']);
      return done({ kind: 'notation', entries: v.glossaryExtra }, r);
    }
  }
}

/** One call over the full transcript (§12.1). Reuses the Q&A cache prefix for videos in full mode. */
async function generateMap(ctx: Ctx, call: Call) {
  if (!ctx.transcript?.cues.length) {
    throw new TutorApiError({ code: 'no-transcript', message: 'The lesson map needs captions, and this video has none loaded.', retryable: false });
  }
  const r = await call(one(qaContext(ctx, true).blocks, mapRequestText()), { schema: VIDEO_MAP_SCHEMA as unknown as Record<string, unknown>, streamText: false });
  const map = normalizeVideoMap(safeJson(r.text), ctx.meta.videoId, ctx.meta.lengthSeconds, r.servedBy);
  if (!map.sections.length) throw new TutorApiError({ code: 'unknown', message: 'The lesson map came back empty. Try again.', retryable: true });
  // Playlist awareness (§13.5): carry the learner model forward from earlier videos in the course.
  const earlier = ctx.video.playlist ? earlierInPlaylist(ctx.library, ctx.video.playlist.id, ctx.video.playlist.index) : [];
  ctx.video = await db.updateVideo(ctx.meta.videoId, (cur) => ({
    map,
    preQuestions: map.preQuestions ?? [],
    prereqChecks: (map.prerequisiteChecks ?? []).map((c) => ({ ...c })),
    learner: earlier.length ? carryOver(earlier, map, cur.learner) : cur.learner,
  }));
  records.notifyChanged(ctx.meta.videoId, ['video']);
  return { map, r };
}

async function ask(ctx: Ctx, msg: AskRequest, call: Call, done: (res: DoneResult, r: StreamResult) => void, post: Post) {
  // Captions chip off: neither the transcript nor the local window is sent, and no lesson map is
  // generated from the transcript on the learner's behalf.
  const withhold = msg.includeTranscript === false;
  let q = qaContext(ctx, false, withhold);
  if (q.mode === 'summary' && !ctx.video.map) {
    post({ type: 'thinking', reqId: msg.reqId, text: 'Long video: preparing a lesson map first so the tutor has an overview…\n' });
    const res = await generateMap(ctx, call);
    addUsage(res.r.usage).catch(() => undefined);
    q = qaContext(ctx, false, withhold);
  }
  const map = ctx.video.map;
  const allHistory = (await db.byVideo('history', msg.videoId)).sort((a, b) => a.createdAt - b.createdAt);
  const history = ctx.settings.historyTurns > 0 ? allHistory.slice(-ctx.settings.historyTurns) : [];
  const si = map ? currentSectionIndex(map.sections, msg.t) : -1;
  const parent = msg.parentId ? allHistory.find((h) => h.id === msg.parentId) ?? null : null;
  const local =
    msg.captionRange && ctx.transcript && !withhold
      ? { from: msg.captionRange[0], to: msg.captionRange[1], cues: selectWindow(ctx.transcript.cues, msg.captionRange[0], msg.captionRange[1]) }
      : null;
  const earlier: { frame: FrameInput; t: number }[] = [];
  for (const id of (msg.earlierFrameIds ?? []).slice(0, 3)) {
    const f = await db.get('frames', id);
    if (f && f.videoId === msg.videoId) earlier.push({ frame: await blobToFrameInput(f.blob, f.width, f.height), t: f.t });
  }
  const text = turnText({
    kind: msg.kind,
    question: msg.question,
    t: msg.t,
    paused: msg.paused,
    chapterTitle: currentChapter(ctx.meta.chapters, msg.t)?.title ?? null,
    section: si >= 0 && map ? map.sections[si] : null,
    localCaptions: local,
    frame: msg.frame,
    frameNote: msg.frameNote,
    crop: msg.crop,
    earlier,
    learnerDigest: learnerDigest(ctx.video.learner),
    depth: msg.depth,
    // Depth buttons work on answers outside the replayed history window too, so send that answer
    // along when the model would not otherwise see it.
    parent: parent ? { question: parent.question, at: parent.at, answer: history.some((h) => h.id === parent.id) ? undefined : parent.answer } : null,
    hintsFirst: ctx.settings.hintsFirst,
    fallbackLanguage: msg.fallbackLanguage,
  });
  const messages = buildMessages({ contextBlocks: q.blocks, history, turn: { text, frame: msg.frame, crop: msg.crop, earlier: earlier.map((e) => e.frame) } });
  const r = await call(messages, { streamText: true });
  const { body, alternatives } = msg.kind === 'lost' ? extractAlternatives(r.text) : { body: r.text, alternatives: [] };
  let frameId: string | null = null;
  if (msg.frame && msg.keepFrame !== false) {
    const dataUrl = `data:${msg.frame.mediaType};base64,${msg.frame.data}`;
    frameId = await storeFrame(msg.videoId, msg.t, dataUrl, await hashImage(dataUrlToBlob(dataUrl)), msg.frame.width, msg.frame.height, 'ask').catch(() => null);
  }
  const entry: HistoryEntry = {
    id: uid('h'),
    videoId: msg.videoId,
    frameId,
    kind: msg.kind,
    question: displayQuestion(msg),
    userText: durableUserText({ kind: msg.kind, question: msg.question, t: msg.t, depth: msg.depth }),
    answer: body,
    at: msg.t,
    createdAt: Date.now(),
    model: r.servedBy,
    hadFrame: !!msg.frame,
    hadCrop: !!msg.crop,
    captionRange: msg.captionRange,
    depth: msg.depth,
    parentId: msg.parentId,
    concepts: conceptsNear(map, msg.t),
  };
  await db.put('history', entry);
  records.notifyChanged(msg.videoId, ['history']);
  done({ kind: 'ask', entry, alternatives }, r);
}

function displayQuestion(msg: AskRequest): string {
  const q = msg.question.trim();
  switch (msg.kind) {
    case 'lost':
      return "I'm lost";
    case 'explain-screen':
      return q || 'Explain this screen';
    case 'extract':
      return 'Extract from screen';
    case 'walkthrough':
      return 'Walk me through it';
    case 'depth':
      return { simpler: 'Simpler', example: 'Example', formal: 'Formal' }[msg.depth ?? 'simpler'];
    case 'recap':
      return 'Where was I?';
    case 'goal':
      return `Goal: ${q}`;
    case 'primer':
      return `Primer: ${q}`;
    default:
      return msg.crop && !q ? 'Explain this' : q;
  }
}

void startup();
