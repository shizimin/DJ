// スタンプ方式のブラシエンジン。
// 1 ストローク分をストロークバッファに描き、ペンを離したときにレイヤーへ合成する
// (ストローク内で重なっても不透明度が上限を超えない、CSP と同じ挙動)。

import { createCanvas, ctx2d } from "./doc";

export interface BrushTip {
  /** 白 = 描画される部分のアルファマスク */
  canvas: HTMLCanvasElement;
  /** 永続化用 (PNG data URL) */
  dataUrl?: string;
}

export interface Brush {
  id: string;
  name: string;
  size: number;
  /** ストローク全体の不透明度 */
  opacity: number;
  /** 1 スタンプあたりの濃さ */
  flow: number;
  /** 0 = ぼかし, 1 = くっきり (円形ブラシのみ) */
  hardness: number;
  /** ブラシサイズに対する間隔 */
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** 筆圧 0 のときのサイズ比 */
  minSize: number;
  /** 手ブレ補正 0..20 */
  stabilizer: number;
  /** ストロークの向きに先端を回転 */
  rotate?: boolean;
  /** ばらつき (サイズに対する比) */
  scatter?: number;
  tip?: BrushTip;
  /** 読み込み元 (sut ファイル名など) */
  source?: string;
}

function noiseTip(size = 64): BrushTip {
  const c = createCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - r + 0.5, y - r + 0.5) / r;
      const a = d > 1 ? 0 : (0.35 + Math.random() * 0.65) * (1 - d * d * 0.5);
      const p = (y * size + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
      img.data[p + 3] = Math.round(a * 255 * (Math.random() < 0.8 ? 1 : 0.3));
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c };
}

export function defaultBrushes(): Brush[] {
  const base = { opacity: 1, flow: 1, spacing: 0.08, pressureOpacity: false, minSize: 0.15, stabilizer: 3 };
  return [
    { ...base, id: "pen", name: "G ペン", size: 6, hardness: 1, pressureSize: true, minSize: 0.05 },
    { ...base, id: "maru", name: "丸ペン", size: 3, hardness: 1, pressureSize: true, minSize: 0.3 },
    { ...base, id: "pencil", name: "鉛筆", size: 8, hardness: 0.8, flow: 0.55, spacing: 0.12, pressureSize: true, pressureOpacity: true, minSize: 0.5, stabilizer: 1, tip: noiseTip() },
    { ...base, id: "brush", name: "不透明水彩", size: 30, hardness: 0.75, flow: 0.35, spacing: 0.06, pressureSize: true, pressureOpacity: true, minSize: 0.4, stabilizer: 2 },
    { ...base, id: "air", name: "エアブラシ", size: 120, hardness: 0, flow: 0.08, spacing: 0.08, pressureSize: false, pressureOpacity: true, minSize: 1, stabilizer: 0 },
    { ...base, id: "marker", name: "マーカー", size: 16, hardness: 0.95, opacity: 0.6, pressureSize: false, minSize: 1 },
  ];
}

export function eraserBrushes(): Brush[] {
  const base = { opacity: 1, flow: 1, spacing: 0.08, pressureOpacity: false, minSize: 0.3, stabilizer: 0 };
  return [
    { ...base, id: "eraser-hard", name: "硬め", size: 20, hardness: 1, pressureSize: true },
    { ...base, id: "eraser-soft", name: "やわらか", size: 60, hardness: 0, flow: 0.3, pressureSize: false, minSize: 1 },
  ];
}

// ---------------------------------------------------------------- 先端画像

const tipCache = new Map<string, HTMLCanvasElement>();

