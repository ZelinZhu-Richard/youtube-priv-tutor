// Second build (§13): scheduler, frames, signals, library, practice, zip, export, glossary.
import { describe, expect, it } from 'vitest';
import { emptyVideo } from '../src/shared/db';
import { assembleNotesZip, frameFileName, slug, toMarkdown } from '../src/shared/export';
import { detectBackwardReference, dHash, edgeDensity, hamming, isNearDuplicate, nearestFrame, previousDistinct, pruneFrames, toGray } from '../src/shared/frames';
import { glossaryEntries, glossaryUpTo, mergeNotation } from '../src/shared/glossary';
import { applyLearnerEvent, EMPTY_LEARNER } from '../src/shared/learner';
import {
  buildSearchDocs,
  carryOver,
  conceptIndex,
  connectionsText,
  earlierInPlaylist,
  findConnections,
  findPriorTeaching,
  layoutGraph,
  migrateV1,
  searchLibrary,
  studyOrder,
  tokenize,
} from '../src/shared/library';
import { buildJsHarness, calibration, isSureButWrong, nextHint, normalizeProblems, parseHarnessResult, revealedHints, summarizeRun, visibleSteps } from '../src/shared/practice';
import { contextBlocks, parseVerdict, profileText, turnText } from '../src/shared/prompt';
import { detectRewindConfusion, pauseConfusion, sectionDensity, suggestRate } from '../src/shared/signals';
import { cardsForVideo, checkpointCard, DAY, interleave, mistakeCard, newCard, schedule, upsertCard } from '../src/shared/srs';
import type { HistoryEntry, Mistake, VideoMap, VideoRecord } from '../src/shared/types';
import { normalizeVideoMap } from '../src/shared/videoMap';
import { buildZip, crc32 } from '../src/shared/zip';

const NOW = 1_800_000_000_000;

const map: VideoMap = {
  videoId: 'v1',
  createdAt: 0,
  model: 'm',
  sections: [
    { start: 0, end: 300, title: 'Intro', keyIdea: 'k', questions: [] },
    { start: 300, end: 600, title: 'Softmax', keyIdea: 'k', questions: [] },
  ],
  concepts: [
    { name: 'logits', definedAt: 100, dependsOn: [], summary: 'raw scores' },
    { name: 'softmax', definedAt: 320, dependsOn: ['logits'], summary: 'normalised exponentials' },
    { name: 'temperature', definedAt: 400, dependsOn: ['softmax'], summary: 'scales logits' },
  ],
  prerequisites: ['exponentials'],
  checkpoints: [{ id: 'cp-500', at: 500, sectionIndex: 1, type: 'predict', question: 'What sums to one?', answer: 'The softmax outputs.', concepts: ['softmax'] }],
  notation: [{ symbol: '\\sigma(z)', meaning: 'softmax of z', definedAt: 330, source: 'map' }],
};

function video(id: string, over: Partial<VideoRecord> = {}): VideoRecord {
  return { ...emptyVideo(id, NOW), title: `Video ${id}`, map: { ...map, videoId: id }, ...over };
}

