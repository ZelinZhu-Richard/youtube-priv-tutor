// Notes (Markdown) and flashcards (Anki-importable CSV) export (§12.5). Pure functions.
import { findTimestamps, formatTime, watchUrl } from './time';
import { conceptsInState } from './learner';
import type { Bookmark, CheckpointResult, FeynmanResult, HistoryEntry, LearnerModel, Mistake, TeachBackResult, VideoMap, VideoMeta } from './types';
import type { ZipEntry } from './zip';

/** Splits markdown into code (fenced or inline) and prose segments so transforms skip code. */
export function splitCode(md: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  // Fences may be indented (a code block under a list item).
  const re = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    if (start > last) out.push({ code: false, text: md.slice(last, start) });
    out.push({ code: true, text: md.slice(start, m.index + m[0].length) });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

/** Turns "[12:34]" in prose into "[12:34](https://www.youtube.com/watch?v=…&t=754s)". */
export function linkTimestamps(md: string, videoId: string): string {
  return splitCode(md)
    .map((seg) => {
      if (seg.code) return seg.text;
      let out = '';
      let pos = 0;
      for (const ts of findTimestamps(seg.text)) {
        out += seg.text.slice(pos, ts.index) + `[${ts.label}](${watchUrl(videoId, ts.start)})`;
        pos = ts.index + ts.length;
      }
      return out + seg.text.slice(pos);
    })
    .join('');
}

export interface NotesInput {
  meta: Pick<VideoMeta, 'videoId' | 'title' | 'channel'>;
  history: HistoryEntry[];
  map: VideoMap | null;
  learner: LearnerModel;
  checkpoints: CheckpointResult[];
  teachBacks: TeachBackResult[];
  bookmarks?: Bookmark[];
  mistakes?: Mistake[];
  feynman?: FeynmanResult | null;
  /** Present when the cheat sheet is exported alongside (linked as cheat-sheet.md). */
  hasCheatSheet?: boolean;
  /** frameId -> relative image path, for frames included in the export. */
  frameFiles?: Record<string, string>;
  exportedAt?: Date;
}

const VERDICT_LABEL: Record<string, string> = { correct: 'correct', partial: 'partly right', incorrect: 'not yet', skipped: 'skipped' };

export function toMarkdown(input: NotesInput): string {
  const { meta, history, map, learner, checkpoints, teachBacks } = input;
  const at = (t: number) => `[${formatTime(t)}](${watchUrl(meta.videoId, t)})`;
  const date = (input.exportedAt ?? new Date()).toISOString().slice(0, 10);
  const lines: string[] = [`# ${meta.title || meta.videoId}`, '', `${meta.channel ? `${meta.channel} · ` : ''}${watchUrl(meta.videoId)}`, '', `_Notes exported ${date} from YouTube Tutor._`, ''];

  if (map?.sections.length) {
    lines.push('## Key ideas', '');
    for (const s of map.sections) lines.push(`- ${at(s.start)} **${s.title}**${s.keyIdea ? ` — ${s.keyIdea}` : ''}`);
    lines.push('');
  }

  const shaky = conceptsInState(learner, 'shaky');
  if (shaky.length) {
    lines.push('## Concepts to review', '');
    for (const name of shaky) {
      const c = map?.concepts.find((x) => x.name === name);
      lines.push(`- **${name}**${c?.definedAt != null ? ` (${at(c.definedAt)})` : ''}${c?.summary ? ` — ${c.summary}` : ''}`);
    }
    lines.push('');
  }

  const img = (frameId: string | null | undefined, alt: string) => (frameId && input.frameFiles?.[frameId] ? `![${alt}](${input.frameFiles[frameId]})` : '');

  if (input.hasCheatSheet) lines.push('See also the [cheat sheet](cheat-sheet.md).', '');

  if (input.feynman) {
    lines.push('## My summary', '', `> ${input.feynman.text.replace(/\n/g, '\n> ')}`, '', linkTimestamps(input.feynman.feedback.trim(), meta.videoId), '');
  }

  if (input.bookmarks?.length) {
    lines.push('## Bookmarks', '');
    for (const b of [...input.bookmarks].sort((x, y) => x.t - y.t)) {
      lines.push(`- ${at(b.t)} ${b.note || b.caption || 'Bookmark'}${b.note && b.caption ? ` — “${b.caption}”` : ''}`);
      const i = img(b.frameId, `Frame at ${formatTime(b.t)}`);
      if (i) lines.push(`  ${i}`);
    }
    lines.push('');
  }

  if (history.length) {
    lines.push('## Questions and answers', '');
    for (const h of history) {
      lines.push(`### ${at(h.at)} ${h.question.replace(/\n+/g, ' ')}`, '');
      const i = img(h.frameId, `Frame at ${formatTime(h.at)}`);
      if (i) lines.push(i, '');
      lines.push(linkTimestamps(h.answer.trim(), meta.videoId), '');
    }
  }

  if (input.mistakes?.length) {
    lines.push('## Mistake log', '');
    for (const m of input.mistakes) {
      lines.push(`- ${m.at !== null ? `${at(m.at)} ` : ''}${m.question.replace(/\n+/g, ' ')}${m.confidence === 'high' ? ' _(was sure)_' : ''}`);
      if (m.answer) lines.push(`  - My answer: ${m.answer.replace(/\n+/g, ' ')}`);
      if (m.misconception) lines.push(`  - Misconception: ${m.misconception}`);
      if (m.correction) lines.push(`  - Correction: ${linkTimestamps(m.correction, meta.videoId)}`);
    }
    lines.push('');
  }

  if (checkpoints.length) {
    lines.push('## Checkpoints', '');
    for (const c of checkpoints) {
      lines.push(`- ${at(c.at)} ${c.question} — _${VERDICT_LABEL[c.verdict] ?? c.verdict}_`);
      if (c.answer) lines.push(`  - My answer: ${c.answer.replace(/\n+/g, ' ')}`);
      if (c.feedback) lines.push(`  - Feedback: ${linkTimestamps(c.feedback.replace(/\n+/g, ' '), meta.videoId)}`);
    }
    lines.push('');
  }

  if (teachBacks.length) {
    lines.push('## Explained back', '');
    for (const t of teachBacks) {
      const sec = map?.sections[t.sectionIndex];
      lines.push(`### ${sec ? `${at(sec.start)} ${sec.title}` : 'Section'} — ${t.verdict === 'solid' ? 'solid' : 'gaps found'}`, '', `> ${t.text.replace(/\n/g, '\n> ')}`, '', linkTimestamps(t.feedback.trim(), meta.videoId), '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------- Anki ----------

export interface Card {
  front: string;
  back: string;
  tags: string[];
}

/** Markdown-ish text to Anki-friendly HTML: escape, MathJax delimiters, line breaks. */
export function toAnkiHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = escape(text.trim());
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, m: string) => `\\[${m.trim()}\\]`);
  out = out.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre: string, m: string) => `${pre}\\(${m}\\)`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return out.replace(/\r?\n/g, '<br>');
}

function csvField(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Anki "Import file" CSV: comma-separated, HTML on, tags in column 3. */
export function toAnkiCsv(cards: Card[]): string {
  const header = ['#separator:comma', '#html:true', '#tags column:3', '#columns:Front,Back,Tags'];
  const rows = cards.map((c) => [csvField(c.front), csvField(c.back), csvField(c.tags.join(' '))].join(','));
  return [...header, ...rows].join('\n') + '\n';
}

function tagOf(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'video';
}

/** Cards from the shaky concepts and the missed checkpoints. */
export function buildCards(input: Pick<NotesInput, 'meta' | 'map' | 'learner' | 'checkpoints'>): Card[] {
  const { meta, map, learner, checkpoints } = input;
  const baseTag = ['youtube-tutor', tagOf(meta.title || meta.videoId)];
  const where = (t: number | null | undefined) =>
    t == null ? '' : `<br><br><a href="${watchUrl(meta.videoId, t)}">${formatTime(t)} in “${toAnkiHtml(meta.title || meta.videoId)}”</a>`;
  const cards: Card[] = [];
  const fronts = new Set<string>();
  const push = (c: Card) => {
    if (fronts.has(c.front)) return;
    fronts.add(c.front);
    cards.push(c);
  };
  for (const name of conceptsInState(learner, 'shaky')) {
    const c = map?.concepts.find((x) => x.name === name);
    push({
      front: `${toAnkiHtml(name)}: what is it, and why does it matter in this lecture?`,
      back: (c?.summary ? toAnkiHtml(c.summary) : 'Rewatch where it is introduced.') + where(c?.definedAt),
      tags: [...baseTag, 'concept'],
    });
  }
  for (const r of checkpoints) {
    if (r.verdict !== 'partial' && r.verdict !== 'incorrect') continue;
    const cp = map?.checkpoints.find((x) => x.id === r.checkpointId);
    const answer = cp?.answer || r.feedback;
    push({ front: toAnkiHtml(r.question), back: toAnkiHtml(answer) + where(r.at), tags: [...baseTag, 'checkpoint'] });
  }
  return cards;
}

// ---------- zip export with frames (§13.4) ----------

export function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'video'
  );
}

