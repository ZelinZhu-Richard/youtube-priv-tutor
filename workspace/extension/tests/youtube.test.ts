import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractChapters,
  extractJsonAssignment,
  isTimedTextUrl,
  langMatches,
  parsePlayerResponse,
  parseTimedTextUrl,
  pickTrack,
  segmentsToCues,
  timedTextUrl,
  videoIdFromUrl,
} from '../src/shared/youtube';
import type { CaptionTrackInfo } from '../src/shared/types';

// Trimmed from real watch pages (signatures redacted, descriptions dropped).
const load = (id: string) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', `watch_${id}.json`), 'utf8'));
const NN = load('aircAruvnKk'); // 3Blue1Brown: manual captions in many languages + ASR; dubbed audio tracks
const GPT = load('kCc8FmEb1nY'); // Karpathy: ASR only, plus "timing-optimized" ASR variants for dubbed audio

describe('parsePlayerResponse (real data)', () => {
  it('reads metadata and caption tracks', () => {
    const m = parsePlayerResponse(NN.playerResponse)!;
    expect(m.videoId).toBe('aircAruvnKk');
    expect(m.channel).toBe('3Blue1Brown');
    expect(m.lengthSeconds).toBe(1120);
    expect(m.isLive).toBe(false);
    expect(m.tracks).toHaveLength(31);
    const asr = m.tracks.filter((t) => t.isAuto);
    expect(asr).toHaveLength(1);
    expect(asr[0].languageCode).toBe('en');
    expect(m.tracks.find((t) => t.vssId === '.en')?.name).toBe('English');
  });

  it('infers the original language from the ASR track, ignoring dub variants', () => {
    expect(parsePlayerResponse(NN.playerResponse)!.originalLanguage).toBe('en');
    const g = parsePlayerResponse(GPT.playerResponse)!;
    expect(g.originalLanguage).toBe('en');
    expect(g.tracks.filter((t) => t.variant === 'timing-optimized')).toHaveLength(11);
  });

  it('returns null for something that is not a player response', () => {
    expect(parsePlayerResponse(null)).toBeNull();
    expect(parsePlayerResponse({ foo: 1 })).toBeNull();
  });
});