describe('spaced review scheduler (SM-2 style)', () => {
  const base = newCard({ id: 'c', videoId: 'v', videoTitle: 'V', concept: 'x', kind: 'concept', front: 'f', back: 'b', at: null }, NOW);
  it('grows intervals 1 -> 6 -> ease x for "good"', () => {
    const a = schedule(base, 'good', NOW);
    expect(a.interval).toBe(1);
    expect(a.due).toBe(NOW + DAY);
    const b = schedule(a, 'good', NOW);
    expect(b.interval).toBe(6);
    const c = schedule(b, 'good', NOW);
    expect(c.interval).toBeCloseTo(15);
  });
  it('"again" resets reps, lowers ease, and returns in 10 minutes', () => {
    const r = schedule(schedule(base, 'good', NOW), 'again', NOW);
    expect(r.reps).toBe(0);
    expect(r.lapses).toBe(1);
    expect(r.ease).toBeCloseTo(2.3);
    expect(r.due).toBe(NOW + 600_000);
  });
  it('"easy" schedules further than "hard", and ease never drops below 1.3', () => {
    expect(schedule(base, 'easy', NOW).interval).toBeGreaterThan(schedule(base, 'hard', NOW).interval);
    let c = base;
    for (let i = 0; i < 20; i++) c = schedule(c, 'again', NOW);
    expect(c.ease).toBe(1.3);
  });
  it('interleaves across videos and puts "sure but wrong" first', () => {
    const mk = (id: string, videoId: string, due: number, priority = 0) => ({ ...base, id, videoId, due, priority });
    const order = interleave([mk('a1', 'A', 1), mk('a2', 'A', 2), mk('a3', 'A', 3), mk('b1', 'B', 1.5), mk('b2', 'B', 2.5), mk('p', 'C', 9, 2)]).map((c) => c.id);
    expect(order).toEqual(['p', 'a1', 'b1', 'a2', 'b2', 'a3']);
  });
  it('upsert keeps the schedule and can bring a card back now', () => {
    const scheduled = schedule(base, 'good', NOW);
    const fresh = { ...base, back: 'new back', priority: 2 };
    const u = upsertCard(scheduled, fresh, true, NOW + 5);
    expect(u.back).toBe('new back');
    expect(u.reps).toBe(1);
    expect(u.priority).toBe(2);
    expect(u.due).toBe(NOW + 5);
  });
  it('builds cards from shaky concepts, missed checkpoints and mistakes', () => {
    const v = video('v1', {
      learner: applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['softmax'] }, map),
      checkpointResults: [{ checkpointId: 'cp-500', question: 'What sums to one?', at: 500, answer: 'logits', verdict: 'incorrect', feedback: 'f', concepts: ['softmax'], createdAt: 0, confidence: 'high' }],
    });
    const cards = cardsForVideo(v, NOW);
    expect(cards.map((c) => c.id)).toEqual(['concept:v1:softmax', 'checkpoint:v1:cp-500']);
    expect(cards[0].back).toContain('normalised exponentials');
    expect(cards[0].back).toContain('t=320s');
    expect(checkpointCard(v, v.checkpointResults[0], NOW).priority).toBe(2);
    const m: Mistake = { id: 'm1', videoId: 'v1', at: 10, source: 'problem', question: 'Q', answer: 'A', misconception: 'thinks X', correction: 'Y', confidence: 'medium', concepts: [], createdAt: 0 };
    expect(mistakeCard(m, 'V', NOW).back).toContain('**Misconception:** thinks X');
  });
});

describe('frame buffer', () => {
  const grid = (f: (x: number, y: number) => number) => Uint8Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));
  it('hashes, measures distance and spots near-duplicates', () => {
    const a = dHash(grid((x) => x * 20));
    const b = dHash(grid((x) => x * 20 + (x === 4 ? 30 : 0)));
    const c = dHash(grid((x) => 200 - x * 20));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(a, a)).toBe(0);
    expect(hamming(a, b)).toBeLessThanOrEqual(8);
    expect(hamming(a, c)).toBe(64);
    expect(isNearDuplicate(a, [c, a])).toBe(true);
    expect(isNearDuplicate(c, [a])).toBe(false);
  });
  it('converts RGBA to gray and measures edge density', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    expect([...toGray(rgba, 2, 1)]).toEqual([255, 0]);
    const flat = new Uint8Array(100).fill(128);
    const text = Uint8Array.from({ length: 100 }, (_, i) => (i % 2 ? 0 : 255));
    expect(edgeDensity(flat, 10, 10)).toBe(0);
    expect(edgeDensity(text, 10, 10)).toBeGreaterThan(0.5);
  });
  const frames = [
    { id: 'a', t: 10, hash: '0000000000000000', kind: 'sample' as const, createdAt: 1 },
    { id: 'b', t: 25, hash: '0000000000000001', kind: 'sample' as const, createdAt: 2 },
    { id: 'c', t: 40, hash: 'ffffffffffffffff', kind: 'sample' as const, createdAt: 3 },
    { id: 'd', t: 55, hash: 'ffffffff00000000', kind: 'bookmark' as const, createdAt: 4 },
  ];
  it('keeps the newest samples and every bookmark frame', () => {
    expect(pruneFrames(frames, 2)).toEqual(['a']);
    expect(pruneFrames(frames, 0)).toEqual(['c', 'b', 'a']);
  });
  it('finds the nearest frame and the n-th previous distinct screen', () => {
    expect(nearestFrame(frames, 30)?.id).toBe('b');
    expect(nearestFrame(frames, 300, 20)).toBeNull();
    expect(previousDistinct(frames, 60, 'ffffffff00000000', 1)?.id).toBe('c');
    expect(previousDistinct(frames, 60, 'ffffffff00000000', 2)?.id).toBe('b');
  });
  it('detects questions about earlier screens', () => {
    expect(detectBackwardReference('what was the formula at 12:30?')).toEqual({ kind: 'time', t: 750 });
    expect(detectBackwardReference('explain the equation from two slides ago')).toEqual({ kind: 'relative', steps: 2 });
    expect(detectBackwardReference('what was on the previous slide')).toEqual({ kind: 'relative', steps: 1 });
    expect(detectBackwardReference('上一页的公式是什么意思')).toEqual({ kind: 'relative', steps: 1 });
    expect(detectBackwardReference('why do we divide by n-1?')).toBeNull();
  });
});

