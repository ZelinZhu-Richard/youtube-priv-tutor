// Runs in the page's MAIN world at document_start (manifest "world": "MAIN").
// Jobs (§3): observe the player's own /api/timedtext responses, read the player response and
// chapters, and switch captions on briefly through the player API to make the player fetch them.
// It only exchanges page data with the content script via window.postMessage; it never sees
// anything from the extension (no settings, no key).
import { CONTENT_SOURCE, PAGE_SOURCE, type CapturedTimedText, type FromPage, type PlayerData, type ToPage } from '../shared/messages';
import { extractChapters, extractPlaylist, isTimedTextUrl, langMatches, parseTimedTextUrl, YT } from '../shared/youtube';

interface YTPlayer extends HTMLElement {
  getPlayerResponse?: () => unknown;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
  loadModule?: (module: string) => void;
  unloadModule?: (module: string) => void;
  isSubtitlesOn?: () => boolean;
}

type Win = Window & {
  __ytTutorPageInstalled?: boolean;
  ytInitialPlayerResponse?: unknown;
  ytInitialData?: unknown;
};
const w = window as Win;

if (!w.__ytTutorPageInstalled) {
  w.__ytTutorPageInstalled = true;
  install();
}

function install() {
  const captured = new Map<string, CapturedTimedText & { videoId: string; lang: string; kind: string }>();
  const waiters = new Set<{ videoId: string; lang: string; resolve: (c: CapturedTimedText) => void }>();
  let lastNav: { videoId: string; data: PlayerData } | null = null;

  const post = (msg: FromPage) => window.postMessage(msg, location.origin);

  function record(url: string, body: string) {
    if (!body || !body.trim()) return;
    const p = parseTimedTextUrl(url);
    if (!p.videoId || !p.lang || p.tlang) return; // ignore auto-translated tracks
    const key = `${p.videoId}|${p.lang}|${p.kind ?? ''}`;
    captured.delete(key);
    captured.set(key, { url, body, videoId: p.videoId, lang: p.lang, kind: p.kind ?? '' });
    // Only the current video's track is read back; keep a few so a quick back/forward still hits.
    while (captured.size > 4) captured.delete(captured.keys().next().value as string);
    for (const wt of [...waiters]) {
      if (wt.videoId === p.videoId && langMatches(wt.lang, p.lang)) {
        waiters.delete(wt);
        wt.resolve({ url, body });
      }
    }
  }

  function findCaptured(videoId: string, lang: string, isAuto: boolean): CapturedTimedText | null {
    let fallback: CapturedTimedText | null = null;
    for (const c of [...captured.values()].reverse()) {
      if (c.videoId !== videoId || !langMatches(c.lang, lang)) continue;
      if ((c.kind === 'asr') === isAuto) return { url: c.url, body: c.body };
      fallback ??= { url: c.url, body: c.body };
    }
    return fallback;
  }

  // ---- observe fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url && isTimedTextUrl(url)) {
        res
          .clone()
          .text()
          .then((b) => record(res.url || url, b))
          .catch(() => undefined);
      }
    } catch {
      /* never break the page */
    }
    return res;
  };

  // ---- observe XMLHttpRequest ----
  const urls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null,
  ) {
    try {
      urls.set(this, String(url));
    } catch {
      /* ignore */
    }
    return origOpen.call(this, method, url, async ?? true, user, password);
  } as typeof XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = urls.get(this);
    if (url && isTimedTextUrl(url)) {
      this.addEventListener('load', () => {
        try {
          let text = '';
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') text = JSON.stringify(this.response);
          else if (this.responseType === 'arraybuffer' && this.response) text = new TextDecoder().decode(this.response as ArrayBuffer);
          record(this.responseURL || url, text);
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.call(this, body);
  };

  // ---- player data ----
  const currentVideoId = () => new URL(location.href).searchParams.get('v');
  const prVideoId = (pr: unknown) => (pr as { videoDetails?: { videoId?: string } } | null)?.videoDetails?.videoId;
  const player = () => document.querySelector(YT.playerSelector) as YTPlayer | null;
  const trim = (pr: unknown) => {
    const p = pr as { videoDetails?: unknown; captions?: unknown };
    return { videoDetails: p.videoDetails, captions: p.captions };
  };

  function initialDataVideoId(d: unknown): string | undefined {
    return (d as { currentVideoEndpoint?: { watchEndpoint?: { videoId?: string } } } | null)?.currentVideoEndpoint?.watchEndpoint?.videoId;
  }

  function playerData(): PlayerData | null {
    const vid = currentVideoId();
    if (!vid) return null;
    let pr: unknown = null;
    try {
      pr = player()?.getPlayerResponse?.();
    } catch {
      pr = null;
    }
    if (prVideoId(pr) !== vid && lastNav?.videoId === vid) return lastNav.data;
    if (prVideoId(pr) !== vid) pr = w.ytInitialPlayerResponse;
    if (prVideoId(pr) !== vid) return null;
    let chapters = lastNav?.videoId === vid ? lastNav.data.chapters : [];
    let playlist = lastNav?.videoId === vid ? lastNav.data.playlist ?? null : null;
    if (initialDataVideoId(w.ytInitialData) === vid) {
      if (!chapters.length) chapters = extractChapters(w.ytInitialData);
      playlist ??= extractPlaylist(w.ytInitialData);
    }
    return { playerResponse: trim(pr), chapters, playlist };
  }

  document.addEventListener(YT.navigateFinishEvent, (e) => {
    try {
      const detail = (e as CustomEvent).detail as { response?: { playerResponse?: unknown; response?: unknown } } | undefined;
      const pr = detail?.response?.playerResponse;
      const vid = prVideoId(pr);
      if (pr && vid) {
        lastNav = { videoId: vid, data: { playerResponse: trim(pr), chapters: extractChapters(detail?.response?.response), playlist: extractPlaylist(detail?.response?.response) } };
      }
      post({ source: PAGE_SOURCE, id: '', type: 'navigated', data: playerData() });
    } catch {
      /* ignore */
    }
  });

  // ---- caption trigger (§3 step 2) ----
  async function triggerCaptions(videoId: string, lang: string, isAuto: boolean, timeoutMs: number): Promise<CapturedTimedText | null> {
    const existing = findCaptured(videoId, lang, isAuto);
    if (existing) return existing;
    const p = player();
    if (!p?.setOption) return null;
    // During an ad the player fetches the ad's captions and aborts the video's, and a caption
    // setting changed now can be re-applied when the ad ends. The content script waits for ads.
    if (p.classList.contains(YT.adShowingClass)) throw new Error('ad-showing');
    // getOption('captions','track') returns the sticky track even while captions are hidden, so it
    // cannot tell whether they are on; isSubtitlesOn() (or the CC button state) can.
    let before: unknown = null;
    let wasOn = false;
    try {
      before = p.getOption?.('captions', 'track');
      wasOn =
        typeof p.isSubtitlesOn === 'function'
          ? !!p.isSubtitlesOn()
          : document.querySelector(YT.subtitlesButtonSelector)?.getAttribute('aria-pressed') === 'true';
    } catch {
      before = null;
    }
    let waiter: { videoId: string; lang: string; resolve: (c: CapturedTimedText) => void } | null = null;
    const got = new Promise<CapturedTimedText | null>((resolve) => {
      waiter = { videoId, lang, resolve };
      waiters.add(waiter);
      setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      p.loadModule?.('captions');
      p.setOption('captions', 'track', isAuto ? { languageCode: lang, kind: 'asr' } : { languageCode: lang });
    } catch {
      /* fall through to timeout */
    }
    const result = await got;
    if (waiter) waiters.delete(waiter);
    // Restore the learner's caption setting, and check again shortly after: the player can apply
    // a pending track change late (observed after ads), which would leave captions on.
    const restore = () => {
      try {
        if (!wasOn) {
          if (p.isSubtitlesOn?.() !== false) p.unloadModule?.('captions');
        } else if (before && typeof before === 'object') p.setOption?.('captions', 'track', before);
      } catch {
        /* ignore */
      }
    };
    restore();
    if (!wasOn) for (const ms of [800, 2500]) setTimeout(() => p.isSubtitlesOn?.() === true && restore(), ms);
    return result;
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const msg = e.data as ToPage | undefined;
    if (!msg || msg.source !== CONTENT_SOURCE || typeof msg.id !== 'string') return;
    switch (msg.type) {
      case 'player-data':
        post({ source: PAGE_SOURCE, id: msg.id, type: 'player-data', data: playerData() });
        break;
      case 'captured':
        post({ source: PAGE_SOURCE, id: msg.id, type: 'captured', data: findCaptured(msg.videoId, msg.lang, msg.isAuto) });
        break;
      case 'trigger-captions':
        triggerCaptions(msg.videoId, msg.lang, msg.isAuto, Math.min(Math.max(msg.timeoutMs, 1000), 15000))
          .then((data) => post({ source: PAGE_SOURCE, id: msg.id, type: 'trigger-captions', data }))
          .catch((err) => post({ source: PAGE_SOURCE, id: msg.id, type: 'trigger-captions', data: null, error: String(err) }));
        break;
    }
  });
}
