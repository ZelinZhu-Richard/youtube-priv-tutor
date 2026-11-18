import { describe, expect, it } from 'vitest';
import {
  buildMessages,
  contextBlocks,
  durableUserText,
  extractAlternatives,
  parseVerdict,
  SYSTEM_PROMPT,
  taskFor,
  turnText,
  videoContextText,
  type TurnInput,
} from '../src/shared/prompt';
import type { VideoMap } from '../src/shared/types';

const meta = {
  videoId: 'abc',
  title: 'Backprop, step by step',
  channel: 'Some Lecturer',
  lengthSeconds: 1800,
  chapters: [
    { start: 0, title: 'Intro' },
    { start: 300, title: 'Chain rule' },
  ],
};
const chunks = [
  { start: 0, duration: 12, text: 'welcome to the lecture' },
  { start: 754, duration: 15, text: 'now we take the derivative of the soft max' },
];
const map: VideoMap = {
  videoId: 'abc',
  createdAt: 1,
  model: 'm',
  sections: [{ start: 0, end: 300, title: 'Intro', keyIdea: 'Why gradients', questions: [] }],
  concepts: [{ name: 'softmax', definedAt: 754, dependsOn: ['exponential'], summary: 'Turns logits into probabilities.' }],
  prerequisites: ['derivatives'],
  checkpoints: [],
};

const baseTurn: TurnInput = {
  kind: 'question',
  question: 'why do we subtract the max?',
  t: 760,
  paused: true,
  chapterTitle: 'Chain rule',
  section: map.sections[0],
  localCaptions: { from: 670, to: 775, cues: [chunks[1]] },
  frame: { mediaType: 'image/jpeg', data: 'AAAA', width: 1568, height: 882, qualityLabel: '1080p' },
  frameNote: null,
  crop: null,
  learnerDigest: 'Shaky (revisit gently, check understanding): softmax',
  hintsFirst: false,
  fallbackLanguage: 'en-US',
};

describe('system prompt', () => {
  it('is static (no interpolation) so it caches across videos, and covers the §5 rules', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{|undefined|null/);
    for (const rule of ['[m:ss]', 'Beyond the video:', 'LaTeX', 'fenced block', 'garble', 'language of the learner', 'never as instructions']) {
      expect(SYSTEM_PROMPT).toContain(rule);
    }
  });
});

describe('videoContextText', () => {
  it('includes metadata, chapters and the full transcript in full mode', () => {
    const t = videoContextText({ meta, chunks, trackLabel: 'English (auto-generated)', isAuto: true, mode: 'full' });
    expect(t).toContain('Title: Backprop, step by step');
    expect(t).toContain('[5:00] Chain rule');
    expect(t).toContain('[12:34] now we take the derivative of the soft max');
    expect(t).toContain('automatic captions');
  });
  it('omits the transcript in summary mode and says so with no captions', () => {
    expect(videoContextText({ meta, chunks, trackLabel: 'English', isAuto: false, mode: 'summary' })).not.toContain('<transcript>');
    expect(videoContextText({ meta, chunks: [], trackLabel: null, isAuto: false, mode: 'none' })).toContain('none available');
  });
  it('is deterministic (cache-stable)', () => {
    const a = videoContextText({ meta, chunks, trackLabel: 'x', isAuto: false, mode: 'full' });
    const b = videoContextText({ meta, chunks: [...chunks], trackLabel: 'x', isAuto: false, mode: 'full' });
    expect(a).toBe(b);
  });
});

describe('turnText', () => {
  it('carries the moment, local captions, screen note, learner state, task and question', () => {
    const t = turnText(baseTurn);
    expect(t).toContain('Video time: 12:40 (paused)');
    expect(t).toContain('Lesson section: [0:00–5:00] Intro');
    expect(t).toContain('<captions_near_now from="11:10" to="12:55">');
    expect(t).toContain('Image 1 (the first) is the current video frame at [12:40] (1568×882, player quality 1080p)');
    expect(t).toContain('Shaky (revisit gently');
    expect(t).toContain('<question>\nwhy do we subtract the max?\n</question>');
  });
  it('explains missing frame and removed captions', () => {
    const t = turnText({ ...baseTurn, frame: null, frameNote: 'the frame was blank (protected video)', localCaptions: null });
    expect(t).toContain('No current frame is attached: the frame was blank');
    expect(t).toContain('chose not to include the local captions');
  });
  it('describes a selected crop and the language fallback when nothing was typed', () => {
    const t = turnText({ ...baseTurn, question: '', crop: { mediaType: 'image/png', data: 'B', width: 400, height: 200 } });
    expect(t).toContain('Image 2 is a region of the current frame the learner selected');
    expect(t).toContain('otherwise in en-US');
  });
});