describe('confusion signals and smart speed', () => {
  it('flags two rewinds over the same stretch', () => {
    const seeks = [
      { from: 130, to: 100, at: NOW - 60_000 },
      { from: 128, to: 105, at: NOW - 10_000 },
    ];
    expect(detectRewindConfusion(seeks, NOW)).toEqual({ from: 100, to: 130 });
    expect(detectRewindConfusion([seeks[1]], NOW)).toBeNull();
    expect(detectRewindConfusion([{ from: 50, to: 10, at: NOW - 60_000 }, { from: 300, to: 250, at: NOW }], NOW)).toBeNull();
    expect(detectRewindConfusion(seeks, NOW + 10 * 60_000)).toBeNull();
    expect(detectRewindConfusion([{ from: 100, to: 200, at: NOW }, { from: 110, to: 190, at: NOW }], NOW)).toBeNull();
  });
  it('flags rewinding again while re-watching (pattern seen on the live player) but not a double-tap', () => {
    // Observed live: 67 -> 47, watched to 49, then 49 -> 34.
    expect(detectRewindConfusion([{ from: 67, to: 47, at: NOW - 4000 }, { from: 49, to: 34, at: NOW - 1500 }], NOW)).toEqual({ from: 34, to: 67 });
    // Two quick presses of the back key: one intent, not confusion.
    expect(detectRewindConfusion([{ from: 100, to: 95, at: NOW - 600 }, { from: 95.2, to: 90.2, at: NOW - 300 }], NOW)).toBeNull();
  });
  it('flags long pauses on dense frames only', () => {
    expect(pauseConfusion(40, 0.12)).toBe(true);
    expect(pauseConfusion(40, 0.01)).toBe(false);
    expect(pauseConfusion(5, 0.2)).toBe(false);
    expect(pauseConfusion(40, null)).toBe(false);
  });
  it('suggests rates per section', () => {
    expect(suggestRate({ known: true, shaky: false, density: 0, base: 1 })).toEqual({ rate: 1.5, reason: 'known' });
    expect(suggestRate({ known: false, shaky: true, density: 0, base: 1 })).toEqual({ rate: 0.75, reason: 'shaky' });
    expect(suggestRate({ known: false, shaky: false, density: 2, base: 1.25 })).toEqual({ rate: 1, reason: 'dense' });
    expect(suggestRate({ known: false, shaky: false, density: 0.2, base: 1.25 })).toEqual({ rate: 1.25, reason: 'normal' });
    expect(sectionDensity(map, 1)).toBeCloseTo(3 / 5);
  });
});

