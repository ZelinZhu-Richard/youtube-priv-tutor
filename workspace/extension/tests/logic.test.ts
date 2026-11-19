// Context-window selection, learner model, video map, checkpoints, image helpers, settings.
import { describe, expect, it } from 'vitest';
import { crossedCheckpoints, skipTarget } from '../src/shared/checkpoints';
import { chooseTranscriptMode, conceptsNear, currentChapter, currentSectionIndex, defaultCaptionRange, estimateTokens, renderCues, selectWindow } from '../src/shared/context';
import { capSize, containedRect, frameStats, normalizedToPixels, splitDataUrl } from '../src/shared/image';
import { applyLearnerEvent, canonicalConcept, conceptsInState, EMPTY_LEARNER, learnerDigest } from '../src/shared/learner';
import { DEFAULT_SETTINGS, estimateCost, normalizeSettings } from '../src/shared/settings';
import type { VideoMap } from '../src/shared/types';
import { mapDigest, normalizeQuiz, normalizeVideoMap } from '../src/shared/videoMap';

const cues = [
  { start: 0, duration: 10, text: 'a' },
  { start: 10, duration: 10, text: 'b' },
  { start: 100, duration: 10, text: 'c' },
  { start: 200, duration: 10, text: 'd' },
];

describe('context window', () => {
  it('defaults to 90 s before and 15 s after, clamped to the video', () => {
    expect(defaultCaptionRange(120, 1000)).toEqual([30, 135]);
    expect(defaultCaptionRange(20, 30)).toEqual([0, 30]);
  });
  it('selects cues overlapping the range', () => {
    expect(selectWindow(cues, 15, 105).map((c) => c.text)).toEqual(['b', 'c']);
    expect(selectWindow(cues, 300, 400)).toEqual([]);
  });
  it('renders cues with timestamps', () => {
    expect(renderCues(cues.slice(2))).toBe('[1:40] c\n[3:20] d');
  });
  it('estimates tokens for Latin and CJK text', () => {
    expect(estimateTokens('abcd'.repeat(100))).toBe(100);
    expect(estimateTokens('梯度下降')).toBe(4);
  });
  it('chooses full transcript up to the configured length, summary beyond', () => {
    expect(chooseTranscriptMode(50 * 60, 12000, 60)).toBe('full');
    expect(chooseTranscriptMode(2 * 3600, 30000, 60)).toBe('summary');
    expect(chooseTranscriptMode(2 * 3600, 30000, 150)).toBe('full');
  });
  it('finds the current chapter and section', () => {
    const chapters = [
      { start: 0, title: 'A' },
      { start: 60, title: 'B' },
    ];
    expect(currentChapter(chapters, 59)?.title).toBe('A');
    expect(currentChapter(chapters, 60)?.title).toBe('B');
    expect(currentChapter([], 5)).toBeNull();
    expect(currentSectionIndex([{ start: 0, end: 10, title: '', keyIdea: '', questions: [] }], 5)).toBe(0);
  });
});

const map: VideoMap = {
  videoId: 'v',
  createdAt: 0,
  model: 'm',
  sections: [
    { start: 0, end: 300, title: 'Intro', keyIdea: 'k1', questions: [] },
    { start: 300, end: 900, title: 'Softmax', keyIdea: 'k2', questions: [] },
    { start: 900, end: 1200, title: 'Loss', keyIdea: 'k3', questions: [] },
  ],
  concepts: [
    { name: 'logits', definedAt: 120, dependsOn: [], summary: '' },
    { name: 'softmax', definedAt: 400, dependsOn: ['logits'], summary: 'normalised exponentials' },
    { name: 'cross-entropy', definedAt: 950, dependsOn: ['softmax'], summary: '' },
    { name: 'probability', definedAt: null, dependsOn: [], summary: '' },
  ],
  prerequisites: [],
  checkpoints: [],
};

describe('conceptsNear', () => {
  it('prefers concepts defined in the local window, then the section, then the latest earlier one', () => {
    expect(conceptsNear(map, 410)).toEqual(['softmax']);
    expect(conceptsNear(map, 800)).toEqual(['softmax']);
    expect(conceptsNear(map, 1150)).toEqual(['cross-entropy']);
    expect(conceptsNear(null, 10)).toEqual([]);
  });
});

