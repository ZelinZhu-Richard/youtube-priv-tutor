// Library logic (§13.5) and the v1 -> IndexedDB migration (M7). Pure functions.
import { mergeIntoChunks } from './captions';
import { completeVideo } from './db';
import { EMPTY_LEARNER } from './learner';
import { formatTime, watchUrl } from './time';
import type {
  Bookmark,
  CheckpointResult,
  ConceptState,
  HistoryEntry,
  LearnerModel,
  Mistake,
  QuizItem,
  TeachBackResult,
  Transcript,
  VideoMap,
  VideoMeta,
  VideoRecord,
} from './types';

// ---------- migration from the first build (chrome.storage) ----------

export interface MigrationResult {
  videos: VideoRecord[];
  history: HistoryEntry[];
  transcripts: Transcript[];
  /** chrome.storage.local keys that were migrated and can be removed. */
  migratedKeys: string[];
}

const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/**
 * Turns first-build storage ("v:<id>:<kind>" keys in storage.local, "t:"/"m:" caches in
 * storage.session) into IndexedDB records. Nothing is dropped: every per-video kind is carried over.
 */
export function migrateV1(local: Record<string, unknown>, session: Record<string, unknown> = {}, now = Date.now()): MigrationResult {
  const index = (local.videoIndex ?? {}) as Record<string, { title?: string; updatedAt?: number }>;
  const ids = new Set<string>(Object.keys(index));
  for (const k of Object.keys(local)) {
    const m = /^v:(.+):(history|map|learner|checkpoints|teachbacks|known|progress|quiz)$/.exec(k);
    if (m) ids.add(m[1]);
  }
  const videos: VideoRecord[] = [];
  const history: HistoryEntry[] = [];
  const transcripts: Transcript[] = [];
  const migratedKeys: string[] = [];
  for (const id of ids) {
    const key = (kind: string) => `v:${id}:${kind}`;
    for (const kind of ['history', 'map', 'learner', 'checkpoints', 'teachbacks', 'known', 'progress', 'quiz']) if (key(kind) in local) migratedKeys.push(key(kind));
    const meta = session[`m:${id}`] as VideoMeta | undefined;
    const progress = local[key('progress')] as { lastT?: number; updatedAt?: number } | undefined;
    const updatedAt = Math.max(index[id]?.updatedAt ?? 0, progress?.updatedAt ?? 0) || now;
    videos.push(
      completeVideo({
        videoId: id,
        title: meta?.title || index[id]?.title || '',
        channel: meta?.channel ?? '',
        lengthSeconds: meta?.lengthSeconds ?? 0,
        chapters: meta?.chapters ?? [],
        createdAt: updatedAt,
        updatedAt,
        lastT: progress?.lastT ?? 0,
        map: (local[key('map')] as VideoMap | undefined) ?? null,
        learner: (local[key('learner')] as LearnerModel | undefined) ?? EMPTY_LEARNER,
        known: arr<number>(local[key('known')]),
        quiz: arr<QuizItem>(local[key('quiz')]),
        checkpointResults: arr<CheckpointResult>(local[key('checkpoints')]),
        teachBacks: arr<TeachBackResult>(local[key('teachbacks')]),
      }),
    );
    for (const h of arr<HistoryEntry>(local[key('history')])) history.push({ ...h, videoId: h.videoId ?? id });
    const t = session[`t:${id}`] as Transcript | undefined;
    if (t?.cues?.length) transcripts.push(t);
  }
  if ('videoIndex' in local) migratedKeys.push('videoIndex');
  return { videos, history, transcripts, migratedKeys };
}

// ---------- search ----------

export type DocKind = 'title' | 'question' | 'answer' | 'bookmark' | 'mistake' | 'transcript' | 'cheatsheet';

export interface SearchDoc {
  videoId: string;
  kind: DocKind;
  text: string;
  at: number | null;
}

export interface SearchHit extends SearchDoc {
  score: number;
  snippet: string;
}

const KIND_WEIGHT: Record<DocKind, number> = { title: 3, question: 2, bookmark: 2, mistake: 2, cheatsheet: 1.5, answer: 1, transcript: 0.8 };

/** Lowercased words; CJK text is split into single characters so it can be searched without spaces. */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1 || /[^\x00-\x7f]/.test(w));
}