describe('migration from the first build', () => {
  const h: Omit<HistoryEntry, 'videoId'> = { id: 'h1', kind: 'question', question: 'q', userText: 'u', answer: 'a', at: 5, createdAt: 1, model: 'm', hadFrame: false, hadCrop: false, captionRange: null, concepts: [] };
  const local = {
    apiKey: 'sk-ant-should-not-move',
    settings: {},
    videoIndex: { v1: { title: 'Lecture 1', updatedAt: 50 } },
    'v:v1:history': [h],
    'v:v1:map': map,
    'v:v1:learner': applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['softmax'] }, map),
    'v:v1:checkpoints': [{ checkpointId: 'cp-500', question: 'q', at: 500, answer: '', verdict: 'skipped', feedback: '', concepts: [], createdAt: 1 }],
    'v:v1:known': [1],
    'v:v1:progress': { lastT: 321, updatedAt: 60 },
    'v:v1:quiz': [{ question: 'Q', answer: 'A', concept: 'softmax', at: null }],
    'v:v2:history': [h],
  };
  const session = { 'm:v1': { videoId: 'v1', title: 'Lecture 1 (full)', channel: 'Ch', lengthSeconds: 600, isLive: false, chapters: [], tracks: [], originalLanguage: 'en' }, 't:v1': { videoId: 'v1', lang: 'en', trackName: 'English', isAuto: false, source: 'player', cues: [{ start: 0, duration: 2, text: 'hi' }] } };
  const r = migrateV1(local, session, NOW);
  it('carries every per-video kind into video records', () => {
    expect(r.videos.map((v) => v.videoId).sort()).toEqual(['v1', 'v2']);
    const v1 = r.videos.find((v) => v.videoId === 'v1')!;
    expect(v1.title).toBe('Lecture 1 (full)');
    expect(v1.channel).toBe('Ch');
    expect(v1.lastT).toBe(321);
    expect(v1.map?.concepts).toHaveLength(3);
    expect(v1.learner.concepts.softmax.state).toBe('shaky');
    expect(v1.known).toEqual([1]);
    expect(v1.quiz).toHaveLength(1);
    expect(v1.checkpointResults).toHaveLength(1);
    expect(v1.feynman).toBeNull();
  });
  it('adds videoId to history, keeps transcripts, and never touches the key or settings', () => {
    expect(r.history.map((x) => x.videoId).sort()).toEqual(['v1', 'v2']);
    expect(r.transcripts).toHaveLength(1);
    expect(r.migratedKeys).toContain('v:v1:map');
    expect(r.migratedKeys).toContain('videoIndex');
    expect(r.migratedKeys).not.toContain('apiKey');
    expect(r.migratedKeys).not.toContain('settings');
  });
  it('is a no-op on empty storage', () => {
    expect(migrateV1({}, {}, NOW)).toEqual({ videos: [], history: [], transcripts: [], migratedKeys: [] });
  });
});

