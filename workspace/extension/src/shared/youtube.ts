// EVERYTHING YouTube-specific lives in this module: DOM selectors, player-response parsing,
// caption-track choice, timedtext URLs, chapter extraction and the transcript-panel scrape.
// When YouTube changes its page, this is the file to fix.
import { parseTime } from './time';
import { collapseWhitespace } from './captions';
import type { CaptionTrackInfo, Chapter, Cue, VideoMeta } from './types';

export const YT = {
  /** The main <video>; the first match wins. */
  videoSelectors: ['#movie_player video.html5-main-video', 'video.html5-main-video', '#movie_player video', 'ytd-player video'],
  /** The player element that exposes YouTube's player API (getPlayerResponse, setOption, ...). */
  playerSelector: '#movie_player',
  /** Current chapter title shown in the player chrome. */
  chapterTitleSelector: '.ytp-chapter-title-content',
  /** The CC button; aria-pressed="true" while captions show. */
  subtitlesButtonSelector: '.ytp-subtitles-button',
  /** Class on the player while an ad plays. */
  adShowingClass: 'ad-showing',
  /** "...more" on the description, needed before the transcript button is visible. */
  descriptionExpandSelectors: ['#description-inline-expander #expand', 'ytd-text-inline-expander #expand', 'tp-yt-paper-button#expand'],
  descriptionCollapseSelectors: ['#description-inline-expander #collapse', 'ytd-text-inline-expander #collapse', 'tp-yt-paper-button#collapse'],
  /** "Show transcript" button. */
  transcriptButtonSelectors: [
    'ytd-video-description-transcript-section-renderer button',
    'button[aria-label="Show transcript"]',
    'button[aria-label*="transcript" i]',
  ],
  /** The engagement panel that hosts the transcript (found as the ancestor of a segment row). */
  engagementPanelSelector: 'ytd-engagement-panel-section-list-renderer',
  /** One row per transcript segment: the 2026 view-model first, then the older renderer. */
  transcriptSegmentSelectors: ['transcript-segment-view-model', 'ytd-transcript-segment-renderer'],
  segmentTimestampSelectors: ['.ytwTranscriptSegmentViewModelTimestamp', '.segment-timestamp'],
  segmentTextSelectors: ['span.ytAttributedStringHost', '.segment-text', 'yt-formatted-string.segment-text', 'span.yt-core-attributed-string'],
  /** Close button, relative to the transcript's engagement panel. */
  transcriptCloseSelectors: ['#visibility-button button', 'button[aria-label="Close transcript"]', 'button[aria-label="Close"]'],
  /** Right-hand group of player controls, where the in-player "Ask" button goes. */
  playerRightControlsSelector: '.ytp-right-controls',
  /** Path of the caption endpoint the player calls. */
  timedTextPath: '/api/timedtext',
  /** SPA navigation event fired on document. */
  navigateFinishEvent: 'yt-navigate-finish',
} as const;

// ---------- URLs ----------