function roundTip(hardness: number): HTMLCanvasElement {
  const key = `round:${hardness.toFixed(2)}`;
  let c = tipCache.get(key);
  if (c) return c;
  const size = 256;
  c = createCanvas(size, size);
  const g = ctx2d(c);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const h = Math.min(0.99, Math.max(0, hardness));
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(h, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  tipCache.set(key, c);
  return c;
}

/** 先端 (アルファマスク) を指定色で塗った画像 */
function coloredTip(mask: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = createCanvas(mask.width, mask.height);
  const g = ctx2d(c);
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------- ストローク

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

export class Stroke {
  readonly buffer: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private stamp: HTMLCanvasElement | null;
  private last: StrokePoint | null = null;
  private residual = 0;
  bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };

  constructor(
    public brush: Brush,
    public color: string,
    buffer: HTMLCanvasElement,
  ) {
    this.buffer = buffer;
    this.g = ctx2d(buffer);
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.globalAlpha = 1;
    this.g.globalCompositeOperation = "source-over";
    this.g.clearRect(0, 0, buffer.width, buffer.height);
    const hardRound = !brush.tip && brush.hardness >= 0.98;
    this.stamp = hardRound ? null : coloredTip(brush.tip?.canvas ?? roundTip(brush.hardness), color);
    this.g.fillStyle = color;
  }

  private sizeAt(p: number) {
    const b = this.brush;
    return b.pressureSize ? b.size * (b.minSize + (1 - b.minSize) * p) : b.size;
  }

  private alphaAt(p: number) {
    const b = this.brush;
    return b.flow * (b.pressureOpacity ? 0.1 + 0.9 * p : 1);
  }

  private dab(x: number, y: number, pressure: number, angle: number) {
    const size = Math.max(0.5, this.sizeAt(pressure));
    const g = this.g;
    const b = this.brush;
    if (b.scatter) {
      x += (Math.random() - 0.5) * size * b.scatter;
      y += (Math.random() - 0.5) * size * b.scatter;
    }
    g.globalAlpha = this.alphaAt(pressure);
    if (!this.stamp) {
      g.beginPath();
      g.arc(x, y, size / 2, 0, Math.PI * 2);
      g.fill();
    } else if (b.rotate) {
      g.save();
      g.translate(x, y);
      g.rotate(angle);
      g.drawImage(this.stamp, -size / 2, -size / 2, size, size);
      g.restore();
    } else {
      g.drawImage(this.stamp, x - size / 2, y - size / 2, size, size);
    }
    const r = size / 2 + (b.scatter ? size * b.scatter : 0) + 2;
    const bd = this.bounds;
    bd.x1 = Math.min(bd.x1, x - r);
    bd.y1 = Math.min(bd.y1, y - r);
    bd.x2 = Math.max(bd.x2, x + r);
    bd.y2 = Math.max(bd.y2, y + r);
  }

  /** 点を追加し、前の点との間をスタンプで埋める */
  add(pt: StrokePoint) {
    if (!this.last) {
      this.last = pt;
      this.dab(pt.x, pt.y, pt.pressure, 0);
      return;
    }
    const a = this.last;
    const dx = pt.x - a.x;
    const dy = pt.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return;
    const angle = Math.atan2(dy, dx);
    let t = this.residual;
    while (t <= dist) {
      const f = t / dist;
      const p = a.pressure + (pt.pressure - a.pressure) * f;
      this.dab(a.x + dx * f, a.y + dy * f, p, angle);
      t += Math.max(0.5, this.sizeAt(p) * this.brush.spacing);
    }
    this.residual = t - dist;
    this.last = pt;
  }

  get dirty() {
    const b = this.bounds;
    if (b.x2 < b.x1) return null;
    return { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 };
  }
}

/**
 * レイヤー画像にストロークを合成する。
 * erase: 消しゴム / lockAlpha: 透明ピクセル保護 / selection: 選択範囲マスク
 */
export function applyStroke(
  target: CanvasRenderingContext2D,
  stroke: HTMLCanvasElement,
  opts: { opacity: number; erase: boolean; lockAlpha: boolean; selection: HTMLCanvasElement | null; scratch: HTMLCanvasElement },
) {
  let src: HTMLCanvasElement = stroke;
  if (opts.selection) {
    const s = ctx2d(opts.scratch);
    s.globalAlpha = 1;
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, opts.scratch.width, opts.scratch.height);
    s.drawImage(stroke, 0, 0);
    s.globalCompositeOperation = "destination-in";
    s.drawImage(opts.selection, 0, 0);
    s.globalCompositeOperation = "source-over";
    src = opts.scratch;
  }
  target.save();
  target.globalAlpha = opts.opacity;
  target.globalCompositeOperation = opts.erase ? "destination-out" : opts.lockAlpha ? "source-atop" : "source-over";
  target.drawImage(src, 0, 0);
  target.restore();
}

/** 手ブレ補正: 入力点を遅れて追従させる */
export class Stabilizer {
  private p: StrokePoint | null = null;
  constructor(private level: number) {}
  push(pt: StrokePoint): StrokePoint {
    if (!this.p || this.level <= 0) return (this.p = pt);
    const k = 1 / (1 + this.level * 0.6);
    this.p = {
      x: this.p.x + (pt.x - this.p.x) * k,
      y: this.p.y + (pt.y - this.p.y) * k,
      pressure: this.p.pressure + (pt.pressure - this.p.pressure) * k,
    };
    return this.p;
  }
}