describe('library', () => {
  const a = video('A', { createdAt: 1, title: 'Intro to softmax', learner: applyLearnerEvent(EMPTY_LEARNER, { type: 'checkpoint', verdict: 'correct', concepts: ['softmax'] }, map) });
  const b = video('B', { createdAt: 2, title: 'Attention', map: { ...map, videoId: 'B', concepts: [{ name: 'Softmax', definedAt: 30, dependsOn: [], summary: '' }, { name: 'attention', definedAt: 60, dependsOn: ['softmax'], summary: '' }] } });
  it('tokenizes Latin and CJK text', () => {
    expect(tokenize('The Soft-max, 梯度!')).toEqual(['the', 'soft', 'max', '梯', '度']);
  });
  it('searches notes, questions, bookmarks, mistakes and transcripts', () => {
    const docs = buildSearchDocs({
      videos: [a, b],
      history: [{ id: 'h', videoId: 'A', kind: 'question', question: 'why subtract the max in softmax?', userText: '', answer: 'numerical stability', at: 330, createdAt: 0, model: '', hadFrame: false, hadCrop: false, captionRange: null, concepts: [] }],
      bookmarks: [{ id: 'k', videoId: 'B', t: 61, frameId: null, caption: 'attention weights', note: 'the key slide', createdAt: 0 }],
      mistakes: [],
      transcripts: [{ videoId: 'B', lang: 'en', trackName: '', isAuto: false, source: 'player', cues: [{ start: 70, duration: 3, text: 'the softmax turns scores into weights' }] }],
    });
    const hits = searchLibrary(docs, 'softmax');
    expect(hits[0].kind).toBe('title');
    expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(['question', 'transcript']));
    expect(searchLibrary(docs, 'key slide')[0]).toMatchObject({ kind: 'bookmark', videoId: 'B', at: 61 });
    expect(searchLibrary(docs, 'softmax stability')).toHaveLength(1);
    expect(searchLibrary(docs, '')).toEqual([]);
  });
  it('indexes concepts across videos with their latest state', () => {
    const idx = conceptIndex([a, b]);
    const sm = idx.get('softmax')!;
    expect(sm.occurrences.map((o) => o.videoId)).toEqual(['A', 'B']);
    expect(sm.state).toBe('solid');
    expect(idx.get('attention')?.dependsOn).toEqual(['softmax']);
  });
  it('finds connections to earlier videos only', () => {
    const conns = findConnections(b, [a, b]);
    expect(conns).toEqual([{ concept: 'Softmax', videoId: 'A', title: 'Intro to softmax', at: 320 }]);
    expect(findConnections(a, [a, b])).toEqual([]);
    expect(connectionsText(conns)).toContain('https://www.youtube.com/watch?v=A&t=320s');
    expect(findPriorTeaching('logits', [a, b], 'B')?.videoId).toBe('A');
  });
  it('orders study by playlist position, else first-studied time', () => {
    const p1 = video('P1', { createdAt: 9, playlist: { id: 'L', title: 'Course', index: 0 } });
    const p2 = video('P2', { createdAt: 5, playlist: { id: 'L', title: 'Course', index: 1 } });
    expect([...studyOrder([p2, p1]).entries()].sort((x, y) => x[1] - y[1]).map((e) => e[0])).toEqual(['P1', 'P2']);
    expect(earlierInPlaylist([p1, p2], 'L', 1).map((v) => v.videoId)).toEqual(['P1']);
  });
  it('carries solid and shaky concepts forward in a playlist', () => {
    const earlier = video('E', { learner: { concepts: { softmax: { state: 'solid', updatedAt: 0, evidence: [] }, logits: { state: 'shaky', updatedAt: 0, evidence: [] } } } });
    const seeded = carryOver([earlier], map, EMPTY_LEARNER, NOW);
    expect(seeded.concepts.softmax.state).toBe('solid');
    expect(seeded.concepts.logits.state).toBe('shaky');
    expect(seeded.concepts.temperature).toBeUndefined();
    const mine = { concepts: { softmax: { state: 'shaky' as const, updatedAt: 1, evidence: [] } } };
    expect(carryOver([earlier], map, mine, NOW).concepts.softmax.state).toBe('shaky');
  });
  it('lays out the concept graph in dependency levels and survives cycles', () => {
    const pos = layoutGraph([
      { key: 'c', deps: ['b'] },
      { key: 'a', deps: [] },
      { key: 'b', deps: ['a', 'missing'] },
    ]);
    expect(pos.map((p) => [p.key, p.level, p.row])).toEqual([
      ['a', 0, 0],
      ['b', 1, 0],
      ['c', 2, 0],
    ]);
    expect(() => layoutGraph([{ key: 'x', deps: ['y'] }, { key: 'y', deps: ['x'] }])).not.toThrow();
  });
});