describe('pickTrack', () => {
  it('prefers manual captions in the video language (real data)', () => {
    const m = parsePlayerResponse(NN.playerResponse)!;
    const t = pickTrack(m.tracks, m.originalLanguage)!;
    expect(t.vssId).toBe('.en');
    expect(t.isAuto).toBe(false);
  });

  it('falls back to the original-language ASR track, never a dub variant (real data)', () => {
    const m = parsePlayerResponse(GPT.playerResponse)!;
    const t = pickTrack(m.tracks, m.originalLanguage)!;
    expect(t.vssId).toBe('a.en');
    expect(t.variant).toBeNull();
  });

  const tr = (languageCode: string, isAuto = false, variant: string | null = null): CaptionTrackInfo => ({
    baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}`,
    languageCode,
    name: languageCode,
    vssId: `${isAuto ? 'a' : ''}.${languageCode}`,
    isAuto,
    variant,
  });

  it('handles a non-English video with an English manual track', () => {
    const t = pickTrack([tr('en'), tr('zh-CN', true), tr('zh-CN')], 'zh-CN')!;
    expect(t.languageCode).toBe('zh-CN');
    expect(t.isAuto).toBe(false);
  });

  it('matches regional variants and prefers the exact code', () => {
    expect(pickTrack([tr('en-GB'), tr('en')], 'en')!.languageCode).toBe('en');
    expect(pickTrack([tr('en-GB'), tr('fr')], 'en-US')!.languageCode).toBe('en-GB');
  });

  it('uses any manual track when nothing matches the spoken language, and null when there are none', () => {
    expect(pickTrack([tr('de', true, 'timing-optimized'), tr('fr')], 'ja')!.languageCode).toBe('fr');
    expect(pickTrack([], 'en')).toBeNull();
  });

  it('compares languages by primary subtag', () => {
    expect(langMatches('zh-TW', 'zh')).toBe(true);
    expect(langMatches('en', 'fr')).toBe(false);
    expect(langMatches(null, 'en')).toBe(false);
  });
});

describe('extractChapters (real data)', () => {
  it('finds description chapters anywhere in ytInitialData', () => {
    const nn = extractChapters(NN.initialData);
    expect(nn).toHaveLength(12);
    expect(nn[0]).toEqual({ start: 0, title: 'Introduction example' });
    for (let i = 1; i < nn.length; i++) expect(nn[i].start).toBeGreaterThan(nn[i - 1].start);
    const gpt = extractChapters(GPT.initialData);
    expect(gpt).toHaveLength(30);
    expect(gpt[0].title).toMatch(/^intro/);
  });
  it('returns [] when there are no chapters', () => {
    expect(extractChapters({ a: [{ b: 1 }] })).toEqual([]);
    expect(extractChapters(null)).toEqual([]);
  });
});

describe('URLs', () => {
  it('extracts watch video ids only', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=aircAruvnKk&t=30s')).toBe('aircAruvnKk');
    expect(videoIdFromUrl('https://www.youtube.com/shorts/abcdefghijk')).toBeNull();
    expect(videoIdFromUrl('https://www.youtube.com/')).toBeNull();
    expect(videoIdFromUrl('https://example.com/watch?v=aircAruvnKk')).toBeNull();
    expect(videoIdFromUrl('not a url')).toBeNull();
  });

  it('parses the player-style timedtext URL observed in a real session', () => {
    const url =
      'https://www.youtube.com/api/timedtext?v=kCc8FmEb1nY&ei=R&caps=asr&opi=112496729&exp=xpe&xoaf=5&xowf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1794966236&sparams=ip%2Cipbits%2Cexpire%2Cv%2Cei%2Ccaps%2Copi%2Cexp%2Cxoaf&signature=R&key=R&kind=asr&lang=en&potc=1&pot=R&fmt=json3&xorb=2&xobt=3&xovt=3&c=WEB&cplayer=UNIPLAYER';
    expect(isTimedTextUrl(url)).toBe(true);
    expect(parseTimedTextUrl(url)).toEqual({ videoId: 'kCc8FmEb1nY', lang: 'en', kind: 'asr', tlang: null, fmt: 'json3' });
  });

  it('builds a direct-fetch URL with fmt and without auto-translation', () => {
    const u = new URL(timedTextUrl('https://www.youtube.com/api/timedtext?v=x&lang=en&tlang=fr'));
    expect(u.searchParams.get('fmt')).toBe('json3');
    expect(u.searchParams.has('tlang')).toBe(false);
  });
});

describe('segmentsToCues (transcript panel)', () => {
  it('parses row timestamps and derives durations from the next row', () => {
    const cues = segmentsToCues(
      [
        { ts: '\n  0:03\n', text: ' first line ' },
        { ts: '0:07', text: 'second' },
        { ts: '1:02:03', text: 'late' },
        { ts: 'garbage', text: 'skip me' },
      ],
      4000,
    );
    expect(cues).toEqual([
      { start: 3, duration: 4, text: 'first line' },
      { start: 7, duration: 3716, text: 'second' },
      { start: 3723, duration: 10, text: 'late' },
    ]);
  });
});

// Full watch pages fetched into workspace/scratch/pages (not committed). Skipped when absent.
const pagesDir = resolve(__dirname, '../../scratch/pages');
const pages = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith('.html')) : [];
describe.skipIf(!pages.length)('real watch pages in workspace/scratch/pages', () => {
  for (const f of pages) {
    it(`extracts and parses ${f}`, () => {
      const html = readFileSync(resolve(pagesDir, f), 'utf8');
      const pr = extractJsonAssignment(html, 'ytInitialPlayerResponse');
      const meta = parsePlayerResponse(pr)!;
      expect(meta).not.toBeNull();
      expect(f).toContain(meta.videoId);
      expect(meta.tracks.length).toBeGreaterThan(0);
      expect(pickTrack(meta.tracks, meta.originalLanguage)).not.toBeNull();
      const chapters = extractChapters(extractJsonAssignment(html, 'ytInitialData'));
      expect(chapters.length).toBeGreaterThan(0);
    });
  }
});

describe('extractPlaylist (real data)', () => {
  it('reads the playlist panel of a watch page opened from a playlist', async () => {
    const { extractPlaylist, playlistIdFromUrl } = await import('../src/shared/youtube');
    const data = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'playlist_PLZHQ.json'), 'utf8'));
    const p = extractPlaylist(data)!;
    expect(p.id).toBe('PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi');
    expect(p.title).toBe('Neural networks');
    expect(p.videoIds).toHaveLength(10);
    expect(p.videoIds.slice(0, 2)).toEqual(['aircAruvnKk', 'IHZwWFHWa-w']);
    // Found even when nested somewhere else.
    expect(extractPlaylist({ a: [{ b: data.contents.twoColumnWatchNextResults.playlist.playlist }] })?.videoIds).toHaveLength(10);
    expect(extractPlaylist(NN.initialData)).toBeNull();
    expect(playlistIdFromUrl('https://www.youtube.com/watch?v=x&list=PL123')).toBe('PL123');
  });
});