export function buildSearchDocs(input: {
  videos: Pick<VideoRecord, 'videoId' | 'title' | 'channel' | 'cheatSheet'>[];
  history: HistoryEntry[];
  bookmarks: Bookmark[];
  mistakes: Mistake[];
  transcripts: Transcript[];
}): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const v of input.videos) {
    docs.push({ videoId: v.videoId, kind: 'title', text: `${v.title} ${v.channel}`, at: null });
    if (v.cheatSheet) docs.push({ videoId: v.videoId, kind: 'cheatsheet', text: v.cheatSheet.markdown, at: null });
  }
  for (const h of input.history) docs.push({ videoId: h.videoId, kind: 'question', text: `${h.question}\n${h.answer}`, at: h.at });
  for (const b of input.bookmarks) docs.push({ videoId: b.videoId, kind: 'bookmark', text: `${b.note} ${b.caption}`.trim(), at: b.t });
  for (const m of input.mistakes) docs.push({ videoId: m.videoId, kind: 'mistake', text: `${m.question} ${m.misconception} ${m.correction}`, at: m.at });
  for (const t of input.transcripts) for (const c of mergeIntoChunks(t.cues)) docs.push({ videoId: t.videoId, kind: 'transcript', text: c.text, at: c.start });
  return docs;
}

function snippet(text: string, terms: string[], width = 160): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const start = Math.max(0, pos - Math.floor(width / 3));
  const s = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (start + width < text.length ? '…' : '');
}

