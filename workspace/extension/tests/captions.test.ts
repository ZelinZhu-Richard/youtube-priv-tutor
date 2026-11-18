import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  detectFormat,
  mergeIntoChunks,
  normalizeCues,
  parseJson3,
  parseTimedText,
  parseVtt,
  parseXmlTimedText,
  removeRollingOverlap,
  smartJoin,
} from '../src/shared/captions';

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;')).toBe('a & b <c> "d" \'e\' A');
  });
  it('handles double-encoded legacy XML', () => {
    expect(decodeEntities('it&amp;#39;s')).toBe("it's");
  });
  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&bogus; &')).toBe('&bogus; &');
  });
});

describe('parseJson3', () => {
  it('parses manual captions (real structure)', () => {
    const cues = parseJson3(fixture('manual_json3.json'));
    expect(cues).toHaveLength(10);
    expect(cues[0]).toEqual({ start: 4.22, duration: 1.18, text: 'Here is a seven.' });
    expect(cues[5].text).toBe('These other drawings are sevens too & you know it,');
  });

  it('parses ASR word segments and skips window and newline-append events', () => {
    const cues = parseJson3(fixture('asr_json3.json'));
    // 20 events: 1 window definition, 9 "\n" appends, 10 text events
    expect(cues).toHaveLength(10);
    expect(cues[0].text).toBe('hi everyone so by now you have probably');
    expect(cues[1].text).toBe('heard of the soft max function');
    expect(cues.every((c) => !c.text.includes('\n'))).toBe(true);
  });
});

describe('parseXmlTimedText', () => {
  it('parses srv3 with <s> word spans and <br>', () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head></head><body>
      <w t="0" id="1"/>
      <p t="120" d="4560" w="1"><s ac="0">hi</s><s t="240" ac="0"> everyone</s></p>
      <p t="2470" d="2210" w="1" a="1">
</p>
      <p t="5000" d="1000">line one<br/>line &amp; two</p></body></timedtext>`;
    const cues = parseXmlTimedText(xml);
    expect(cues).toEqual([
      { start: 0.12, duration: 4.56, text: 'hi everyone' },
      { start: 5, duration: 1, text: 'line one line & two' },
    ]);
  });

  it('parses srv1 (seconds) with double-encoded entities', () => {
    const xml = `<?xml version="1.0"?><transcript><text start="1.5" dur="2.25">it&amp;#39;s a &amp;quot;test&amp;quot;</text><text start="4" dur="1">ok</text></transcript>`;
    expect(parseXmlTimedText(xml)).toEqual([
      { start: 1.5, duration: 2.25, text: 'it\'s a "test"' },
      { start: 4, duration: 1, text: 'ok' },
    ]);
  });
});

describe('parseVtt', () => {
  it('parses cues, strips inline timing tags and removes rolling repetition', () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.120 --> 00:00:02.500 align:start position:0%
we compute the<00:00:00.360><c> gradient</c><00:00:00.800><c> of</c>

00:00:02.500 --> 00:00:05.000 align:start position:0%
we compute the gradient of
the loss with respect to w

00:00:05.000 --> 00:00:07.000
the loss with respect to w
and then step downhill`;
    const cues = parseVtt(vtt);
    expect(cues.map((c) => c.text)).toEqual(['we compute the gradient of', 'the loss with respect to w', 'and then step downhill']);
    expect(cues[0].start).toBeCloseTo(0.12);
  });
});

describe('detectFormat / parseTimedText', () => {
  it('detects each format', () => {
    expect(detectFormat('{"events":[]}')).toBe('json3');
    expect(detectFormat('WEBVTT\n')).toBe('vtt');
    expect(detectFormat('<?xml?><transcript/>')).toBe('xml');
    expect(detectFormat('garbage')).toBe('unknown');
  });
  it('treats empty bodies (what a direct fetch without a token returns) as no captions', () => {
    expect(parseTimedText('')).toEqual([]);
    expect(parseTimedText('   ')).toEqual([]);
    expect(parseTimedText('{not json')).toEqual([]);
  });
});

describe('removeRollingOverlap', () => {
  it('strips 3+ word overlaps but keeps short legitimate repeats', () => {
    const out = removeRollingOverlap([
      { start: 0, duration: 2, text: 'no, no' },
      { start: 2, duration: 2, text: 'no, no that is wrong' },
      { start: 4, duration: 2, text: 'that is wrong because the sign flips' },
    ]);
    expect(out.map((c) => c.text)).toEqual(['no, no', 'no, no that is wrong', 'because the sign flips']);
  });
});

describe('normalizeCues', () => {
  it('sorts, drops empties and duplicates, and clips overlapping auto-caption windows', () => {
    const out = normalizeCues([
      { start: 5, duration: 10, text: 'b' },
      { start: 0, duration: 10, text: '  a  ' },
      { start: 0.2, duration: 1, text: 'a' },
      { start: 7, duration: 0, text: '' },
      { start: 9, duration: 0, text: 'c' },
    ]);
    expect(out).toEqual([
      { start: 0, duration: 5, text: 'a' },
      { start: 5, duration: 4, text: 'b' },
      { start: 9, duration: 2, text: 'c' },
    ]);
  });

  it('turns real ASR json3 into non-overlapping cues', () => {
    const cues = normalizeCues(parseJson3(fixture('asr_json3.json')));
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i - 1].start + cues[i - 1].duration).toBeLessThanOrEqual(cues[i].start + 1e-9);
    }
  });
});

describe('mergeIntoChunks', () => {
  it('merges unpunctuated ASR lines into ~10-20 s chunks keeping start times', () => {
    const chunks = mergeIntoChunks(normalizeCues(parseJson3(fixture('asr_json3.json'))));
    expect(chunks[0].start).toBeCloseTo(0.199);
    expect(chunks[0].duration).toBeGreaterThanOrEqual(10);
    for (const c of chunks) expect(c.duration).toBeLessThanOrEqual(20);
    // The ~6 s silence before 30 s starts a new chunk.
    expect(chunks[chunks.length - 1].start).toBeCloseTo(30);
    expect(chunks.map((c) => c.text).join(' ')).toContain('heard of the soft max function and today');
  });

  it('prefers sentence ends once a chunk is long enough', () => {
    const chunks = mergeIntoChunks(normalizeCues(parseJson3(fixture('manual_json3.json'))));
    expect(chunks[0].text.endsWith('without effort.')).toBe(true);
    expect(chunks[0].start).toBeCloseTo(4.22);
    for (const c of chunks) expect(c.duration).toBeLessThanOrEqual(20);
  });

  it('never exceeds maxSec except for a single long cue', () => {
    const cues = Array.from({ length: 30 }, (_, i) => ({ start: i * 3, duration: 3, text: `w${i}` }));
    cues.push({ start: 90, duration: 45, text: 'one very long cue' });
    const chunks = mergeIntoChunks(cues, { minSec: 10, maxSec: 20 });
    for (const c of chunks.slice(0, -1)) expect(c.duration).toBeLessThanOrEqual(20);
    expect(chunks[chunks.length - 1]).toEqual({ start: 90, duration: 45, text: 'one very long cue' });
  });

  it('joins CJK without spaces and Latin with spaces', () => {
    expect(smartJoin('梯度', '下降')).toBe('梯度下降');
    expect(smartJoin('gradient', 'descent')).toBe('gradient descent');
    const chunks = mergeIntoChunks([
      { start: 0, duration: 4, text: '我们先计算' },
      { start: 4, duration: 4, text: '损失函数的梯度' },
    ]);
    expect(chunks[0].text).toBe('我们先计算损失函数的梯度');
  });
});
