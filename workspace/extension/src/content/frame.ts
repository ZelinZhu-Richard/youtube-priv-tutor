// Frame capture (§4): draw the <video> to a canvas at native resolution (long edge capped), check for
// a blank frame, and fall back to a cropped tab screenshot taken by the service worker.
import type { CropResult, FrameResult } from '../shared/messages';
import { capSize, containedRect, frameStats, normalizedToPixels, type Rect } from '../shared/image';
import { qualityLabel } from '../shared/youtube';
import { sendToBackground, uid } from '../shared/rpc';

/** The last capture kept at native resolution so a region crop is sharp (§12.3 "point at it"). */
let last: { id: string; canvas: HTMLCanvasElement } | null = null;

export function clearCaptures() {
  last = null;
}

function isBlank(source: CanvasImageSource): boolean {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 54;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return frameStats(ctx.getImageData(0, 0, c.width, c.height).data).blank;
}

function encode(canvas: HTMLCanvasElement): { dataUrl: string; width: number; height: number } {
  const size = capSize(canvas.width, canvas.height);
  let out = canvas;
  if (size.width !== canvas.width || size.height !== canvas.height) {
    out = document.createElement('canvas');
    out.width = size.width;
    out.height = size.height;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, size.width, size.height);
  }
  return { dataUrl: out.toDataURL('image/jpeg', 0.92), width: size.width, height: size.height };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the screenshot'));
    img.src = dataUrl;
  });
}

export async function captureFrame(video: HTMLVideoElement | null): Promise<FrameResult> {
  if (!video || !video.videoWidth || !video.videoHeight) {
    return { ok: false, reason: 'no-video', message: 'The video has not loaded a frame yet.' };
  }
  const nativeWidth = video.videoWidth;
  const nativeHeight = video.videoHeight;
  const t = video.currentTime;
  const quality = qualityLabel(nativeHeight);
  const lowQuality = nativeHeight < 720;

  // 1. Primary: draw the video element. Clean frame, no player chrome.
  try {
    const canvas = document.createElement('canvas');
    canvas.width = nativeWidth;
    canvas.height = nativeHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(video, 0, 0, nativeWidth, nativeHeight);
    if (!isBlank(canvas)) {
      const id = uid('f');
      last = { id, canvas };
      const enc = encode(canvas);
      return { ok: true, captureId: id, ...enc, nativeWidth, nativeHeight, t, via: 'canvas', qualityLabel: quality, lowQuality };
    }
  } catch {
    /* tainted or failed: fall through to tab capture */
  }

  // 2. Fallback: screenshot of the tab, cropped to the picture inside the video element.
  const box = video.getBoundingClientRect();
  const pic = containedRect(box.width, box.height, nativeWidth, nativeHeight);
  const rect: Rect = { x: box.left + pic.x, y: box.top + pic.y, width: pic.width, height: pic.height };
  if (rect.width < 16 || rect.height < 16 || rect.x + rect.width < 0 || rect.y + rect.height < 0) {
    return { ok: false, reason: 'blank', message: 'The frame came back blank and the video is not visible on screen for a screenshot.' };
  }
  let res;
  try {
    res = await sendToBackground({ type: 'bg/capture-tab', rect, viewportWidth: window.innerWidth });
  } catch (e) {
    return { ok: false, reason: 'error', message: String(e) };
  }
  if (!res.ok) {
    return res.reason === 'denied'
      ? { ok: false, reason: 'tab-capture-denied', message: res.message }
      : { ok: false, reason: 'error', message: res.message };
  }
  const img = await loadImage(res.dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  if (isBlank(canvas)) {
    return { ok: false, reason: 'blank', message: 'The frame is blank (protected video, or nothing drawn yet), so no image will be sent.' };
  }
  const id = uid('f');
  last = { id, canvas };
  const enc = encode(canvas);
  return { ok: true, captureId: id, ...enc, nativeWidth, nativeHeight, t, via: 'tab', qualityLabel: quality, lowQuality };
}

/** Crops the last capture at its native resolution. rect is normalised (0..1). */
export function cropLast(captureId: string, rect: Rect): CropResult {
  if (!last || last.id !== captureId) return { ok: false, message: 'That frame is no longer available. Capture it again.' };
  const px = normalizedToPixels(rect, last.canvas.width, last.canvas.height);
  const size = capSize(px.width, px.height);
  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(last.canvas, px.x, px.y, px.width, px.height, 0, 0, size.width, size.height);
  const png = size.width * size.height <= 1_000_000;
  return { ok: true, dataUrl: png ? out.toDataURL('image/png') : out.toDataURL('image/jpeg', 0.92), width: size.width, height: size.height };
}