/** Video id of a youtube.com/watch URL, or null for anything else (Shorts, live, home, ...). */
export function videoIdFromUrl(href: string): string | null {
  try {
    const u = new URL(href);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname !== '/watch') return null;
    const v = u.searchParams.get('v');
    return v && /^[\w-]{6,20}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function isTimedTextUrl(url: string): boolean {
  return url.includes(YT.timedTextPath);
}

export interface TimedTextParams {
  videoId: string | null;
  lang: string | null;
  kind: string | null;
  tlang: string | null;
  fmt: string | null;
}

export function parseTimedTextUrl(url: string): TimedTextParams {
  try {
    const u = new URL(url, 'https://www.youtube.com');
    const p = u.searchParams;
    return { videoId: p.get('v'), lang: p.get('lang'), kind: p.get('kind'), tlang: p.get('tlang'), fmt: p.get('fmt') };
  } catch {
    return { videoId: null, lang: null, kind: null, tlang: null, fmt: null };
  }
}

/** The track's baseUrl with fmt set (json3 by default) and any auto-translation removed. */
export function timedTextUrl(baseUrl: string, fmt = 'json3'): string {
  const u = new URL(baseUrl, 'https://www.youtube.com');
  u.searchParams.set('fmt', fmt);
  u.searchParams.delete('tlang');
  return u.toString();
}

// ---------- player response ----------

type Json = Record<string, unknown>;
const obj = (x: unknown): Json | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

function textOf(x: unknown): string {
  const o = obj(x);
  if (!o) return str(x);
  if (typeof o.simpleText === 'string') return o.simpleText;
  return arr(o.runs).map((r) => str(obj(r)?.text)).join('');
}

export function parseCaptionTracks(playerResponse: unknown): CaptionTrackInfo[] {
  const renderer = obj(obj(obj(playerResponse)?.captions)?.playerCaptionsTracklistRenderer);
  return arr(renderer?.captionTracks)
    .map((t): CaptionTrackInfo | null => {
      const o = obj(t);
      if (!o || typeof o.baseUrl !== 'string' || typeof o.languageCode !== 'string') return null;
      let variant: string | null = null;
      try {
        variant = new URL(o.baseUrl, 'https://www.youtube.com').searchParams.get('variant');
      } catch {
        /* keep null */
      }
      return {
        baseUrl: o.baseUrl,
        languageCode: o.languageCode,
        name: textOf(o.name) || o.languageCode,
        vssId: str(o.vssId),
        isAuto: o.kind === 'asr',
        variant,
      };
    })
    .filter((t): t is CaptionTrackInfo => t !== null);
}

/**
 * Best guess at the spoken language. The ASR track is generated from the original audio, except the
 * "timing-optimized" ASR variants YouTube makes for dubbed audio, so it wins; otherwise fall back to
 * the default audio track id ("en-US.4" -> "en-US").
 */
export function originalLanguage(playerResponse: unknown, tracks: CaptionTrackInfo[]): string | null {
  const asr = tracks.find((t) => t.isAuto && t.variant !== 'timing-optimized');
  if (asr) return asr.languageCode;
  const renderer = obj(obj(obj(playerResponse)?.captions)?.playerCaptionsTracklistRenderer);
  const audio = arr(renderer?.audioTracks);
  const idx = typeof renderer?.defaultAudioTrackIndex === 'number' ? renderer.defaultAudioTrackIndex : -1;
  const id = str(obj(audio[idx])?.audioTrackId);
  const lang = id.split('.')[0];
  return lang && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(lang) ? lang : null;
}

export function parsePlayerResponse(playerResponse: unknown): Omit<VideoMeta, 'chapters'> | null {
  const pr = obj(playerResponse);
  const vd = obj(pr?.videoDetails);
  if (!vd || typeof vd.videoId !== 'string') return null;
  const tracks = parseCaptionTracks(pr);
  return {
    videoId: vd.videoId,
    title: str(vd.title),
    channel: str(vd.author),
    lengthSeconds: Number(vd.lengthSeconds) || 0,
    isLive: vd.isLive === true || (vd.isLiveContent === true && !(Number(vd.lengthSeconds) > 0)),
    tracks,
    originalLanguage: originalLanguage(pr, tracks),
  };
}

const primary = (lang: string) => lang.toLowerCase().split('-')[0];
export function langMatches(a: string | null, b: string | null): boolean {
  return !!a && !!b && primary(a) === primary(b);
}

/**
 * Track choice (§3): manual captions in the video's language, else auto-generated in the video's
 * language, else any manual track, else any non-dub ASR track. Never auto-translate.
 */
export function pickTrack(tracks: CaptionTrackInfo[], originalLang: string | null): CaptionTrackInfo | null {
  if (!tracks.length) return null;
  const isDub = (t: CaptionTrackInfo) => t.variant === 'timing-optimized';
  const manualOrig = tracks.filter((t) => !t.isAuto && langMatches(t.languageCode, originalLang));
  if (manualOrig.length) {
    // Prefer an exact code match, then the shortest code ("en" over "en-GB" variants).
    return manualOrig.find((t) => t.languageCode === originalLang) ?? [...manualOrig].sort((a, b) => a.languageCode.length - b.languageCode.length)[0];
  }
  const autoOrig = tracks.find((t) => t.isAuto && !isDub(t) && langMatches(t.languageCode, originalLang));
  if (autoOrig) return autoOrig;
  return tracks.find((t) => !t.isAuto) ?? tracks.find((t) => t.isAuto && !isDub(t)) ?? tracks[0];
}

// ---------- chapters ----------

/** Finds the description chapters anywhere in ytInitialData (or a navigation response). */
export function extractChapters(initialData: unknown): Chapter[] {
  const stack: unknown[] = [initialData];
  let visited = 0;
  while (stack.length && visited < 500_000) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      const first = obj(node[0]);
      if (first && obj(first.chapterRenderer)) {
        const chapters = node
          .map((n) => obj(obj(n)?.chapterRenderer))
          .filter((c): c is Json => !!c)
          .map((c) => ({ start: Number(c.timeRangeStartMillis) / 1000, title: textOf(c.title) }))
          .filter((c) => Number.isFinite(c.start) && c.title);
        if (chapters.length) return chapters.sort((a, b) => a.start - b.start);
      }
      for (let i = node.length - 1; i >= 0; i--) if (node[i] && typeof node[i] === 'object') stack.push(node[i]);
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node as Json)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return [];
}