describe('practice', () => {
  const raw = {
    problems: [
      { level: 3, kind: 'math', statement: 'Bare problem', steps: ['s1', 's2', 's3'], answer: '42', hints: ['n'], code_language: 'none', starter_code: '', tests: [] },
      { level: 1, kind: 'code', statement: 'Write f', steps: ['a', 'b'], answer: 'def f', hints: ['h1', 'h2', 'h3', 'h4'], code_language: 'python', starter_code: 'def f(x):\n    pass', tests: [{ name: 't1', code: 'assert f(1) == 2' }] },
      { level: 2, kind: 'math', statement: 'Faded', steps: ['1', '2', '3', '4', '5', '6'], answer: 'x', hints: ['a', 'b', 'c'], code_language: 'none', starter_code: '', tests: [] },
      { level: 2, kind: 'math', statement: '', steps: [], answer: '', hints: [], code_language: 'none', starter_code: '', tests: [] },
    ],
  };
  const ps = normalizeProblems(raw, { videoId: 'v', concept: 'c', setId: 's', now: 1, id: (i) => `p${i}` });
  it('normalises, orders by level and pads hints to three', () => {
    expect(ps.map((p) => p.level)).toEqual([1, 2, 3]);
    expect(ps[0].code).toEqual({ language: 'python', starter: 'def f(x):\n    pass', tests: [{ name: 't1', code: 'assert f(1) == 2' }] });
    expect(ps[2].hints).toHaveLength(3);
    expect(ps[0].hints).toEqual(['h1', 'h2', 'h3']);
  });
  it('fades worked examples', () => {
    expect(visibleSteps(ps[0])).toEqual({ shown: ['a', 'b'], blanks: 0 });
    expect(visibleSteps(ps[1])).toEqual({ shown: ['1', '2', '3', '4'], blanks: 2 });
    expect(visibleSteps(ps[2])).toEqual({ shown: [], blanks: 0 });
    expect(visibleSteps({ level: 2, steps: ['only'] })).toEqual({ shown: [], blanks: 1 });
  });
  it('climbs the hint ladder to the full solution', () => {
    expect(revealedHints(ps[2], 0)).toEqual([]);
    expect(revealedHints(ps[2], 2).map((h) => h.label)).toEqual(['Nudge', 'Which idea to use']);
    const full = revealedHints(ps[2], 4);
    expect(full[3].label).toBe('Full solution');
    expect(full[3].text).toContain('**Answer:** 42');
    expect(nextHint(4)).toBe(4);
  });
  it('computes confidence calibration and flags sure-but-wrong', () => {
    const c = calibration([
      { confidence: 'high', verdict: 'correct' },
      { confidence: 'high', verdict: 'incorrect' },
      { confidence: 'low', verdict: 'partial' },
      { confidence: null, verdict: 'correct' },
      { confidence: 'medium', verdict: 'skipped' },
    ]);
    expect(c.rows.find((r) => r.confidence === 'high')).toMatchObject({ n: 2, correct: 1, accuracy: 0.5 });
    expect(c.rows.find((r) => r.confidence === 'medium')).toMatchObject({ n: 0, accuracy: null });
    expect(c.sureButWrong).toBe(1);
    expect(isSureButWrong('high', 'partial')).toBe(false);
  });
  it('JS harness: runs code, captures logs, reports each test, isolates failures', () => {
    const src = buildJsHarness('function add(a, b) { return a + b; }\nconsole.log("hi", {x: 1});', [
      { name: 'adds', code: 'assertEqual(add(2, 2), 4)' },
      { name: 'wrong', code: 'assertEqual(add(2, 2), 5, "sum")' },
      { name: 'throws', code: 'undefinedFn()' },
    ]);
    const logs: string[] = [];
    const results: { name: string; passed: boolean; message: string }[] = [];
    new Function('__logs', '__results', src)(logs, results);
    expect(logs).toEqual(['hi {"x":1}']);
    expect(results.map((r) => [r.name, r.passed])).toEqual([
      ['adds', true],
      ['wrong', false],
      ['throws', false],
    ]);
    expect(results[1].message).toBe('sum: expected 5, got 4');
  });
  it('summarises runs for the grader and parses harness JSON', () => {
    const r = parseHarnessResult(JSON.stringify({ stdout: 'out', error: null, tests: [{ name: 't', passed: false, message: 'boom' }] }), 12);
    expect(r.ok).toBe(false);
    expect(summarizeRun(r)).toBe('FAIL t: boom\nOutput:\nout');
    expect(parseHarnessResult('nope', 1).error).toMatch(/Could not read/);
    expect(summarizeRun({ ok: false, stdout: '', error: null, tests: [], timedOut: true, ms: 10_000 })).toContain('Timed out after 10 s');
  });
});

