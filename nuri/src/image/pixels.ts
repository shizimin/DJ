// キャンバスに依存しない純粋なピクセル処理 (テスト可能)。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA → 輝度 (0..255) */
export function luminance(rgba: Uint8ClampedArray, w: number, h: number, bg = 255): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const l = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    out[i] = l * a + bg * (1 - a); // 透明部分は白背景とみなす
  }
  return out;
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** 分離型ガウシアンぼかし */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice();
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

export interface LineArtOptions {
  /** 線の太さ (ガウス σ)。0.6〜3 程度 */
  thickness: number;
  /** 描き込み量 0..1 (大きいほど細かい線を拾う) */
  detail: number;
  /** ノイズ除去 (事前ぼかし σ) */
  denoise: number;
}

export const DEFAULT_LINEART: LineArtOptions = { thickness: 1.2, detail: 0.5, denoise: 0.8 };

/**
 * DoG (Difference of Gaussians) による写真の線画化。
 * 明るさの境目の「暗い側」に線を引く。戻り値は線の濃さ (0=紙, 255=線)。
 */
export function xdogLineArt(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: LineArtOptions = DEFAULT_LINEART,
): Uint8ClampedArray {
  const gray = gaussianBlur(luminance(rgba, w, h), w, h, opts.denoise);
  const g1 = gaussianBlur(gray, w, h, opts.thickness);
  const g2 = gaussianBlur(gray, w, h, opts.thickness * 1.6);
  const threshold = 1 + (1 - opts.detail) * 9; // detail が高いほど弱いエッジも拾う
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) {
    const e = g2[i] - g1[i]; // 暗い側で正
    out[i] = e > threshold ? Math.round(Math.tanh((e - threshold) * 0.35) * 255) : 0;
  }
  return out;
}

/**
 * 白い紙に描かれた線画を「透明な背景 + 指定色の線」に変換する (CSP の「輝度を透明度に変換」相当)。
 * whitePoint 以上の明るさは完全に透明、blackPoint 以下は完全に不透明。
 */
export function lumaToAlpha(
  rgba: Uint8ClampedArray,
  color: [number, number, number] | null = [0, 0, 0],
  blackPoint = 30,
  whitePoint = 235,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const range = Math.max(1, whitePoint - blackPoint);
  for (let p = 0; p < rgba.length; p += 4) {
    const l = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    const ink = Math.max(0, Math.min(1, (whitePoint - l) / range));
    const a = ink * (rgba[p + 3] / 255);
    if (color) {
      out[p] = color[0];
      out[p + 1] = color[1];
      out[p + 2] = color[2];
    } else {
      // 元の色を残す (カラー線画)。暗さに応じて色を濃くする
      const k = ink > 0 ? 1 / Math.max(ink, 1e-3) : 1;
      out[p] = Math.max(0, 255 - (255 - rgba[p]) * k);
      out[p + 1] = Math.max(0, 255 - (255 - rgba[p + 1]) * k);
      out[p + 2] = Math.max(0, 255 - (255 - rgba[p + 2]) * k);
    }
    out[p + 3] = Math.round(a * 255);
  }
  return out;
}

/** 線の濃さ (0..255) のグレースケールから RGBA の線画レイヤーを作る */
export function inkToRgba(ink: Uint8ClampedArray, color: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ink.length * 4);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    out[p] = color[0];
    out[p + 1] = color[1];
    out[p + 2] = color[2];
    out[p + 3] = ink[i];
  }
  return out;
}

/**
 * 塗りつぶし用の領域マスクを作る (スキャンライン方式)。
 * tolerance は RGBA 各チャンネルの最大差 (0..255)。
 */
export function floodFillMask(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tolerance = 16,
  contiguous = true,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const s = (sy * w + sx) * 4;
  const r0 = rgba[s], g0 = rgba[s + 1], b0 = rgba[s + 2], a0 = rgba[s + 3];
  const match = (i: number) => {
    const p = i * 4;
    // 透明ピクセル同士は色を無視して同一とみなす
    if (a0 === 0 && rgba[p + 3] <= tolerance) return true;
    return (
      Math.abs(rgba[p] - r0) <= tolerance &&
      Math.abs(rgba[p + 1] - g0) <= tolerance &&
      Math.abs(rgba[p + 2] - b0) <= tolerance &&
      Math.abs(rgba[p + 3] - a0) <= tolerance
    );
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (match(i)) mask[i] = 1;
    return mask;
  }
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = y * w + x;
    while (x > 0 && !mask[i - 1] && match(i - 1)) {
      x--;
      i--;
    }
    let up = false;
    let down = false;
    for (; x < w && !mask[i] && match(i); x++, i++) {
      mask[i] = 1;
      if (y > 0) {
        const m = !mask[i - w] && match(i - w);
        if (m && !up) stack.push(x, y - 1);
        up = m;
      }
      if (y < h - 1) {
        const m = !mask[i + w] && match(i + w);
        if (m && !down) stack.push(x, y + 1);
        down = m;
      }
    }
  }
  return mask;
}

/** マスクを radius ピクセル膨張させる (塗り残し防止) */
export function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let cur = mask;
  for (let r = 0; r < radius; r++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w]))
          next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** 不透明ピクセルの外接矩形。完全に透明なら null */
export function alphaBounds(rgba: Uint8ClampedArray, w: number, h: number, threshold = 0): Rect | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** src を dst 矩形に縦横比を保って「覆う」配置 (はみ出しはクロップ) */
export function coverRect(sw: number, sh: number, dw: number, dh: number): Rect {
  const s = Math.max(dw / sw, dh / sh);
  const w = sw * s;
  const h = sh * s;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/** src を dst 矩形に縦横比を保って「収める」配置 */
export function containRect(sw: number, sh: number, dw: number, dh: number): Rect {
  const s = Math.min(dw / sw, dh / sh);
  const w = sw * s;
  const h = sh * s;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/** 候補の縦横比 ("16:9" 等) からキャンバスに最も近いものを選ぶ */
export function nearestAspect(w: number, h: number, candidates: string[]): string {
  const target = Math.log(w / h);
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const [a, b] = c.split(/[:x]/).map(Number);
    const d = Math.abs(Math.log(a / b) - target);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
