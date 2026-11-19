import { describe, expect, it } from 'vitest';
import { buildCards, linkTimestamps, splitCode, toAnkiCsv, toAnkiHtml, toMarkdown } from '../src/shared/export';
import { applyLearnerEvent, EMPTY_LEARNER } from '../src/shared/learner';
import type { CheckpointResult, HistoryEntry, VideoMap } from '../src/shared/types';

const meta = { videoId: 'vid123', title: 'Linear algebra, lecture 3', channel: 'Prof' };
const map: VideoMap = {
  videoId: 'vid123',
  createdAt: 0,
  model: 'm',
  sections: [{ start: 0, end: 600, title: 'Eigenvectors', keyIdea: 'Directions a matrix only stretches.', questions: [] }],
  concepts: [{ name: 'eigenvalue', definedAt: 125, dependsOn: [], summary: 'The factor $\\lambda$ in $Av = \\lambda v$.' }],
  prerequisites: [],
  checkpoints: [{ id: 'cp-300', at: 300, sectionIndex: 0, type: 'next-step', question: 'What is det(A - λI)?', answer: '$\\lambda^2 - 4\\lambda + 3$', concepts: ['eigenvalue'] }],
};
const entry: HistoryEntry = {
  id: 'h1',
  videoId: 'vid123',
  kind: 'question',
  question: 'why set the determinant to zero?',
  userText: 'At [5:00]: why set the determinant to zero?',
  answer: 'Because a nonzero $v$ exists only if $A - \\lambda I$ is singular [2:05].\n\n```python\nx = [1:2]  # not a timestamp\n```',
  at: 300,
  createdAt: 0,
  model: 'm',
  hadFrame: true,
  hadCrop: false,
  captionRange: [210, 315],
  concepts: ['eigenvalue'],
};
const result: CheckpointResult = { checkpointId: 'cp-300', question: 'What is det(A - λI)?', at: 300, answer: 'λ^2 - 3', verdict: 'incorrect', feedback: 'Expand again [4:40].', concepts: ['eigenvalue'], createdAt: 0 };

describe('splitCode / linkTimestamps', () => {
  it('separates fenced and inline code from prose', () => {
    const parts = splitCode('a `b` c\n```js\nx\n```\nd');
    expect(parts.map((p) => [p.code, p.text])).toEqual([
      [false, 'a '],
      [true, '`b`'],
      [false, ' c\n'],
      [true, '```js\nx\n```'],
      [false, '\nd'],
    ]);
  });
  it('links timestamps in prose but not in code', () => {
    const out = linkTimestamps(entry.answer, 'vid123');
    expect(out).toContain('[2:05](https://www.youtube.com/watch?v=vid123&t=125s)');
    expect(out).toContain('x = [1:2]  # not a timestamp');
  });
});

describe('toMarkdown', () => {
  it('exports key ideas, shaky concepts, Q&A with linked timestamps, LaTeX, code, and checkpoints', () => {
    const learner = applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['eigenvalue'] }, map);
    const md = toMarkdown({ meta, history: [entry], map, learner, checkpoints: [result], teachBacks: [], exportedAt: new Date('2026-11-17T00:00:00Z') });
    expect(md).toContain('# Linear algebra, lecture 3');
    expect(md).toContain('_Notes exported 2026-11-17 from YouTube Tutor._');
    expect(md).toContain('- [0:00](https://www.youtube.com/watch?v=vid123) **Eigenvectors** — Directions a matrix only stretches.');
    expect(md).toContain('- **eigenvalue** ([2:05](https://www.youtube.com/watch?v=vid123&t=125s))');
    expect(md).toContain('### [5:00](https://www.youtube.com/watch?v=vid123&t=300s) why set the determinant to zero?');
    expect(md).toContain('$A - \\lambda I$');
    expect(md).toContain('```python');
    expect(md).toContain('— _not yet_');
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('Anki export', () => {
  it('converts math to MathJax delimiters and escapes HTML', () => {
    expect(toAnkiHtml('If $a<b$ then $$x^2$$ **holds**\nnext')).toBe('If \\(a&lt;b\\) then \\[x^2\\] <b>holds</b><br>next');
    expect(toAnkiHtml('costs $5 and $10')).toBe('costs $5 and $10');
  });
  it('builds cards from shaky concepts and missed checkpoints', () => {
    const learner = applyLearnerEvent(EMPTY_LEARNER, { type: 'lost', concepts: ['eigenvalue'] }, map);
    const cards = buildCards({ meta, map, learner, checkpoints: [result, { ...result, checkpointId: 'x', question: 'ok', verdict: 'correct' }] });
    expect(cards).toHaveLength(2);
    expect(cards[0].front).toContain('eigenvalue');
    expect(cards[0].back).toContain('\\(Av = \\lambda v\\)');
    expect(cards[0].back).toContain('https://www.youtube.com/watch?v=vid123&amp;t=125s'.replace('&amp;', '&'));
    expect(cards[1].back).toContain('\\(\\lambda^2 - 4\\lambda + 3\\)');
    expect(cards[1].tags).toContain('checkpoint');
  });
  it('writes Anki CSV headers and RFC 4180 quoting', () => {
    const csv = toAnkiCsv([{ front: 'He said "hi", twice', back: 'a<br>b', tags: ['t1', 't2'] }]);
    expect(csv).toBe('#separator:comma\n#html:true\n#tags column:3\n#columns:Front,Back,Tags\n"He said ""hi"", twice","a<br>b","t1 t2"\n');
  });
});