describe('zip and notes export', () => {
  const enc = new TextEncoder();
  it('computes the standard CRC-32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });
  it('writes a valid stored zip that a reader can walk', () => {
    const files = [
      { path: 'n/notes.md', data: enc.encode('# hi') },
      { path: 'n/images/ü.jpg', data: new Uint8Array([1, 2, 3]) },
    ];
    const z = buildZip(files, new Date(2026, 10, 17, 12, 0, 0));
    const dv = new DataView(z.buffer);
    const endAt = z.length - 22;
    expect(dv.getUint32(endAt, true)).toBe(0x06054b50);
    expect(dv.getUint16(endAt + 10, true)).toBe(2);
    let p = dv.getUint32(endAt + 16, true);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(dv.getUint32(p, true)).toBe(0x02014b50);
      const nameLen = dv.getUint16(p + 28, true);
      const localAt = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen));
      names.push(name);
      const size = dv.getUint32(localAt + 18, true);
      const dataAt = localAt + 30 + dv.getUint16(localAt + 26, true);
      expect(crc32(z.subarray(dataAt, dataAt + size))).toBe(dv.getUint32(p + 16, true));
      p += 46 + nameLen;
    }
    expect(names).toEqual(['n/notes.md', 'n/images/ü.jpg']);
  });
  it('assembles notes with frames, bookmarks, mistakes and a cheat sheet', () => {
    const meta = { videoId: 'abc', title: 'Backprop: step 1', channel: 'C' };
    const entries = assembleNotesZip({
      meta,
      history: [{ id: 'h', videoId: 'abc', frameId: 'fA', kind: 'question', question: 'q?', userText: '', answer: 'see [1:05]', at: 65, createdAt: 0, model: '', hadFrame: true, hadCrop: false, captionRange: null, concepts: [] }],
      map: null,
      learner: EMPTY_LEARNER,
      checkpoints: [],
      teachBacks: [],
      bookmarks: [{ id: 'b', videoId: 'abc', t: 125, frameId: 'fB', caption: 'cap', note: 'key slide', createdAt: 0 }],
      mistakes: [{ id: 'm', videoId: 'abc', at: 70, source: 'checkpoint', question: 'Q', answer: 'A', misconception: 'M', correction: 'C', confidence: 'high', concepts: [], createdAt: 0 }],
      cheatSheet: '## Key ideas\n- x [0:10]',
      frames: [
        { id: 'fA', t: 65, bytes: new Uint8Array([1]), mime: 'image/jpeg' },
        { id: 'fB', t: 125, bytes: new Uint8Array([2]), mime: 'image/jpeg' },
        { id: 'unused', t: 9, bytes: new Uint8Array([3]), mime: 'image/jpeg' },
      ],
    });
    expect(entries.map((e) => e.path)).toEqual([
      'backprop-step-1-abc/notes.md',
      'backprop-step-1-abc/cheat-sheet.md',
      `backprop-step-1-abc/${frameFileName({ id: 'fA', t: 65 })}`,
      `backprop-step-1-abc/${frameFileName({ id: 'fB', t: 125 })}`,
    ]);
    const notes = new TextDecoder().decode(entries[0].data);
    expect(notes).toContain('![Frame at 1:05](images/frame-01m05s-fA.jpg)');
    expect(notes).toContain('## Bookmarks');
    expect(notes).toContain('key slide — “cap”');
    expect(notes).toContain('## Mistake log');
    expect(notes).toContain('_(was sure)_');
    expect(notes).toContain('[cheat sheet](cheat-sheet.md)');
    expect(new TextDecoder().decode(entries[1].data)).toContain('[0:10](https://www.youtube.com/watch?v=abc&t=10s)');
    expect(slug('Ünïcode / Title!')).toBe('unicode-title');
  });
  it('plain Markdown export still works without the new fields', () => {
    expect(toMarkdown({ meta: { videoId: 'x', title: 'T', channel: '' }, history: [], map: null, learner: EMPTY_LEARNER, checkpoints: [], teachBacks: [] })).toContain('# T');
  });
});

