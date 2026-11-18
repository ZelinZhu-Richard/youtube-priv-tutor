// Second-build page helpers (§13.2): frame hashing and sampling, density, the in-player "Ask"
// button, and a small toast. DOM-only glue around the pure functions in shared/frames.ts.
import { capSize } from '../shared/image';
import { DHASH_H, DHASH_W, dHash, edgeDensity, toGray } from '../shared/frames';
import { YT } from '../shared/youtube';

function draw(video: HTMLVideoElement, w: number, h: number): CanvasRenderingContext2D | null {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, w, h);
    ctx.getImageData(0, 0, 1, 1); // throws if the canvas is tainted
    return ctx;
  } catch {
    return null;
  }
}

/** 64-bit dHash of the current frame, or null when it cannot be read. */
export function frameHash(video: HTMLVideoElement): string | null {
  if (!video.videoWidth) return null;
  const ctx = draw(video, DHASH_W, DHASH_H);
  return ctx ? dHash(toGray(ctx.getImageData(0, 0, DHASH_W, DHASH_H).data, DHASH_W, DHASH_H)) : null;
}

/** Edge density of the current frame (text and equations score high), or null. */
export function frameDensity(video: HTMLVideoElement): number | null {
  if (!video.videoWidth) return null;
  const w = 160;
  const h = Math.max(1, Math.round((w * video.videoHeight) / video.videoWidth));
  const ctx = draw(video, w, h);
  return ctx ? edgeDensity(toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h) : null;
}

/** JPEG of the current frame for the local buffer (long edge 1280, smaller than frames sent to the model). */
export function frameJpeg(video: HTMLVideoElement, longEdge = 1280, quality = 0.85): { dataUrl: string; width: number; height: number } | null {
  if (!video.videoWidth) return null;
  const size = capSize(video.videoWidth, video.videoHeight, longEdge);
  const ctx = draw(video, size.width, size.height);
  if (!ctx) return null;
  return { dataUrl: ctx.canvas.toDataURL('image/jpeg', quality), ...size };
}

const BUTTON_ID = 'yt-tutor-ask-button';

/** Adds the "Ask" button to the player's right-hand controls (idempotent). */
export function ensureAskButton(onClick: () => void): boolean {
  if (document.getElementById(BUTTON_ID)) return true;
  const controls = document.querySelector(YT.playerRightControlsSelector);
  if (!controls) return false;
  const b = document.createElement('button');
  b.id = BUTTON_ID;
  b.className = 'ytp-button';
  b.type = 'button';
  b.title = 'Ask YouTube Tutor about this moment';
  b.setAttribute('aria-label', 'Ask YouTube Tutor about this moment');
  b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;vertical-align:top;width:auto;padding:0 8px;';
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'white');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ['M4 5h16v11H9l-5 4z', 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.4', 'M12 14.5h.01']) {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  b.appendChild(svg);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  controls.insertBefore(b, controls.firstChild);
  return true;
}

/** Brief message over the player (visible in fullscreen too). */
export function showToast(text: string) {
  const host = document.querySelector(YT.playerSelector) ?? document.body;
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:absolute;left:50%;top:12%;transform:translateX(-50%);z-index:70;background:rgba(20,24,26,.88);color:#f4efe4;font:500 14px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;pointer-events:none;transition:opacity .4s;';
  host.appendChild(el);
  setTimeout(() => (el.style.opacity = '0'), 1800);
  setTimeout(() => el.remove(), 2300);
}
