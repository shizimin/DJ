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
  /** 入り (描き始めを細くする長さ px) */
  taperIn?: number;
  /** 抜き (描き終わりを細くする長さ px) */
  taperOut?: number;
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
    { ...base, id: "inking", name: "入り抜きペン", size: 8, hardness: 1, pressureSize: true, minSize: 0.2, stabilizer: 6, taperIn: 40, taperOut: 80 },
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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const emptyBounds = () => ({ x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });

/**
 * 1 ストローク分の描画。
 * 入力点の間は 2 次ベジェ (隣り合う点の中点を通る) で滑らかにつなぎ、一定間隔でスタンプを置く。
 * 抜きはストロークの全長が分かる finish() の時点で、全体を描き直して適用する。
 */
export class Stroke {
  readonly buffer: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private stamp: HTMLCanvasElement | null;
  private pts: StrokePoint[] = [];
  /** 描画済みの経路長 */
  private dist = 0;
  /** 次のスタンプまでの距離の持ち越し */
  private residual = 0;
  /** 抜きの計算に使う全長 (描き直し時のみ 0 以外) */
  private total = 0;
  bounds = emptyBounds();
  private pending = emptyBounds();

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

  /** 入り抜きによるサイズの倍率 */
  private taper(): number {
    const b = this.brush;
    let f = 1;
    if (b.taperIn && b.taperIn > 0) {
      const len = this.total ? Math.min(b.taperIn, this.total * 0.45) : b.taperIn;
      f *= 0.08 + 0.92 * smoothstep(Math.min(1, this.dist / len));
    }
    if (this.total && b.taperOut && b.taperOut > 0) {
      const len = Math.min(b.taperOut, this.total * 0.45);
      f *= 0.05 + 0.95 * smoothstep(Math.min(1, Math.max(0, this.total - this.dist) / len));
    }
    return f;
  }

  private sizeAt(p: number) {
    const b = this.brush;
    const base = b.pressureSize ? b.size * (b.minSize + (1 - b.minSize) * p) : b.size;
    return base * this.taper();
  }

  private alphaAt(p: number) {
    const b = this.brush;
    return b.flow * (b.pressureOpacity ? 0.1 + 0.9 * p : 1);
  }

  private grow(x: number, y: number, r: number) {
    for (const bd of [this.bounds, this.pending]) {
      bd.x1 = Math.min(bd.x1, x - r);
      bd.y1 = Math.min(bd.y1, y - r);
      bd.x2 = Math.max(bd.x2, x + r);
      bd.y2 = Math.max(bd.y2, y + r);
    }
  }

  private dab(x: number, y: number, pressure: number, angle: number) {
    let size = this.sizeAt(pressure);
    let alpha = this.alphaAt(pressure);
    if (size < 1) {
      // 1px 未満は薄くして細さを表現する
      alpha *= Math.max(0.05, size);
      size = 1;
    }
    const g = this.g;
    const b = this.brush;
    if (b.scatter) {
      x += (Math.random() - 0.5) * size * b.scatter;
      y += (Math.random() - 0.5) * size * b.scatter;
    }
    g.globalAlpha = alpha;
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
    this.grow(x, y, size / 2 + (b.scatter ? size * b.scatter : 0) + 2);
  }

  /** 直線 a→b をスタンプで埋める (経路長 dist を進めながら) */
  private segment(a: StrokePoint, b: StrokePoint) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const start = this.dist;
    const angle = Math.atan2(dy, dx);
    let t = this.residual;
    while (t <= len) {
      const f = t / len;
      const p = a.pressure + (b.pressure - a.pressure) * f;
      this.dist = start + t;
      this.dab(a.x + dx * f, a.y + dy * f, p, angle);
      t += Math.max(0.5, this.sizeAt(p) * this.brush.spacing);
    }
    this.residual = t - len;
    this.dist = start + len;
  }

  /** 2 次ベジェを細かい直線に分けて描く */
  private quad(a: StrokePoint, c: StrokePoint, b: StrokePoint) {
    const approx = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
    const n = Math.max(1, Math.ceil(approx / 2));
    let prev = a;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const pt = {
        x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
      };
      this.segment(prev, pt);
      prev = pt;
    }
  }

  private static mid(a: StrokePoint, b: StrokePoint): StrokePoint {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, pressure: (a.pressure + b.pressure) / 2 };
  }

  private feed(pt: StrokePoint) {
    const pts = this.pts;
    pts.push(pt);
    const n = pts.length;
    if (n === 1) this.dab(pt.x, pt.y, pt.pressure, 0);
    else if (n === 2) this.segment(pts[0], Stroke.mid(pts[0], pts[1]));
    else this.quad(Stroke.mid(pts[n - 3], pts[n - 2]), pts[n - 2], Stroke.mid(pts[n - 2], pts[n - 1]));
  }

  private closeTail() {
    const n = this.pts.length;
    if (n >= 2) this.segment(Stroke.mid(this.pts[n - 2], this.pts[n - 1]), this.pts[n - 1]);
  }

  /** 点を追加する (筆圧のブレは少しならす) */
  add(pt: StrokePoint) {
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.3) return;
    const p = last ? last.pressure + (pt.pressure - last.pressure) * 0.6 : pt.pressure;
    this.feed({ x: pt.x, y: pt.y, pressure: p });
  }

  /** 最後の点まで描き切る。抜きがあるブラシは全長が分かったので全体を描き直す */
  finish() {
    this.closeTail();
    if (!this.brush.taperOut || this.brush.taperOut <= 0 || this.dist <= 1) return;
    const total = this.dist;
    const r = this.dirty;
    if (r) this.g.clearRect(r.x, r.y, r.w, r.h);
    const input = this.pts;
    this.pts = [];
    this.dist = 0;
    this.residual = 0;
    this.total = total;
    for (const p of input) this.feed(p);
    this.closeTail();
  }

  get dirty(): Rect | null {
    const b = this.bounds;
    if (b.x2 < b.x1) return null;
    return { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 };
  }

  /** 前回呼んでから描いた範囲 (画面の部分更新用) */
  takeDirty(): Rect | null {
    const b = this.pending;
    if (b.x2 < b.x1) return null;
    this.pending = emptyBounds();
    return { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 };
  }
}

/**
 * レイヤー画像にストロークを合成する。
 * erase: 消しゴム / lockAlpha: 透明ピクセル保護 / selection: 選択範囲マスク / rect: この範囲だけ処理
 */
export function applyStroke(
  target: CanvasRenderingContext2D,
  stroke: HTMLCanvasElement,
  opts: { opacity: number; erase: boolean; lockAlpha: boolean; selection: HTMLCanvasElement | null; scratch: HTMLCanvasElement; rect?: Rect | null },
) {
  const clip = (g: CanvasRenderingContext2D) => {
    if (!opts.rect) return;
    g.beginPath();
    g.rect(opts.rect.x, opts.rect.y, opts.rect.w, opts.rect.h);
    g.clip();
  };
  let src: HTMLCanvasElement = stroke;
  if (opts.selection) {
    const s = ctx2d(opts.scratch);
    s.save();
    clip(s);
    s.globalAlpha = 1;
    s.globalCompositeOperation = "copy";
    s.drawImage(stroke, 0, 0);
    s.globalCompositeOperation = "destination-in";
    s.drawImage(opts.selection, 0, 0);
    s.restore();
    src = opts.scratch;
  }
  target.save();
  clip(target);
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