/** All query terms must appear; score favours titles, questions, bookmarks and repeated terms. */
export function searchLibrary(docs: SearchDoc[], query: string, limit = 50): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    const lower = d.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      let n = 0;
      for (let i = lower.indexOf(t); i >= 0 && n < 10; i = lower.indexOf(t, i + t.length)) n++;
      if (!n) {
        all = false;
        break;
      }
      score += 1 + Math.log(n);
    }
    if (all) hits.push({ ...d, score: score * KIND_WEIGHT[d.kind], snippet: snippet(d.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score || (a.at ?? 0) - (b.at ?? 0)).slice(0, limit);
}

// ---------- concepts across the library ----------

export interface ConceptOccurrence {
  videoId: string;
  title: string;
  definedAt: number | null;
  state: ConceptState;
  summary: string;
  order: number;
}

export interface LibraryConcept {
  key: string;
  name: string;
  dependsOn: string[];
  occurrences: ConceptOccurrence[];
  /** The most recent known state across the videos where it appears. */
  state: ConceptState;
}

/** Order in which videos were studied: playlist position when shared, else first-studied time. */
export function studyOrder(videos: Pick<VideoRecord, 'videoId' | 'createdAt' | 'playlist'>[]): Map<string, number> {
  const sorted = [...videos].sort((a, b) => {
    if (a.playlist && b.playlist && a.playlist.id === b.playlist.id) return a.playlist.index - b.playlist.index;
    return a.createdAt - b.createdAt;
  });
  return new Map(sorted.map((v, i) => [v.videoId, i]));
}

export function conceptIndex(videos: VideoRecord[]): Map<string, LibraryConcept> {
  const order = studyOrder(videos);
  const out = new Map<string, LibraryConcept>();
  for (const v of videos) {
    for (const c of v.map?.concepts ?? []) {
      const key = c.name.toLowerCase();
      const entry = out.get(key) ?? { key, name: c.name, dependsOn: [], occurrences: [], state: 'unseen' as ConceptState };
      const state = v.learner.concepts[c.name]?.state ?? 'unseen';
      entry.occurrences.push({ videoId: v.videoId, title: v.title, definedAt: c.definedAt, state, summary: c.summary, order: order.get(v.videoId) ?? 0 });
      for (const d of c.dependsOn) if (!entry.dependsOn.some((x) => x.toLowerCase() === d.toLowerCase())) entry.dependsOn.push(d);
      out.set(key, entry);
    }
  }
  for (const e of out.values()) {
    e.occurrences.sort((a, b) => a.order - b.order);
    e.state = [...e.occurrences].reverse().find((o) => o.state !== 'unseen')?.state ?? 'unseen';
  }
  return out;
}

export interface Connection {
  concept: string;
  videoId: string;
  title: string;
  at: number | null;
}

/** Concepts of this video that were met in videos studied earlier (§13.5 connections). */
export function findConnections(current: Pick<VideoRecord, 'videoId' | 'map'>, videos: VideoRecord[]): Connection[] {
  if (!current.map) return [];
  const order = studyOrder(videos.some((v) => v.videoId === current.videoId) ? videos : [...videos, { ...(current as VideoRecord), createdAt: Date.now(), playlist: null }]);
  const mine = order.get(current.videoId) ?? Infinity;
  const out: Connection[] = [];
  for (const c of current.map.concepts) {
    let best: Connection | null = null;
    let bestOrder = -1;
    for (const v of videos) {
      if (v.videoId === current.videoId) continue;
      const o = order.get(v.videoId) ?? 0;
      if (o >= mine) continue;
      const hit = v.map?.concepts.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      if (hit && o > bestOrder) {
        best = { concept: c.name, videoId: v.videoId, title: v.title, at: hit.definedAt };
        bestOrder = o;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

export function connectionsText(conns: Connection[]): string {
  if (!conns.length) return '';
  const lines = conns.map((c) => `- ${c.concept}: met earlier in "${c.title}"${c.at !== null ? ` at ${formatTime(c.at)}` : ''} — ${watchUrl(c.videoId, c.at ?? undefined)}`);
  return `<connections>\nConcepts in this video that the learner met in videos they studied earlier. When an answer relies on one, say so and link the earlier video with a Markdown link to the URL given.\n${lines.join('\n')}\n</connections>`;
}

/** Where a prerequisite was taught in the learner's library, if anywhere. */
export function findPriorTeaching(name: string, videos: VideoRecord[], exceptVideoId: string): Connection | null {
  const key = name.toLowerCase();
  for (const v of [...videos].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (v.videoId === exceptVideoId) continue;
    const c = v.map?.concepts.find((x) => x.name.toLowerCase() === key || key.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(key));
    if (c) return { concept: c.name, videoId: v.videoId, title: v.title, at: c.definedAt };
  }
  return null;
}

// ---------- playlists ----------

/**
 * Learner model carried forward within a playlist: concepts of this video that were solid or
 * shaky in earlier videos of the course start in that state (§13.5).
 */
export function carryOver(earlier: VideoRecord[], map: VideoMap, current: LearnerModel, now = Date.now()): LearnerModel {
  const concepts = { ...current.concepts };
  let changed = false;
  for (const c of map.concepts) {
    if (concepts[c.name] && concepts[c.name].state !== 'unseen') continue;
    let state: ConceptState | null = null;
    for (const v of earlier) {
      const hit = Object.entries(v.learner.concepts).find(([n]) => n.toLowerCase() === c.name.toLowerCase())?.[1];
      if (!hit) continue;
      if (hit.state === 'shaky') state = 'shaky';
      else if (hit.state === 'solid' && state !== 'shaky') state = 'solid';
    }
    if (state) {
      concepts[c.name] = { state, updatedAt: now, evidence: ['earlier in this course'] };
      changed = true;
    }
  }
  return changed ? { concepts } : current;
}

/** Earlier videos of the same playlist that the learner has studied, in course order. */
export function earlierInPlaylist(videos: VideoRecord[], playlistId: string, index: number): VideoRecord[] {
  return videos.filter((v) => v.playlist?.id === playlistId && v.playlist.index < index).sort((a, b) => a.playlist!.index - b.playlist!.index);
}

// ---------- concept graph layout ----------

export interface GraphNode {
  key: string;
  deps: string[];
}

export interface PlacedNode {
  key: string;
  level: number;
  row: number;
}

/** Layered layout: a concept sits one level right of its deepest dependency. Cycles are cut. */
export function layoutGraph(nodes: GraphNode[]): PlacedNode[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (k: string): number => {
    if (level.has(k)) return level.get(k)!;
    if (visiting.has(k)) return 0;
    visiting.add(k);
    const n = byKey.get(k);
    const d = n ? Math.max(-1, ...n.deps.filter((x) => byKey.has(x)).map(depth)) + 1 : 0;
    visiting.delete(k);
    level.set(k, d);
    return d;
  };
  for (const n of nodes) depth(n.key);
  const rows = new Map<number, number>();
  return [...nodes]
    .sort((a, b) => level.get(a.key)! - level.get(b.key)! || a.key.localeCompare(b.key))
    .map((n) => {
      const l = level.get(n.key)!;
      const row = rows.get(l) ?? 0;
      rows.set(l, row + 1);
      return { key: n.key, level: l, row };
    });
}

/**
 * What to store for a migrated first-build video. With nothing stored yet, the migrated record is
 * kept whole. If a newer build already saved this video, its fields win and the migrated record
 * only fills in a missing lesson map.
 */
export function mergeMigrated(existing: VideoRecord | null, migrated: VideoRecord): VideoRecord {
  if (!existing) return migrated;
  return { ...migrated, ...existing, map: existing.map ?? migrated.map };
}