describe('learner model transitions (§12.5)', () => {
  it('unseen -> seen when watched past the definition', () => {
    const m = applyLearnerEvent(EMPTY_LEARNER, { type: 'watched', t: 500 }, map, 1);
    expect(m.concepts.logits.state).toBe('seen');
    expect(m.concepts.softmax.state).toBe('seen');
    expect(m.concepts['cross-entropy']).toBeUndefined();
  });
  it("I'm lost and Simpler mark shaky; correct checkpoint and good teach-back mark solid", () => {
    let m = applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['Softmax'] }, map, 1);
    expect(m.concepts.softmax.state).toBe('shaky');
    m = applyLearnerEvent(m, { type: 'checkpoint', verdict: 'correct', concepts: ['softmax'] }, map, 2);
    expect(m.concepts.softmax.state).toBe('solid');
    m = applyLearnerEvent(m, { type: 'simpler', concepts: ['softmax'] }, map, 3);
    expect(m.concepts.softmax.state).toBe('shaky');
    m = applyLearnerEvent(m, { type: 'teachback', verdict: 'solid', concepts: ['softmax'] }, map, 4);
    expect(m.concepts.softmax.state).toBe('solid');
    expect(m.concepts.softmax.evidence).toEqual(['lost', 'checkpoint', 'simpler', 'teachback']);
  });
  it('wrong or partial checkpoints mark shaky; skipped changes nothing; watching never demotes', () => {
    let m = applyLearnerEvent(EMPTY_LEARNER, { type: 'checkpoint', verdict: 'partial', concepts: ['logits'] }, map);
    expect(m.concepts.logits.state).toBe('shaky');
    const same = applyLearnerEvent(m, { type: 'checkpoint', verdict: 'skipped', concepts: ['logits'] }, map);
    expect(same).toBe(m);
    m = applyLearnerEvent(m, { type: 'watched', t: 2000 }, map);
    expect(m.concepts.logits.state).toBe('shaky');
  });
  it('does not mutate its input and keeps unknown concept names', () => {
    const before = applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['attention'] }, map);
    const snapshot = JSON.stringify(before);
    applyLearnerEvent(before, { type: 'quiz', correct: true, concepts: ['attention'] }, map);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(before.concepts.attention.state).toBe('shaky');
    expect(canonicalConcept('SOFTMAX', map)).toBe('softmax');
  });
  it('summarises solid and shaky concepts for the tutor', () => {
    let m = applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['softmax'] }, map, 1);
    m = applyLearnerEvent(m, { type: 'checkpoint', verdict: 'correct', concepts: ['logits'] }, map, 2);
    expect(learnerDigest(m)).toBe('Shaky (revisit gently, check understanding): softmax\nSolid (do not re-explain at length): logits');
    expect(learnerDigest(EMPTY_LEARNER)).toBe('');
    expect(conceptsInState(m, 'shaky')).toEqual(['softmax']);
  });
});

describe('normalizeVideoMap', () => {
  const raw = {
    sections: [
      { start: '5:00', end: '4:00', title: 'Softmax', key_idea: 'k2', suggested_questions: ['q1', 'q2', 'q3', 'q4'] },
      { start: '0:00', end: '5:00', title: 'Intro', key_idea: 'k1', suggested_questions: [] },
      { start: 'bogus', end: '', title: 'x', key_idea: '', suggested_questions: [] },
      { start: '15:00', end: '99:00', title: 'Loss', key_idea: 'k3', suggested_questions: [] },
    ],
    concepts: [
      { name: 'softmax', first_defined_at: '6:40', depends_on: ['logits'], summary: 's' },
      { name: 'Softmax', first_defined_at: '7:00', depends_on: [], summary: 'dup' },
      { name: 'probability', first_defined_at: '', depends_on: [], summary: '' },
    ],
    prerequisites: ['calculus', 'calculus', ''],
    checkpoints: [
      { at: '14:00', section_index: 1, type: 'predict', question: 'What prints?', answer: '0.5', concepts: ['softmax'] },
      { at: '14:30', section_index: 1, type: 'weird', question: 'Second in same section', answer: '', concepts: [] },
      { at: '16:00', section_index: 7, type: 'find-bug', question: 'Bug?', answer: 'off by one', concepts: [] },
    ],
  };
  const m = normalizeVideoMap(raw, 'v', 1200, 'claude-sonnet-5-5', 42);

  it('sorts, drops invalid sections, makes them contiguous and clamps to the duration', () => {
    expect(m.sections.map((s) => [s.title, s.start, s.end])).toEqual([
      ['Intro', 0, 300],
      ['Softmax', 300, 900],
      ['Loss', 900, 1200],
    ]);
    expect(m.sections[1].questions).toEqual(['q1', 'q2', 'q3']);
  });
  it('dedupes concepts case-insensitively and keeps undefined definitions as null', () => {
    expect(m.concepts.map((c) => [c.name, c.definedAt])).toEqual([
      ['softmax', 400],
      ['probability', null],
    ]);
    expect(m.prerequisites).toEqual(['calculus']);
  });
  it('keeps at most one checkpoint per section and repairs bad section indexes and types', () => {
    expect(m.checkpoints.map((c) => [c.id, c.sectionIndex, c.type])).toEqual([
      ['cp-840', 1, 'predict'],
      ['cp-960', 2, 'find-bug'],
    ]);
  });
  it('produces a deterministic digest for the cached prefix', () => {
    const d = mapDigest(m);
    expect(d).toContain('[5:00–15:00] Softmax — k2');
    expect(d).toContain('- softmax [6:40]; builds on: logits — s');
    expect(d).toContain('probability not defined in the video');
    expect(mapDigest(m)).toBe(d);
  });
  it('never throws on garbage', () => {
    expect(normalizeVideoMap(null, 'v', 0, 'm').sections).toEqual([]);
    expect(normalizeQuiz({ items: [{ question: 'Q', answer: 'A', concept: 'c', at: '1:00' }, { question: '' }] })).toEqual([{ question: 'Q', answer: 'A', concept: 'c', at: 60 }]);
  });
});

