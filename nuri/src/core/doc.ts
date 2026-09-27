// ドキュメント (キャンバス + レイヤーツリー) のモデルと合成処理。
// レイヤーはフォルダ (Group) で入れ子にでき、各リストは「下 → 上」の順。

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
/** フォルダは「通過」も選べる */
export type GroupBlend = BlendMode | "pass-through";

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
  readonly kind = "layer";
  id = nextId++;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible = true;
  opacity = 1;
  blend: BlendMode = "normal";
  /** 下のレイヤー (またはフォルダ) でクリッピング */
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

export class Group {
  readonly kind = "group";
  id = nextId++;
  children: Node[] = [];
  visible = true;
  opacity = 1;
  blend: GroupBlend = "pass-through";
  clip = false;
  locked = false;
  /** レイヤーパネルで開いているか */
  open = true;
  constructor(public name: string) {}
}

export type Node = Layer | Group;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompositeOptions {
  /** 指定レイヤーの画像を差し替える (描画中のプレビュー) */
  override?: { layer: Layer; image: CanvasImageSource };
  /** この範囲だけを描き直す */
  rect?: Rect | null;
}

type Listener = () => void;

export class Doc {
  /** 最上位のフォルダ (表示されない) */
  root = new Group("root");
  /** アクティブなレイヤーまたはフォルダ */
  activeId = 0;
  /** 選択範囲 (白 = 選択)。null なら全体 */
  selection: HTMLCanvasElement | null = null;
  /** 選択範囲の輪郭表示用のパス (矩形・投げなわ) */
  selectionPath: Path2D | null = null;
  name = "無題";
  private listeners: Record<"layers" | "pixels" | "selection", Set<Listener>> = {
    layers: new Set(),
    pixels: new Set(),
    selection: new Set(),
  };

  constructor(
    public width: number,
    public height: number,
  ) {}

