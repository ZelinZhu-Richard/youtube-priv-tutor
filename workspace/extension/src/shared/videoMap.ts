// The video map (§12.1): JSON schema for the model's structured output, validation/normalisation
// of what comes back, and the text digest passed to the tutor. Pure functions.
import { formatTime, parseTime } from './time';
import type { CheckpointType, MapCheckpoint, MapConcept, MapSection, QuizItem, VideoMap } from './types';

const CHECKPOINT_TYPES: CheckpointType[] = ['predict', 'next-step', 'find-bug', 'valid-argument', 'explain-why'];

const strArray = { type: 'array', items: { type: 'string' } } as const;

/** Structured-output schema for the one-call-per-video lesson map. Times are "m:ss" / "h:mm:ss" strings. */
export const VIDEO_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'concepts', 'prerequisites', 'checkpoints', 'notation', 'pre_questions', 'prerequisite_checks'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'title', 'key_idea', 'suggested_questions'],
        properties: {
          start: { type: 'string', description: 'Section start as m:ss or h:mm:ss' },
          end: { type: 'string', description: 'Section end as m:ss or h:mm:ss' },
          title: { type: 'string' },
          key_idea: { type: 'string', description: 'One sentence' },
          suggested_questions: { ...strArray, description: '2-3 questions a good student would ask here' },
        },
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'first_defined_at', 'depends_on', 'summary'],
        properties: {
          name: { type: 'string' },
          first_defined_at: { type: 'string', description: 'm:ss where the video first defines or introduces it; empty string if never defined' },
          depends_on: { ...strArray, description: 'Names of other concepts in this list it builds on' },
          summary: { type: 'string', description: 'One or two sentences, as the video uses the concept; LaTeX allowed' },
        },
      },
    },
    prerequisites: { ...strArray, description: 'What the video assumes but never explains' },
    checkpoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['at', 'section_index', 'type', 'question', 'answer', 'concepts'],
        properties: {
          at: { type: 'string', description: 'm:ss of a natural pause; for predict, just before the reveal' },
          section_index: { type: 'integer' },
          type: { type: 'string', enum: CHECKPOINT_TYPES },
          question: { type: 'string' },
          answer: { type: 'string', description: 'A model answer used for grading' },
          concepts: strArray,
        },
      },
    },
    notation: {
      type: 'array',
      description: 'Symbols and notation as the video introduces them',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'meaning', 'defined_at'],
        properties: {
          symbol: { type: 'string', description: 'LaTeX, e.g. \\theta or W^{[l]}' },
          meaning: { type: 'string' },
          defined_at: { type: 'string', description: 'm:ss where it is introduced, or empty string' },
        },
      },
    },
    pre_questions: {
      type: 'array',
      description: 'Exactly 3 questions the video will answer, to ask before watching',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer', 'answered_at'],
        properties: { question: { type: 'string' }, answer: { type: 'string' }, answered_at: { type: 'string', description: 'm:ss' } },
      },
    },
    prerequisite_checks: {
      type: 'array',
      description: '2-4 quick diagnostic questions on the prerequisites',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prerequisite', 'question', 'answer'],
        properties: { prerequisite: { type: 'string' }, question: { type: 'string' }, answer: { type: 'string' } },
      },
    },
  },
} as const;

export const QUIZ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer', 'concept', 'at'],
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          concept: { type: 'string' },
          at: { type: 'string', description: 'm:ss in the video to rewatch, or empty string' },
        },
      },
    },
  },
} as const;

const s = (x: unknown, max = 600): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const sa = (x: unknown, maxItems: number, maxLen = 300): string[] =>
  Array.isArray(x) ? x.map((v) => s(v, maxLen)).filter(Boolean).slice(0, maxItems) : [];
const time = (x: unknown): number | null => (typeof x === 'string' && x.trim() ? parseTime(x) : typeof x === 'number' ? x : null);

