import { describe, expect, it } from 'vitest';
import { findTimestamps, formatTime, parseTime, watchUrl } from '../src/shared/time';

describe('formatTime', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5.9)).toBe('0:05');
    expect(formatTime(754)).toBe('12:34');
    expect(formatTime(3723)).toBe('1:02:03');
    expect(formatTime(-3)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
  });
});

describe('parseTime', () => {
  it('parses the usual forms', () => {
    expect(parseTime('12:34')).toBe(754);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('0:05')).toBe(5);
    expect(parseTime('754')).toBe(754);
    expect(parseTime('754s')).toBe(754);
    expect(parseTime('12m34s')).toBe(754);
    expect(parseTime('1h2m3s')).toBe(3723);
    expect(parseTime(' 3:07 ')).toBe(187);
  });
  it('rejects malformed input', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('12:75')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:2:3:4')).toBeNull();
  });
  it('round-trips with formatTime', () => {
    for (const s of [0, 59, 60, 599, 3599, 3600, 7322]) expect(parseTime(formatTime(s))).toBe(s);
  });
});

describe('findTimestamps', () => {
  it('finds single times and ranges, with any dash', () => {
    const found = findTimestamps('See [12:34], then [1:02:03] and [3:00–3:45] or [4:00-4:10].');
    expect(found.map((f) => [f.start, f.end, f.label])).toEqual([
      [754, null, '12:34'],
      [3723, null, '1:02:03'],
      [180, 225, '3:00–3:45'],
      [240, 250, '4:00-4:10'],
    ]);
  });
  it('ignores markdown links and non-times', () => {
    expect(findTimestamps('[12:34](https://x) [abc] [12] [99:99]')).toHaveLength(0);
  });
});

describe('watchUrl', () => {
  it('adds &t= only for positive times', () => {
    expect(watchUrl('abc', 754.9)).toBe('https://www.youtube.com/watch?v=abc&t=754s');
    expect(watchUrl('abc', 0)).toBe('https://www.youtube.com/watch?v=abc');
  });
});