/** Extracts `var name = {...};` (or `window["name"] = {...}`) JSON from a watch page's HTML. */
export function extractJsonAssignment(html: string, name: string): unknown {
  const patterns = [`${name} = `, `${name}=`, `["${name}"] = `];
  let at = -1;
  for (const p of patterns) {
    at = html.indexOf(p);
    if (at >= 0) break;
  }
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------- playlists ----------

export interface PlaylistData {
  id: string;
  title: string;
  videoIds: string[];
}

function playlistFrom(o: Json | null): PlaylistData | null {
  if (!o || typeof o.playlistId !== 'string') return null;
  const ids = arr(o.contents)
    .map((c) => str(obj(obj(c)?.playlistPanelVideoRenderer)?.videoId))
    .filter(Boolean);
  if (!ids.length) return null;
  return { id: o.playlistId, title: textOf(o.title) || str(o.title), videoIds: ids };
}

/** The playlist panel of a watch page (ytInitialData or a navigation response), if any. */
export function extractPlaylist(initialData: unknown): PlaylistData | null {
  const direct = obj(obj(obj(obj(obj(initialData)?.contents)?.twoColumnWatchNextResults)?.playlist)?.playlist);
  const hit = playlistFrom(direct);
  if (hit) return hit;
  const stack: unknown[] = [initialData];
  for (let n = 0; stack.length && n < 200_000; n++) {
    const node = stack.pop();
    const o = obj(node);
    if (o && typeof o.playlistId === 'string' && Array.isArray(o.contents)) {
      const p = playlistFrom(o);
      if (p) return p;
    }
    if (node && typeof node === 'object') for (const v of Object.values(node as Json)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

/** Playlist id from a watch URL (?list=...). */
export function playlistIdFromUrl(href: string): string | null {
  try {
    return new URL(href).searchParams.get('list');
  } catch {
    return null;
  }
}

// ---------- transcript panel ----------

export interface RawSegment {
  ts: string;
  text: string;
}

/** Reads transcript rows from the "Show transcript" panel. DOM-only; selectors above. */
export function readTranscriptSegments(root: ParentNode): RawSegment[] {
  const pick = (el: Element, sels: readonly string[]) => {
    for (const s of sels) {
      const found = el.querySelector(s);
      if (found?.textContent?.trim()) return found.textContent;
    }
    return '';
  };
  for (const sel of YT.transcriptSegmentSelectors) {
    const rows = Array.from(root.querySelectorAll(sel));
    if (!rows.length) continue;
    return rows.map((row) => ({ ts: pick(row, YT.segmentTimestampSelectors), text: pick(row, YT.segmentTextSelectors) }));
  }
  return [];
}

/**
 * First element matching any selector that is actually rendered. YouTube keeps hidden copies of
 * some controls (e.g. a second "Show transcript" button inside a collapsed panel), so a plain
 * querySelector can return the wrong one.
 */
export function firstVisible<T extends Element = HTMLElement>(root: ParentNode, selectors: readonly string[]): T | null {
  for (const sel of selectors) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
      if (el.offsetParent !== null) return el as unknown as T;
    }
  }
  return null;
}

/** The engagement panel that contains the transcript rows, if it is showing. */
export function transcriptPanel(root: ParentNode): Element | null {
  for (const sel of YT.transcriptSegmentSelectors) {
    const row = root.querySelector(sel);
    if (row) return row.closest(YT.engagementPanelSelector);
  }
  return null;
}

/** Turns "1:02" + text rows into cues; each lasts until the next row starts. */
export function segmentsToCues(segments: RawSegment[], videoLength = 0): Cue[] {
  const parsed = segments
    .map((s) => ({ start: parseTime(collapseWhitespace(s.ts)), text: collapseWhitespace(s.text) }))
    .filter((s): s is { start: number; text: string } => s.start !== null && !!s.text);
  return parsed.map((s, i) => {
    const next = parsed[i + 1];
    const end = next ? next.start : Math.max(s.start + 5, videoLength || 0);
    return { start: s.start, duration: Math.max(0, Math.min(end - s.start, next ? Infinity : 10)), text: s.text };
  });
}

/** Human label for the player's current resolution. */
export function qualityLabel(videoHeight: number): string {
  return videoHeight > 0 ? `${videoHeight}p` : 'unknown';
}