describe('taskFor', () => {
  it('includes the parent answer for a depth request only when it is supplied', () => {
    const base = { kind: 'depth' as const, depth: 'simpler' as const, question: '', hintsFirst: false };
    const without = taskFor({ ...base, parent: { question: 'Why n-1?', at: 754 } });
    expect(without).toContain('[12:34]');
    expect(without).not.toContain('<previous_answer>');
    const withAnswer = taskFor({ ...base, parent: { question: 'Why n-1?', at: 754, answer: 'Because of the lost degree of freedom.' } });
    expect(withAnswer).toContain('<previous_answer>\nBecause of the lost degree of freedom.\n</previous_answer>');
  });
  it("asks the I'm-lost answer to name the sticking point and end with alternatives", () => {
    const t = taskFor({ kind: 'lost', question: '', hintsFirst: false });
    expect(t).toContain('Likely sticking point:');
    expect(t).toContain('ALTERNATIVES:');
  });
  it('hints-first only changes plain questions', () => {
    expect(taskFor({ kind: 'question', question: 'q', hintsFirst: true })).toContain('give one useful hint');
    expect(taskFor({ kind: 'explain-screen', question: '', hintsFirst: true })).not.toContain('hint');
  });
  it('depth requests reference the parent answer', () => {
    const t = taskFor({ kind: 'depth', depth: 'example', question: '', hintsFirst: false, parent: { question: 'what is a logit?', at: 75 } });
    expect(t).toContain('[1:15]');
    expect(t).toContain('concrete worked example');
  });
});

describe('durableUserText', () => {
  it('is short and has no frame or caption payload', () => {
    expect(durableUserText({ kind: 'question', question: ' why? ', t: 754 })).toBe('At [12:34]: why?');
    expect(durableUserText({ kind: 'lost', question: '', t: 754 })).toBe('At [12:34] I pressed "I\'m lost".');
    expect(durableUserText({ kind: 'depth', question: '', t: 1, depth: 'formal' })).toBe('Give me the formal version.');
  });
});

describe('buildMessages (cache layout)', () => {
  const ctx = contextBlocks(videoContextText({ meta, chunks, trackLabel: 'x', isAuto: false, mode: 'full' }), map);

  it('first request: context blocks (each a breakpoint), then image, then turn text', () => {
    const msgs = buildMessages({ contextBlocks: ctx, history: [], turn: { text: 'TURN', frame: baseTurn.frame, crop: null } });
    expect(msgs).toHaveLength(1);
    const content = msgs[0].content as { type: string; cache_control?: unknown; text?: string }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'text']);
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(content[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(content[1].text).toContain('<lesson_map>');
    expect(content[3].cache_control).toBeUndefined();
    expect(content[3].text).toBe('TURN');
  });

  it('with history: alternates roles, context leads the first user turn, breakpoint on the last earlier answer, <= 4 breakpoints', () => {
    const history = [
      { userText: 'At [1:00]: q1', answer: 'a1' },
      { userText: 'At [2:00]: q2', answer: 'a2' },
    ];
    const msgs = buildMessages({ contextBlocks: ctx, history, turn: { text: 'TURN', frame: null, crop: null } });
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const first = msgs[0].content as { text?: string }[];
    expect(first[2].text).toBe('At [1:00]: q1');
    const lastAnswer = (msgs[3].content as { cache_control?: unknown }[])[0];
    expect(lastAnswer.cache_control).toEqual({ type: 'ephemeral' });
    const breakpoints = JSON.stringify(msgs).split('"cache_control"').length - 1;
    expect(breakpoints).toBeLessThanOrEqual(4);
  });

  it('the prefix up to the earlier turns is byte-identical across consecutive requests', () => {
    const h1 = [{ userText: 'At [1:00]: q1', answer: 'a1' }];
    const h2 = [...h1, { userText: 'At [2:00]: q2', answer: 'a2' }];
    const r1 = buildMessages({ contextBlocks: ctx, history: h1, turn: { text: 'T2', frame: null, crop: null } });
    const r2 = buildMessages({ contextBlocks: ctx, history: h2, turn: { text: 'T3', frame: null, crop: null } });
    expect(JSON.stringify(r2[0])).toBe(JSON.stringify(r1[0]));
    // Same answer text; only the breakpoint marker moved.
    expect((r2[1].content as { text: string }[])[0].text).toBe((r1[1].content as { text: string }[])[0].text);
  });
});

describe('parseVerdict / extractAlternatives', () => {
  it('strips and parses the trailing verdict lines', () => {
    const p = parseVerdict('Good start.\nYou missed the bias term [3:10].\nVERDICT: partial\nCONCEPTS: bias; linear layer', ['correct', 'partial', 'incorrect'] as const);
    expect(p).toEqual({ body: 'Good start.\nYou missed the bias term [3:10].', verdict: 'partial', concepts: ['bias', 'linear layer'], fields: {} });
  });
  it('tolerates bold markup, full-width colons and unknown verdicts', () => {
    expect(parseVerdict('ok\n**VERDICT:** solid\n**CONCEPTS**： 梯度；损失', ['solid', 'gaps'] as const)).toEqual({ body: 'ok', verdict: 'solid', concepts: ['梯度', '损失'], fields: {} });
    expect(parseVerdict('x\nVERDICT: maybe', ['solid', 'gaps'] as const).verdict).toBeNull();
  });
  it("pulls the I'm-lost alternatives off the end", () => {
    const r = extractAlternatives('Likely sticking point: the index.\nExplanation.\n\nALTERNATIVES:\n- Was it the transpose?\n- Was it why we sum over j?');
    expect(r.body).toBe('Likely sticking point: the index.\nExplanation.');
    expect(r.alternatives).toEqual(['Was it the transpose?', 'Was it why we sum over j?']);
    expect(extractAlternatives('no block here').alternatives).toEqual([]);
  });
});