  on(ev: "layers" | "pixels" | "selection", fn: Listener) {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  emit(ev: "layers" | "pixels" | "selection") {
    for (const fn of this.listeners[ev]) fn();
    if (ev === "layers") for (const fn of this.listeners.pixels) fn();
  }

  // ------------------------------------------------------------ ツリー

  /** 全ノード (深さ優先・下 → 上。フォルダは中身より前) */
  nodes(from: Group = this.root): Node[] {
    const out: Node[] = [];
    const walk = (g: Group) => {
      for (const n of g.children) {
        out.push(n);
        if (n.kind === "group") walk(n);
      }
    };
    walk(from);
    return out;
  }

  /** ラスターレイヤーだけを下 → 上の順で (読み取り専用の一覧) */
  get layers(): Layer[] {
    return this.nodes().filter((n): n is Layer => n.kind === "layer");
  }

  find(id: number): Node | undefined {
    return this.nodes().find((n) => n.id === id);
  }

  parentOf(node: Node): Group | null {
    const search = (g: Group): Group | null => {
      for (const c of g.children) {
        if (c === node) return g;
        if (c.kind === "group") {
          const r = search(c);
          if (r) return r;
        }
      }
      return null;
    };
    return search(this.root);
  }

  /** 親フォルダの中での位置 */
  indexOf(node: Node): number {
    return this.parentOf(node)?.children.indexOf(node) ?? -1;
  }

  /** node が ancestor の中 (子孫) にあるか */
  isInside(node: Node, ancestor: Group): boolean {
    for (let p = this.parentOf(node); p; p = this.parentOf(p)) if (p === ancestor) return true;
    return false;
  }

  /** 祖先フォルダを含めて表示されているか */
  isVisible(node: Node): boolean {
    if (!node.visible) return false;
    for (let p = this.parentOf(node); p && p !== this.root; p = this.parentOf(p)) if (!p.visible) return false;
    return true;
  }

  /** 描画対象のレイヤー (フォルダ選択中は undefined) */
  get active(): Layer | undefined {
    const n = this.activeNode;
    return n?.kind === "layer" ? n : undefined;
  }

  get activeNode(): Node | undefined {
    return this.find(this.activeId) ?? this.layers[this.layers.length - 1];
  }

  newLayer(name?: string): Layer {
    return new Layer(name ?? `レイヤー ${this.layers.length + 1}`, this.width, this.height);
  }

  newGroup(name?: string): Group {
    return new Group(name ?? `フォルダ ${this.nodes().filter((n) => n.kind === "group").length + 1}`);
  }

  /** 挿入先の既定: アクティブの 1 つ上 (同じフォルダ内) */
  defaultSlot(): { parent: Group; index: number } {
    const a = this.activeNode;
    if (!a) return { parent: this.root, index: this.root.children.length };
    const parent = this.parentOf(a) ?? this.root;
    return { parent, index: parent.children.indexOf(a) + 1 };
  }

  insert(node: Node, index?: number, parent?: Group) {
    const slot = this.defaultSlot();
    const p = parent ?? (index === undefined ? slot.parent : this.root);
    const at = index ?? slot.index;
    p.children.splice(Math.max(0, Math.min(at, p.children.length)), 0, node);
    this.activeId = node.id;
    this.emit("layers");
  }

  remove(node: Node) {
    const parent = this.parentOf(node);
    if (!parent) return;
    const i = parent.children.indexOf(node);
    parent.children.splice(i, 1);
    if (this.activeId === node.id || (node.kind === "group" && !this.find(this.activeId))) {
      this.activeId = parent.children[Math.max(0, i - 1)]?.id ?? (parent !== this.root ? parent.id : this.layers[0]?.id ?? 0);
    }
    this.emit("layers");
  }

  move(node: Node, toIndex: number, toParent?: Group) {
    const parent = this.parentOf(node);
    const target = toParent ?? parent;
    if (!parent || !target) return;
    if (node.kind === "group" && (target === node || this.isInside(target, node))) return; // 自分の中には入れない
    parent.children.splice(parent.children.indexOf(node), 1);
    target.children.splice(Math.max(0, Math.min(toIndex, target.children.length)), 0, node);
    this.emit("layers");
  }

  // ------------------------------------------------------------ 合成

  private pool = new Map<string, HTMLCanvasElement>();
  private scratch(key: string, rect: Rect | null | undefined) {
    let c = this.pool.get(key);
    if (!c || c.width !== this.width || c.height !== this.height) {
      c = createCanvas(this.width, this.height);
      this.pool.set(key, c);
    }
    const g = ctx2d(c);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    if (rect) g.clearRect(rect.x, rect.y, rect.w, rect.h);
    else g.clearRect(0, 0, c.width, c.height);
    return c;
  }

  /** 画面全体 (または rect の範囲) を ctx に合成する */
  composite(ctx: CanvasRenderingContext2D, opts: CompositeOptions = {}) {
    this.compositeList(ctx, this.root.children, 0, this.root.children.length, opts, 0);
  }

  /** root の子の [from, to) だけを合成する (描画中の下側キャッシュ用) */
  compositeRoot(ctx: CanvasRenderingContext2D, from: number, to: number, opts: CompositeOptions = {}) {
    this.compositeList(ctx, this.root.children, from, to, opts, 0);
  }

  /** クリッピンググループの土台の位置 */
  clipBase(list: Node[], i: number): number {
    while (i > 0 && list[i].clip && list[i].kind === "layer") i--;
    return i;
  }

  private withClip(ctx: CanvasRenderingContext2D, rect: Rect | null | undefined, fn: () => void) {
    ctx.save();
    if (rect) {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
    }
    fn();
    ctx.restore();
  }

  /** ノードの見た目 (フォルダは中身を合成した画像) */
  private render(node: Node, opts: CompositeOptions, depth: number): CanvasImageSource {
    if (node.kind === "layer") return opts.override?.layer === node ? opts.override.image : node.canvas;
    const c = this.scratch(`g${depth}`, opts.rect);
    const g = ctx2d(c);
    this.withClip(g, opts.rect, () => this.compositeList(g, node.children, 0, node.children.length, opts, depth + 1));
    return c;
  }

  private compositeList(ctx: CanvasRenderingContext2D, list: Node[], from: number, to: number, opts: CompositeOptions, depth: number) {
    let i = from;
    while (i < to) {
      const base = list[i];
      let end = i + 1;
      while (end < list.length && list[end].clip && list[end].kind === "layer") end++;
      if (!base.visible || base.opacity <= 0) {
        i = end;
        continue;
      }
      const clipped = list.slice(i + 1, Math.min(end, to)).filter((l): l is Layer => l.kind === "layer" && l.visible && l.opacity > 0);
      if (base.kind === "group" && base.blend === "pass-through" && base.opacity >= 1 && clipped.length === 0) {
        // 通過: 中身を親に直接合成する
        this.compositeList(ctx, base.children, 0, base.children.length, opts, depth + 1);
        i = end;
        continue;
      }
      const image = clipped.length ? this.clipGroup(this.render(base, opts, depth), clipped, opts, depth) : this.render(base, opts, depth);
      this.withClip(ctx, opts.rect, () => {
        ctx.globalAlpha = base.opacity;
        const blend = base.blend === "pass-through" ? "normal" : base.blend;
        ctx.globalCompositeOperation = compositeOp(blend);
        ctx.drawImage(image, 0, 0);
      });
      i = end;
    }
  }

  private clipGroup(baseImage: CanvasImageSource, clipped: Layer[], opts: CompositeOptions, depth: number) {
    const group = this.scratch(`c${depth}`, opts.rect);
    const g = ctx2d(group);
    this.withClip(g, opts.rect, () => {
      g.drawImage(baseImage, 0, 0);
      for (const l of clipped) {
        const tmp = this.scratch(`t${depth}`, opts.rect);
        const t = ctx2d(tmp);
        this.withClip(t, opts.rect, () => {
          t.drawImage(this.render(l, opts, depth + 1), 0, 0);
          t.globalCompositeOperation = "destination-in";
          t.drawImage(baseImage, 0, 0);
        });
        g.globalAlpha = l.opacity;
        g.globalCompositeOperation = l.blend === "normal" ? "source-atop" : compositeOp(l.blend);
        g.drawImage(tmp, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      }
    });
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
    this.composite(g);
    return c;
  }

  /** ノード 1 つ (フォルダなら中身) だけを合成した画像 */
  renderNode(node: Node): HTMLCanvasElement {
    const c = createCanvas(this.width, this.height);
    const g = ctx2d(c);
    if (node.kind === "layer") g.drawImage(node.canvas, 0, 0);
    else this.compositeList(g, node.children, 0, node.children.length, {}, 1);
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
  doc.root.children.push(paper);
  const layer = doc.newLayer("レイヤー 1");
  doc.root.children.push(layer);
  doc.activeId = layer.id;
  return doc;
}
