// Frame-size and blank-frame logic (§4). Pure functions over plain numbers and pixel arrays.

/** Long-edge cap for frames sent to the model: small code and subscripts must stay legible. */
export const MAX_LONG_EDGE = 1568;

/** Output size that keeps native resolution but caps the long edge (never upscales). */
export function capSize(width: number, height: number, maxLongEdge = MAX_LONG_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface FrameStats {
  mean: number;
  stdDev: number;
  blank: boolean;
}

/**
 * Luminance statistics of RGBA pixels, sampling every `step`-th pixel. A frame is "blank" when it is
 * nearly uniform (protected content draws as solid black; a loading player as solid grey).
 */
export function frameStats(rgba: ArrayLike<number>, step = 1, uniformThreshold = 6): FrameStats {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  const stride = 4 * Math.max(1, Math.floor(step));
  for (let i = 0; i + 2 < rgba.length; i += stride) {
    const y = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    sum += y;
    sumSq += y * y;
    n++;
  }
  if (!n) return { mean: 0, stdDev: 0, blank: true };
  const mean = sum / n;
  const stdDev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { mean, stdDev, blank: stdDev < uniformThreshold };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A normalised (0..1) selection mapped to integer pixels inside an image of the given size. */
export function normalizedToPixels(sel: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(1, Math.min(sel.x, sel.x + sel.width)));
  const y0 = Math.max(0, Math.min(1, Math.min(sel.y, sel.y + sel.height)));
  const x1 = Math.max(0, Math.min(1, Math.max(sel.x, sel.x + sel.width)));
  const y1 = Math.max(0, Math.min(1, Math.max(sel.y, sel.y + sel.height)));
  const x = Math.floor(x0 * width);
  const y = Math.floor(y0 * height);
  return { x, y, width: Math.max(1, Math.ceil(x1 * width) - x), height: Math.max(1, Math.ceil(y1 * height) - y) };
}

/**
 * Where the video picture sits inside its element when it is letterboxed (object-fit: contain),
 * in CSS pixels relative to the element. Used to crop a tab screenshot to the picture only.
 */
export function containedRect(elementWidth: number, elementHeight: number, videoWidth: number, videoHeight: number): Rect {
  if (!videoWidth || !videoHeight || !elementWidth || !elementHeight) return { x: 0, y: 0, width: elementWidth, height: elementHeight };
  const scale = Math.min(elementWidth / videoWidth, elementHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { x: (elementWidth - width) / 2, y: (elementHeight - height) / 2, width, height };
}

/** "data:image/jpeg;base64,AAAA" -> { mediaType, data }. */
export function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