describe('checkpoints and skipping (§12.4, §12.6)', () => {
  const items = [
    { id: 'a', at: 100 },
    { id: 'b', at: 200 },
  ];
  it('fires when playback crosses a checkpoint', () => {
    expect(crossedCheckpoints(99.5, 100.2, items, new Set())).toEqual(['a']);
    expect(crossedCheckpoints(99.5, 100.2, items, new Set(['a']))).toEqual([]);
  });
  it('does not fire on seeks or going backwards', () => {
    expect(crossedCheckpoints(50, 150, items, new Set())).toEqual([]);
    expect(crossedCheckpoints(101, 99, items, new Set())).toEqual([]);
  });
  it('offers to skip to the end of a run of known sections', () => {
    expect(skipTarget(map.sections, new Set([1, 2]), 350)).toEqual({ from: 1, to: 1200 });
    expect(skipTarget(map.sections, new Set([1]), 100)).toBeNull();
  });
});

describe('image helpers', () => {
  it('caps the long edge at 1568 without upscaling', () => {
    expect(capSize(1920, 1080)).toEqual({ width: 1568, height: 882 });
    expect(capSize(3840, 2160)).toEqual({ width: 1568, height: 882 });
    expect(capSize(854, 480)).toEqual({ width: 854, height: 480 });
    expect(capSize(1080, 1920)).toEqual({ width: 882, height: 1568 });
  });
  it('flags uniform frames as blank', () => {
    const black = new Uint8ClampedArray(64 * 4);
    expect(frameStats(black).blank).toBe(true);
    const slide = new Uint8ClampedArray(64 * 4).map((_, i) => (Math.floor(i / 4) % 8 === 0 ? 0 : 250));
    expect(frameStats(slide).blank).toBe(false);
  });
  it('maps normalised selections to pixels, whichever way they were dragged', () => {
    expect(normalizedToPixels({ x: 0.5, y: 0.5, width: -0.25, height: -0.5 }, 1000, 800)).toEqual({ x: 250, y: 0, width: 250, height: 400 });
    expect(normalizedToPixels({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 100, 100)).toEqual({ x: 90, y: 90, width: 10, height: 10 });
  });
  it('finds the letterboxed picture inside the video element', () => {
    const r = containedRect(1000, 1000, 1920, 1080);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(218.75);
    expect(r.width).toBeCloseTo(1000);
    expect(r.height).toBeCloseTo(562.5);
  });
  it('splits data URLs', () => {
    expect(splitDataUrl('data:image/png;base64,QUJD')).toEqual({ mediaType: 'image/png', data: 'QUJD' });
    expect(splitDataUrl('nope')).toBeNull();
  });
});

describe('settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ model: 'gpt', effort: 'max', historyTurns: 99, checkpointMode: 'active' })).toEqual({ ...DEFAULT_SETTINGS, checkpointMode: 'active' });
    expect(DEFAULT_SETTINGS.model).toBe('claude-sonnet-5-5');
  });
  it('estimates cost with cache reads and writes', () => {
    expect(estimateCost('claude-sonnet-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(2);
    expect(estimateCost('claude-sonnet-5-5', { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(0.1 + 2.5);
  });
});