/** Validates and tidies a raw map from the model. Never throws; drops what it cannot use. */
export function normalizeVideoMap(raw: unknown, videoId: string, duration: number, model: string, now = Date.now()): VideoMap {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dur = duration > 0 ? duration : Infinity;
  const clamp = (t: number) => Math.min(Math.max(0, t), dur);

  let sections: MapSection[] = (Array.isArray(r.sections) ? r.sections : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const start = time(o.start);
      if (start === null) return null;
      return {
        start: clamp(start),
        end: clamp(time(o.end) ?? start),
        title: s(o.title, 120) || 'Untitled section',
        keyIdea: s(o.key_idea),
        questions: sa(o.suggested_questions, 3),
      };
    })
    .filter((x): x is MapSection => x !== null)
    .sort((a, b) => a.start - b.start);
  // Drop duplicate starts and make sections contiguous: each ends where the next begins.
  sections = sections.filter((sec, i) => i === 0 || sec.start > sections[i - 1].start);
  // The first section covers the opening, so there is always a current section.
  if (sections.length && sections[0].start > 0) sections[0].start = 0;
  sections.forEach((sec, i) => {
    const next = sections[i + 1];
    if (next) sec.end = next.start;
    else if (!(sec.end > sec.start)) sec.end = Number.isFinite(dur) ? dur : sec.start + 60;
  });

  const seen = new Set<string>();
  const concepts: MapConcept[] = (Array.isArray(r.concepts) ? r.concepts : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const name = s(o.name, 80);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return null;
      seen.add(key);
      const at = time(o.first_defined_at);
      return { name, definedAt: at === null ? null : clamp(at), dependsOn: sa(o.depends_on, 8, 80), summary: s(o.summary) };
    })
    .filter((x): x is MapConcept => x !== null)
    .slice(0, 80);

  const usedSections = new Set<number>();
  const checkpoints: MapCheckpoint[] = (Array.isArray(r.checkpoints) ? r.checkpoints : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const at = time(o.at);
      const question = s(o.question);
      if (at === null || !question) return null;
      const t = clamp(at);
      let si = typeof o.section_index === 'number' ? Math.round(o.section_index) : -1;
      const containing = sections.findIndex((sec) => t >= sec.start && t < sec.end);
      if (si < 0 || si >= sections.length || !(t >= sections[si].start && t <= sections[si].end)) si = containing;
      const type = CHECKPOINT_TYPES.includes(o.type as CheckpointType) ? (o.type as CheckpointType) : 'explain-why';
      return { id: `cp-${Math.round(t)}`, at: t, sectionIndex: si, type, question, answer: s(o.answer, 1200), concepts: sa(o.concepts, 6, 80) };
    })
    .filter((x): x is MapCheckpoint => x !== null)
    .sort((a, b) => a.at - b.at)
    .filter((cp) => {
      // At most one checkpoint per section (§12.1).
      if (cp.sectionIndex < 0) return true;
      if (usedSections.has(cp.sectionIndex)) return false;
      usedSections.add(cp.sectionIndex);
      return true;
    });

  const objs = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]).filter((o) => o && typeof o === 'object') : []);
  const notation = objs(r.notation)
    .map((o) => ({ symbol: s(o.symbol, 120), meaning: s(o.meaning, 300), definedAt: ((t) => (t === null ? null : clamp(t)))(time(o.defined_at)), source: 'map' as const }))
    .filter((n) => n.symbol && n.meaning)
    .slice(0, 60);
  const preQuestions = objs(r.pre_questions)
    .map((o) => ({ question: s(o.question), answer: s(o.answer, 1000), at: ((t) => (t === null ? null : clamp(t)))(time(o.answered_at)) }))
    .filter((q) => q.question)
    .slice(0, 3);
  const prerequisiteChecks = objs(r.prerequisite_checks)
    .map((o) => ({ prerequisite: s(o.prerequisite, 120), question: s(o.question), answer: s(o.answer, 1000) }))
    .filter((q) => q.question)
    .slice(0, 4);
  return { videoId, createdAt: now, model, sections, concepts, prerequisites: [...new Set(sa(r.prerequisites, 12))], checkpoints, notation, preQuestions, prerequisiteChecks };
}

export function normalizeQuiz(raw: unknown): QuizItem[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return (Array.isArray(r.items) ? r.items : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const question = s(o.question, 800);
      if (!question) return null;
      return { question, answer: s(o.answer, 1500), concept: s(o.concept, 80), at: time(o.at) };
    })
    .filter((x): x is QuizItem => x !== null)
    .slice(0, 8);
}

/** Text digest of the map for the tutor's cached context. Deterministic for a given map. */
export function mapDigest(map: VideoMap): string {
  const lines: string[] = [];
  lines.push('Sections:');
  for (const sec of map.sections) {
    lines.push(`[${formatTime(sec.start)}–${formatTime(sec.end)}] ${sec.title}${sec.keyIdea ? ` — ${sec.keyIdea}` : ''}`);
  }
  if (map.concepts.length) {
    lines.push('', 'Concepts (where first defined):');
    for (const c of map.concepts) {
      const at = c.definedAt === null ? 'not defined in the video' : `[${formatTime(c.definedAt)}]`;
      const deps = c.dependsOn.length ? `; builds on: ${c.dependsOn.join(', ')}` : '';
      lines.push(`- ${c.name} ${at}${deps}${c.summary ? ` — ${c.summary}` : ''}`);
    }
  }
  if (map.notation?.length) {
    lines.push('', 'Notation:');
    for (const n of map.notation) lines.push(`- ${n.symbol}: ${n.meaning}${n.definedAt !== null ? ` [${formatTime(n.definedAt)}]` : ''}`);
  }
  if (map.prerequisites.length) lines.push('', `Assumed but not explained: ${map.prerequisites.join('; ')}`);
  return lines.join('\n');
}