export function frameFileName(frame: { id: string; t: number }, ext = 'jpg'): string {
  const t = Math.floor(frame.t);
  return `images/frame-${String(Math.floor(t / 60)).padStart(2, '0')}m${String(t % 60).padStart(2, '0')}s-${frame.id.slice(-6)}.${ext}`;
}

/**
 * Folder of Markdown + images for Obsidian and similar: <slug>/notes.md, <slug>/cheat-sheet.md and
 * <slug>/images/*. Only frames referenced by bookmarks or questions are included.
 */
export function assembleNotesZip(input: NotesInput & { cheatSheet?: string | null; frames: { id: string; t: number; bytes: Uint8Array; mime: string }[] }): ZipEntry[] {
  const enc = new TextEncoder();
  const used = new Set<string>([...(input.bookmarks ?? []).map((b) => b.frameId), ...input.history.map((h) => h.frameId)].filter((x): x is string => !!x));
  const frameFiles: Record<string, string> = {};
  const images: ZipEntry[] = [];
  for (const f of input.frames) {
    if (!used.has(f.id)) continue;
    const name = frameFileName(f, f.mime === 'image/png' ? 'png' : 'jpg');
    frameFiles[f.id] = name;
    images.push({ path: name, data: f.bytes });
  }
  const dir = `${slug(input.meta.title || input.meta.videoId)}-${input.meta.videoId}`;
  const notes = toMarkdown({ ...input, frameFiles, hasCheatSheet: !!input.cheatSheet });
  const entries: ZipEntry[] = [{ path: `${dir}/notes.md`, data: enc.encode(notes) }];
  if (input.cheatSheet) entries.push({ path: `${dir}/cheat-sheet.md`, data: enc.encode(`# Cheat sheet: ${input.meta.title}\n\n${linkTimestamps(input.cheatSheet.trim(), input.meta.videoId)}\n`) });
  for (const i of images) entries.push({ path: `${dir}/${i.path}`, data: i.data });
  return entries;
}
