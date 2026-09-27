// ドキュメント (キャンバス + レイヤー) のモデルと合成処理。

export const BLEND_MODES = {
  normal: "通常",
  multiply: "乗算",
  screen: "スクリーン",
  overlay: "オーバーレイ",
  darken: "比較(暗)",
  lighten: "比較(明)",
  "color-dodge": "覆い焼き",
  "color-burn": "焼き込み",
  add: "加算",
  "hard-light": "ハードライト",
  "soft-light": "ソフトライト",
  difference: "差の絶対値",
  exclusion: "除外",
  hue: "色相",
  saturation: "彩度",
  color: "カラー",
  luminosity: "輝度",
} as const;

export type BlendMode = keyof typeof BLEND_MODES;

export function compositeOp(mode: BlendMode): GlobalCompositeOperation {
  if (mode === "normal") return "source-over";
  if (mode === "add") return "lighter";
  return mode;
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext("2d", { willReadFrequently: false })!;
}

let nextId = 1;

export class Layer {
  id = nextId++;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible = true;
  opacity = 1;
  blend: BlendMode = "normal";
  /** 下のレイヤーでクリッピング */
  clip = false;
  /** 透明ピクセルを保護 */
  lockAlpha = false;
  locked = false;
  /** 用紙レイヤー (塗りつぶしの白) */
  paper = false;
  /** 表示用のサムネイル更新カウンタ */
  version = 0;

  constructor(
    public name: string,
    w: number,
    h: number,
  ) {
    this.canvas = createCanvas(w, h);
    this.ctx = ctx2d(this.canvas);
  }

  touch() {
    this.version++;
  }
}

export interface DocEvents {
  /** レイヤー構成・プロパティの変更 (パネル再描画) */
  layers: void;
  /** ピクセルの変更 (再合成) */
  pixels: void;
  selection: void;
}

type Listener = () => void;

export class Doc {
  layers: Layer[] = []; // 下 → 上
  activeId = 0;
  /** 選択範囲 (白 = 選択)。null なら全体 */
  selection: HTMLCanvasElement | null = null;
  /** 選択範囲の輪郭表示用のパス (矩形・投げなわ) */
  selectionPath: Path2D | null = null;
  name = "無題";
  private listeners: Record<keyof DocEvents, Set<Listener>> = {
    layers: new Set(),
    pixels: new Set(),
    selection: new Set(),
  };

  constructor(
    public width: number,
    public height: number,
  ) {}

  on(ev: keyof DocEvents, fn: Listener) {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  emit(ev: keyof DocEvents) {
    for (const fn of this.listeners[ev]) fn();
    if (ev === "layers") for (const fn of this.listeners.pixels) fn();
  }

  get active(): Layer | undefined {
    return this.layers.find((l) => l.id === this.activeId) ?? this.layers[this.layers.length - 1];
  }

  indexOf(layer: Layer) {
    return this.layers.indexOf(layer);
  }

  newLayer(name?: string): Layer {
    return new Layer(name ?? `レイヤー ${this.layers.length + 1}`, this.width, this.height);
  }

  /** レイヤーを index の位置 (未指定ならアクティブの上) に挿入 */
  insert(layer: Layer, index?: number) {
    const at = index ?? (this.active ? this.indexOf(this.active) + 1 : this.layers.length);
    this.layers.splice(Math.max(0, Math.min(at, this.layers.length)), 0, layer);
    this.activeId = layer.id;
    this.emit("layers");
  }

  remove(layer: Layer) {
    const i = this.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (this.activeId === layer.id) this.activeId = this.layers[Math.max(0, i - 1)]?.id ?? 0;
    this.emit("layers");
  }

  move(layer: Layer, toIndex: number) {
    const i = this.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(toIndex, this.layers.length)), 0, layer);
    this.emit("layers");
  }

  /** クリッピンググループの土台 (クリップされていない最も近い下のレイヤー) の index */
  clipBaseIndex(i: number): number {
    while (i > 0 && this.layers[i].clip) i--;
    return i;
  }

  /**
   * layers[from..to) を ctx に合成する。
   * override を渡すと、そのレイヤーの画像を差し替えて描画する (描画中のプレビュー用)。
   */
  compositeRange(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    override?: { layer: Layer; image: CanvasImageSource },
  ) {
    const imageOf = (l: Layer) => (override && override.layer === l ? override.image : l.canvas);
    let i = from;
    while (i < to) {
      const base = this.layers[i];
      let end = i + 1;
      while (end < this.layers.length && this.layers[end].clip) end++;
      if (!base.visible) {
        i = end;
        continue;
      }
      const clipped = this.layers.slice(i + 1, Math.min(end, to)).filter((l) => l.visible && l.opacity > 0);
      ctx.save();
      ctx.globalAlpha = base.opacity;
      ctx.globalCompositeOperation = compositeOp(base.blend);
      if (clipped.length === 0) {
        ctx.drawImage(imageOf(base), 0, 0);
      } else {
        ctx.drawImage(this.clipGroup(base, clipped, imageOf), 0, 0);
      }
      ctx.restore();
      i = end;
    }
  }

  private scratch: HTMLCanvasElement[] = [];
  private scratchCanvas(n: number) {
    let c = this.scratch[n];
    if (!c || c.width !== this.width || c.height !== this.height) {
      c = this.scratch[n] = createCanvas(this.width, this.height);
    }
    const g = ctx2d(c);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, c.width, c.height);
    return c;
  }

  private clipGroup(base: Layer, clipped: Layer[], imageOf: (l: Layer) => CanvasImageSource) {
    const group = this.scratchCanvas(0);
    const g = ctx2d(group);
    g.drawImage(imageOf(base), 0, 0);
    for (const l of clipped) {
      const tmp = this.scratchCanvas(1);
      const t = ctx2d(tmp);
      t.drawImage(imageOf(l), 0, 0);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(imageOf(base), 0, 0);
      g.globalAlpha = l.opacity;
      g.globalCompositeOperation = l.blend === "normal" ? "source-atop" : compositeOp(l.blend);
      g.drawImage(tmp, 0, 0);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    return group;
  }

  /** 表示中のレイヤーを合成した新しいキャンバス */
  flatten(opts: { background?: string } = {}): HTMLCanvasElement {
    const c = createCanvas(this.width, this.height);
    const g = ctx2d(c);
    if (opts.background) {
      g.fillStyle = opts.background;
      g.fillRect(0, 0, c.width, c.height);
    }
    this.compositeRange(g, 0, this.layers.length);
    return c;
  }

  setSelection(mask: HTMLCanvasElement | null, path: Path2D | null = null) {
    this.selection = mask;
    this.selectionPath = path;
    this.emit("selection");
  }
}

/** 白い用紙レイヤー付きの新規ドキュメント */
export function createDocument(w: number, h: number, name = "無題"): Doc {
  const doc = new Doc(w, h);
  doc.name = name;
  const paper = doc.newLayer("用紙");
  paper.paper = true;
  paper.ctx.fillStyle = "#ffffff";
  paper.ctx.fillRect(0, 0, w, h);
  doc.layers.push(paper);
  const layer = doc.newLayer("レイヤー 1");
  doc.layers.push(layer);
  doc.activeId = layer.id;
  return doc;
}