describe('glossary and the extended lesson map', () => {
  it('builds a running table of symbols and terms', () => {
    const g = glossaryEntries(map, [{ symbol: '\\tau', meaning: 'temperature', definedAt: 410, source: 'frame' }]);
    expect(g.map((e) => e.label)).toEqual(['logits', 'softmax', '\\sigma(z)', 'temperature', '\\tau']);
    expect(glossaryUpTo(g, 330).map((e) => e.label)).toEqual(['logits', 'softmax', '\\sigma(z)']);
    expect(mergeNotation([], map, [{ symbol: '\\sigma (z)', meaning: 'dup', definedAt: 1, source: 'frame' }, { symbol: 'W', meaning: 'weights', definedAt: 2, source: 'frame' }]).map((n) => n.symbol)).toEqual(['W']);
  });
  it('normalises notation, pre-questions and prerequisite checks', () => {
    const m = normalizeVideoMap(
      {
        sections: [{ start: '0:10', end: '1:00', title: 'A', key_idea: '', suggested_questions: [] }],
        concepts: [],
        prerequisites: [],
        checkpoints: [],
        notation: [{ symbol: '\\theta', meaning: 'parameters', defined_at: '0:30' }, { symbol: '', meaning: 'x', defined_at: '' }],
        pre_questions: [{ question: 'Q1', answer: 'A1', answered_at: '0:50' }, { question: 'Q2', answer: '', answered_at: '' }, { question: 'Q3', answer: '', answered_at: '' }, { question: 'Q4', answer: '', answered_at: '' }],
        prerequisite_checks: [{ prerequisite: 'derivatives', question: 'd/dx x^2?', answer: '2x' }],
      },
      'v',
      120,
      'm',
    );
    expect(m.sections[0].start).toBe(0);
    expect(m.notation).toEqual([{ symbol: '\\theta', meaning: 'parameters', definedAt: 30, source: 'map' }]);
    expect(m.preQuestions).toHaveLength(3);
    expect(m.preQuestions![0].at).toBe(50);
    expect(m.prerequisiteChecks).toEqual([{ prerequisite: 'derivatives', question: 'd/dx x^2?', answer: '2x' }]);
  });
});

describe('prompt additions', () => {
  it('puts the learner profile before the cached video context and connections with the map', () => {
    const blocks = contextBlocks('<video_context/>', map, { profile: profileText({ background: '2nd-year CS', goals: '', style: 'examples first' }), connections: '<connections>x</connections>' });
    expect(blocks.map((b) => !!b.cache_control)).toEqual([false, true, true]);
    expect(blocks[0].text).toContain('Background: 2nd-year CS');
    expect(blocks[2].text).toContain('<connections>x</connections>');
    expect(profileText({ background: ' ', goals: '', style: '' })).toBe('');
  });
  it('describes earlier frames in image order', () => {
    const t = turnText({
      kind: 'question',
      question: 'what was the formula two slides ago?',
      t: 600,
      paused: true,
      chapterTitle: null,
      section: null,
      localCaptions: null,
      frame: { mediaType: 'image/jpeg', data: 'A', width: 10, height: 10 },
      frameNote: null,
      crop: null,
      earlier: [{ frame: { mediaType: 'image/jpeg', data: 'B', width: 10, height: 10 }, t: 480 }],
      learnerDigest: '',
      hintsFirst: false,
      fallbackLanguage: 'en',
    });
    expect(t).toContain('Image 1 (the first) is the current video frame at [10:00]');
    expect(t).toContain('Image 2 is an earlier frame from [8:00]');
  });
  it('parses misconception, correction and missing lines', () => {
    const p = parseVerdict('Good.\nVERDICT: incorrect\nCONCEPTS: a\nMISCONCEPTION: thinks softmax is linear\nCORRECTION: it is exponential then normalised\nMISSING: none', ['correct', 'partial', 'incorrect'] as const);
    expect(p.body).toBe('Good.');
    expect(p.fields).toEqual({ misconception: 'thinks softmax is linear', correction: 'it is exponential then normalised', missing: '' });
  });
});
