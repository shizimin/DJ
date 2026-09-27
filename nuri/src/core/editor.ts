// エディター本体: 表示 (ズーム・回転・パン)、ペン入力、各ツール、選択範囲。

import { applyStroke, defaultBrushes, eraserBrushes, Stabilizer, Stroke, type Brush, type Rect, type StrokePoint } from "./brush";
import { createCanvas, createDocument, ctx2d, type Doc, type Layer, type Node } from "./doc";
import { History, PixelSnapshot } from "./history";
import { dilateMask, floodFillMask } from "../image/pixels";

export type ToolId = "brush" | "eraser" | "fill" | "picker" | "select-rect" | "select-lasso" | "wand" | "move" | "hand";

export const TOOLS: { id: ToolId; label: string; key: string; icon: string }[] = [
  { id: "brush", label: "ペン・ブラシ", key: "b", icon: "✎" },
  { id: "eraser", label: "消しゴム", key: "e", icon: "⌫" },
  { id: "fill", label: "塗りつぶし", key: "g", icon: "◧" },
  { id: "picker", label: "スポイト", key: "i", icon: "⊙" },
  { id: "select-rect", label: "矩形選択", key: "m", icon: "⬚" },
  { id: "select-lasso", label: "投げなわ選択", key: "l", icon: "➰" },
  { id: "wand", label: "自動選択", key: "w", icon: "✦" },
  { id: "move", label: "レイヤー移動", key: "v", icon: "✥" },
  { id: "hand", label: "手のひら", key: "h", icon: "✋" },
];

export interface View {
  zoom: number;
  x: number;
  y: number;
  rot: number;
}

type Listener = () => void;

export function maskToCanvas(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const g = ctx2d(c);
  const img = g.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const p = i * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class Editor {
  doc!: Doc;
  history = new History();
  tool: ToolId = "brush";
  brushes: Brush[] = defaultBrushes();
  brushIndex = 0;
  erasers: Brush[] = eraserBrushes();
  eraserIndex = 0;
  color = "#1d1d1f";
  recentColors: string[] = [];
  fill = { tolerance: 24, allLayers: true, gap: 1 };
  /** 筆圧カーブ (1 = そのまま、大きいほど強く押さないと太くならない) */
  pressureCurve = 1;
  view: View = { zoom: 1, x: 0, y: 0, rot: 0 };

  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private listeners = new Set<Listener>();
  private raf = 0;
  private composite!: HTMLCanvasElement;
  private compositeDirty = true;
  private overlay: HTMLCanvasElement | null = null;
  private cursor: { x: number; y: number } | null = null;
  private spaceDown = false;
  private antsOffset = 0;
  private docUnsub: (() => void)[] = [];

  // 描画中の状態
  private strokeBuf!: HTMLCanvasElement;
  private scratch!: HTMLCanvasElement;
  private preview!: HTMLCanvasElement;
  private below!: HTMLCanvasElement;
  private drag: null | {
    kind: "stroke" | "pan" | "rect" | "lasso" | "move";
    start: { x: number; y: number };
    sx: number;
    sy: number;
    view?: View;
    stroke?: Stroke;
    stab?: Stabilizer;
    /** 手ブレ補正前の最後の入力点 (ペンを離したときに線を追いつかせる) */
    raw?: StrokePoint;
    snap?: PixelSnapshot;
    layer?: Layer;
    erase?: boolean;
    points?: { x: number; y: number }[];
    moveSrc?: HTMLCanvasElement;
    pointerId: number;
  } = null;
  private lastStrokeEnd: { x: number; y: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; mid: { x: number; y: number }; view: View } | null = null;

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "stage";
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext("2d")!;
    new ResizeObserver(() => this.requestRender()).observe(container);
    this.bindInput();
    this.setDocument(createDocument(1600, 1200));
    const tick = () => {
      if (this.doc?.selection) {
        this.antsOffset = (this.antsOffset + 0.5) % 16;
        this.requestRender();
      }
      setTimeout(tick, 80);
    };
    tick();
  }

  // ------------------------------------------------------------ 状態通知

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  get brush(): Brush {
    return this.tool === "eraser" ? this.erasers[this.eraserIndex] : this.brushes[this.brushIndex];
  }

  setTool(t: ToolId) {
    this.tool = t;
    this.canvas.dataset.tool = t;
    this.changed();
    this.requestRender();
  }

  setColor(c: string, remember = false) {
    this.color = c;
    if (remember) {
      this.recentColors = [c, ...this.recentColors.filter((x) => x !== c)].slice(0, 16);
    }
    this.changed();
  }

  // ------------------------------------------------------------ ドキュメント

  setDocument(doc: Doc) {
    this.docUnsub.forEach((f) => f());
    this.doc = doc;
    this.composite = createCanvas(doc.width, doc.height);
    this.strokeBuf = createCanvas(doc.width, doc.height);
    this.scratch = createCanvas(doc.width, doc.height);
    this.preview = createCanvas(doc.width, doc.height);
    this.below = createCanvas(doc.width, doc.height);
    this.overlay = null;
    this.docUnsub = [
      doc.on("pixels", () => this.invalidate()),
      doc.on("layers", () => this.changed()),
      doc.on("selection", () => {
        this.overlay = null;
        this.requestRender();
        this.changed();
      }),
    ];
    this.history.clear();
    this.lastStrokeEnd = null;
    requestAnimationFrame(() => this.fitView());
    this.invalidate();
    this.changed();
  }

  invalidate() {
    this.compositeDirty = true;
    this.requestRender();
  }

  // ------------------------------------------------------------ 表示

  fitView() {
    const r = this.container.getBoundingClientRect();
    const zoom = Math.min((r.width - 60) / this.doc.width, (r.height - 60) / this.doc.height, 4);
    this.view = { zoom: Math.max(0.02, zoom), rot: 0, x: r.width / 2, y: r.height / 2 };
    this.requestRender();
    this.changed();
  }

  setZoom(zoom: number, anchor?: { x: number; y: number }) {
    const r = this.container.getBoundingClientRect();
    const a = anchor ?? { x: r.width / 2, y: r.height / 2 };
    const docPt = this.toDoc(a.x, a.y);
    this.view.zoom = Math.max(0.02, Math.min(64, zoom));
    const after = this.toScreen(docPt.x, docPt.y);
    this.view.x += a.x - after.x;
    this.view.y += a.y - after.y;
    this.requestRender();
    this.changed();
  }

  rotate(deg: number | null) {
    const r = this.container.getBoundingClientRect();
    const c = this.toDoc(r.width / 2, r.height / 2);
    this.view.rot = deg === null ? 0 : this.view.rot + (deg * Math.PI) / 180;
    const after = this.toScreen(c.x, c.y);
    this.view.x += r.width / 2 - after.x;
    this.view.y += r.height / 2 - after.y;
    this.requestRender();
  }

  /** 画面座標 (コンテナ左上基準) → ドキュメント座標 */
  toDoc(sx: number, sy: number) {
    const { zoom, x, y, rot } = this.view;
    const dx = sx - x;
    const dy = sy - y;
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    return {
      x: (dx * c - dy * s) / zoom + this.doc.width / 2,
      y: (dx * s + dy * c) / zoom + this.doc.height / 2,
    };
  }

  toScreen(px: number, py: number) {
    const { zoom, x, y, rot } = this.view;
    const dx = (px - this.doc.width / 2) * zoom;
    const dy = (py - this.doc.height / 2) * zoom;
    return { x: dx * Math.cos(rot) - dy * Math.sin(rot) + x, y: dx * Math.sin(rot) + dy * Math.cos(rot) + y };
  }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private selectionOverlay() {
    const sel = this.doc.selection;
    if (!sel) return null;
    if (!this.overlay) {
      const c = createCanvas(this.doc.width, this.doc.height);
      const g = ctx2d(c);
      g.fillStyle = "rgba(40, 90, 255, 0.22)";
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "destination-out";
      g.drawImage(sel, 0, 0);
      this.overlay = c;
    }
    return this.overlay;
  }

  private render() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(rect.width * dpr);
    const H = Math.round(rect.height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = getComputedStyle(this.container).getPropertyValue("--workspace").trim() || "#2a2a2e";
    g.fillRect(0, 0, W, H);

    const { doc, view } = this;
    const image = this.drag?.kind === "stroke" || this.drag?.kind === "move" ? this.livePreview() : this.compositeImage();

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(view.x, view.y);
    g.rotate(view.rot);
    g.scale(view.zoom, view.zoom);
    g.translate(-doc.width / 2, -doc.height / 2);
    // 透明部分の市松模様
    g.save();
    g.fillStyle = checker(g);
    g.fillRect(0, 0, doc.width, doc.height);
    g.restore();
    g.imageSmoothingEnabled = view.zoom < 2;
    g.imageSmoothingQuality = "high";
    g.drawImage(image, 0, 0);
    g.imageSmoothingEnabled = true;

    const overlay = this.selectionOverlay();
    if (overlay) g.drawImage(overlay, 0, 0);
    g.lineWidth = 1 / view.zoom;
    if (doc.selectionPath) {
      g.setLineDash([4 / view.zoom, 4 / view.zoom]);
      g.strokeStyle = "#fff";
      g.lineDashOffset = 0;
      g.stroke(doc.selectionPath);
      g.strokeStyle = "#000";
      g.lineDashOffset = this.antsOffset / view.zoom;
      g.stroke(doc.selectionPath);
      g.setLineDash([]);
    }
    const d = this.drag;
    if (d?.kind === "rect" || d?.kind === "lasso") {
      g.setLineDash([4 / view.zoom, 4 / view.zoom]);
      g.strokeStyle = "#1a73e8";
      g.stroke(this.dragPath()!);
      g.setLineDash([]);
    }
    // ブラシサイズのカーソル
    if (this.cursor && (this.tool === "brush" || this.tool === "eraser") && !this.spaceDown) {
      const r = this.brush.size / 2;
      g.beginPath();
      g.arc(this.cursor.x, this.cursor.y, Math.max(r, 1 / view.zoom), 0, Math.PI * 2);
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.stroke();
      g.beginPath();
      g.arc(this.cursor.x, this.cursor.y, Math.max(r - 1 / view.zoom, 0.5 / view.zoom), 0, Math.PI * 2);
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.stroke();
    }
    // キャンバスの枠
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.strokeRect(0, 0, doc.width, doc.height);
  }

  compositeImage(): HTMLCanvasElement {
    if (this.compositeDirty) {
      const g = ctx2d(this.composite);
      g.clearRect(0, 0, this.composite.width, this.composite.height);
      this.doc.composite(g);
      this.compositeDirty = false;
    }
    return this.composite;
  }

  /** 描画中のレイヤーを含む root 直下のノードの、クリッピング土台の位置 */
  private liveBase = 0;

  /**
   * 描画中: 下側のキャッシュ + 編集中レイヤー + 上側を合成する。
   * ストローク中は前回から描いた範囲だけを描き直す (大きなキャンバスでも軽くするため)。
   */
  private livePreview(): HTMLCanvasElement {
    const d = this.drag!;
    const layer = d.layer!;
    let rect: Rect | null = null;
    if (d.kind === "stroke") {
      const r = d.stroke!.takeDirty();
      if (!r) return this.composite;
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      rect = { x, y, w: Math.min(this.doc.width, Math.ceil(r.x + r.w)) - x, h: Math.min(this.doc.height, Math.ceil(r.y + r.h)) - y };
      if (rect.w <= 0 || rect.h <= 0) return this.composite;
    }
    const clip = (g: CanvasRenderingContext2D) => {
      g.save();
      if (rect) {
        g.beginPath();
        g.rect(rect.x, rect.y, rect.w, rect.h);
        g.clip();
        g.clearRect(rect.x, rect.y, rect.w, rect.h);
      } else g.clearRect(0, 0, this.doc.width, this.doc.height);
    };
    const pg = ctx2d(this.preview);
    clip(pg);
    pg.drawImage(layer.canvas, 0, 0);
    if (d.kind === "stroke") {
      applyStroke(pg, this.strokeBuf, {
        opacity: this.brush.opacity,
        erase: !!d.erase,
        lockAlpha: layer.lockAlpha,
        selection: this.doc.selection,
        scratch: this.scratch,
        rect,
      });
    }
    pg.restore();
    const g = ctx2d(this.composite);
    clip(g);
    g.drawImage(this.below, 0, 0);
    g.restore();
    this.doc.compositeRoot(g, this.liveBase, this.doc.root.children.length, { override: { layer, image: this.preview }, rect });
    if (d.kind === "move") this.compositeDirty = true;
    return this.composite;
  }

  private prepareBelow(layer: Layer) {
    // layer を含む root 直下のノードを探し、それより下を合成してキャッシュする
    let top: Node = layer;
    for (let p = this.doc.parentOf(top); p && p !== this.doc.root; p = this.doc.parentOf(p)) top = p;
    const list = this.doc.root.children;
    this.liveBase = this.doc.clipBase(list, list.indexOf(top));
    const g = ctx2d(this.below);
    g.clearRect(0, 0, this.below.width, this.below.height);
    this.doc.compositeRoot(g, 0, this.liveBase);
  }

  // ------------------------------------------------------------ 入力

  private local(e: { clientX: number; clientY: number }) {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindInput() {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e, true));
    c.addEventListener("pointerleave", () => {
      this.cursor = null;
      this.requestRender();
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        if (e.ctrlKey || e.metaKey) {
          // トラックパッドのピンチ (Chrome) / Cmd+ホイール
          this.setZoom(this.view.zoom * Math.exp(-e.deltaY * 0.01), p);
        } else if (e.altKey) {
          this.setZoom(this.view.zoom * Math.exp(-e.deltaY * 0.002), p);
        } else {
          this.view.x -= e.deltaX;
          this.view.y -= e.deltaY;
          this.requestRender();
        }
      },
      { passive: false },
    );
    // Safari のピンチ
    let gestureZoom = 1;
    c.addEventListener("gesturestart", ((e: Event) => {
      e.preventDefault();
      gestureZoom = this.view.zoom;
    }) as EventListener);
    c.addEventListener("gesturechange", ((e: Event & { scale: number; clientX: number; clientY: number }) => {
      e.preventDefault();
      this.setZoom(gestureZoom * e.scale, this.local(e));
    }) as EventListener);

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTyping(e)) {
        this.spaceDown = true;
        c.dataset.pan = "1";
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this.spaceDown = false;
        delete c.dataset.pan;
      }
    });
  }

  private onDown(e: PointerEvent) {
    const p = this.local(e);
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 2) {
        // 2 本指: ピンチ・パン (描きかけのストロークは取り消し)
        if (this.drag?.kind === "stroke") this.cancelStroke();
        this.drag = null;
        const [a, b] = [...this.touches.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...this.view } };
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.drag) return;
    this.canvas.setPointerCapture(e.pointerId);
    const d = this.toDoc(p.x, p.y);
    const base = { start: d, sx: p.x, sy: p.y, pointerId: e.pointerId };

    if (this.spaceDown || this.tool === "hand" || e.button === 1) {
      this.drag = { ...base, kind: "pan", view: { ...this.view } };
      return;
    }
    if (e.button === 2) return;
    const tool = this.tool;
    if ((tool === "brush" || tool === "eraser") && e.altKey) {
      this.pickColor(d.x, d.y);
      return;
    }
    switch (tool) {
      case "brush":
      case "eraser":
        this.beginStroke(e, d, base);
        break;
      case "fill":
        this.fillAt(d.x, d.y);
        break;
      case "picker":
        this.pickColor(d.x, d.y);
        break;
      case "wand":
        this.wandAt(d.x, d.y);
        break;
      case "select-rect":
        this.drag = { ...base, kind: "rect", points: [d, d] };
        break;
      case "select-lasso":
        this.drag = { ...base, kind: "lasso", points: [d] };
        break;
      case "move": {
        const layer = this.editableLayer();
        if (!layer) return;
        const src = createCanvas(layer.canvas.width, layer.canvas.height);
        ctx2d(src).drawImage(layer.canvas, 0, 0);
        this.prepareBelow(layer);
        this.drag = { ...base, kind: "move", layer, moveSrc: src, snap: new PixelSnapshot(this.doc, layer) };
        break;
      }
    }
  }

  private editableLayer(): Layer | null {
    const layer = this.doc.active;
    if (!layer) {
      if (this.doc.activeNode?.kind === "group") toast("フォルダには直接描けません。中のレイヤーを選んでください");
      return null;
    }
    const lockedFolder = (() => {
      for (let p = this.doc.parentOf(layer); p && p !== this.doc.root; p = this.doc.parentOf(p)) if (p.locked) return true;
      return false;
    })();
    if (layer.locked || lockedFolder) {
      toast("レイヤーがロックされています");
      return null;
    }
    if (!this.doc.isVisible(layer)) {
      toast("非表示のレイヤーには描けません");
      return null;
    }
    return layer;
  }

  private pressureOf(e: PointerEvent) {
    if (e.pointerType === "mouse") return 1;
    return e.pressure > 0 ? Math.pow(e.pressure, this.pressureCurve) : 0.5;
  }

  private beginStroke(e: PointerEvent, d: { x: number; y: number }, base: { start: { x: number; y: number }; sx: number; sy: number; pointerId: number }) {
    const layer = this.editableLayer();
    if (!layer) return;
    const erase = this.tool === "eraser";
    const stroke = new Stroke(this.brush, erase ? "#000" : this.color, this.strokeBuf);
    const stab = new Stabilizer(this.brush.stabilizer);
    this.compositeImage(); // 部分更新の土台になる合成結果を最新にしておく
    this.prepareBelow(layer);
    const pr = this.pressureOf(e);
    this.drag = { ...base, kind: "stroke", layer, stroke, stab, erase, snap: new PixelSnapshot(this.doc, layer), raw: { ...d, pressure: pr } };
    if (e.shiftKey && this.lastStrokeEnd) {
      // Shift+クリックで直線
      stroke.add({ ...this.lastStrokeEnd, pressure: pr });
      stroke.add({ ...d, pressure: pr });
    } else {
      stroke.add(stab.push({ ...d, pressure: pr }));
    }
    if (!erase) this.setColor(this.color, true);
    this.requestRender();
  }

  private onMove(e: PointerEvent) {
    const p = this.local(e);
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p);
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.view = { ...this.pinch.view };
        this.view.x += mid.x - this.pinch.mid.x;
        this.view.y += mid.y - this.pinch.mid.y;
        this.setZoom(this.pinch.view.zoom * (dist / this.pinch.dist), mid);
        return;
      }
    }
    const d = this.toDoc(p.x, p.y);
    this.cursor = d;
    const drag = this.drag;
    if (!drag || drag.pointerId !== e.pointerId) {
      if (this.tool === "brush" || this.tool === "eraser") this.requestRender();
      return;
    }
    switch (drag.kind) {
      case "pan":
        this.view.x = drag.view!.x + p.x - drag.sx;
        this.view.y = drag.view!.y + p.y - drag.sy;
        break;
      case "stroke": {
        const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = this.local(ev);
          const dd = this.toDoc(q.x, q.y);
          drag.raw = { ...dd, pressure: this.pressureOf(ev) };
          drag.stroke!.add(drag.stab!.push(drag.raw));
        }
        break;
      }
      case "rect":
        drag.points![1] = d;
        break;
      case "lasso":
        drag.points!.push(d);
        break;
      case "move": {
        const layer = drag.layer!;
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.drawImage(drag.moveSrc!, Math.round(d.x - drag.start.x), Math.round(d.y - drag.start.y));
        break;
      }
    }
    this.requestRender();
  }

  private onUp(e: PointerEvent, cancelled = false) {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    }
    const drag = this.drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    this.drag = null;
    switch (drag.kind) {
      case "stroke":
        if (cancelled) {
          this.invalidate();
          break;
        }
        // 手ブレ補正で遅れている分を、ペンを離した位置まで追いつかせる
        if (drag.raw && this.brush.stabilizer > 0) drag.stroke!.add(drag.raw);
        drag.stroke!.finish();
        this.commitStroke(drag.layer!, drag.stroke!, drag.snap!, !!drag.erase);
        this.lastStrokeEnd = drag.raw ? { x: drag.raw.x, y: drag.raw.y } : this.cursor;
        break;
      case "rect": {
        const [a, b] = drag.points!;
        const x = Math.round(Math.min(a.x, b.x));
        const y = Math.round(Math.min(a.y, b.y));
        const w = Math.round(Math.abs(a.x - b.x));
        const h = Math.round(Math.abs(a.y - b.y));
        if (w < 2 || h < 2) this.deselect();
        else {
          const path = new Path2D();
          path.rect(x, y, w, h);
          this.selectPath(path);
        }
        break;
      }
      case "lasso":
        if (drag.points!.length < 3) this.deselect();
        else this.selectPath(this.dragPath(drag.points!)!);
        break;
      case "move": {
        const cmd = drag.snap!.commit("レイヤー移動");
        drag.layer!.touch();
        if (cmd) this.history.push(cmd);
        this.doc.emit("pixels");
        break;
      }
    }
    this.requestRender();
  }

  private cancelStroke() {
    this.drag = null;
    this.invalidate();
  }

  private commitStroke(layer: Layer, stroke: Stroke, snap: PixelSnapshot, erase: boolean) {
    applyStroke(layer.ctx, this.strokeBuf, {
      opacity: this.brush.opacity,
      erase,
      lockAlpha: layer.lockAlpha,
      selection: this.doc.selection,
      scratch: this.scratch,
    });
    layer.touch();
    const dirty = stroke.dirty;
    if (dirty) {
      const cmd = snap.commit(erase ? "消しゴム" : "ブラシ", dirty);
      if (cmd) this.history.push(cmd);
    }
    this.doc.emit("pixels");
  }

  private dragPath(points = this.drag?.points): Path2D | null {
    if (!points) return null;
    const path = new Path2D();
    if (this.drag?.kind === "rect" && points === this.drag.points) {
      const [a, b] = points;
      path.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      return path;
    }
    points.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();
    return path;
  }

  // ------------------------------------------------------------ ツール処理

  pickColor(x: number, y: number) {
    const img = this.compositeImage();
    const px = ctx2d(img).getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    if (px[3] === 0) return;
    const hex = "#" + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    this.setColor(hex, true);
  }

  private refPixels(): ImageData {
    const { width: w, height: h } = this.doc;
    const src = this.fill.allLayers || !this.doc.active ? this.compositeImage() : this.doc.active.canvas;
    return ctx2d(src).getImageData(0, 0, w, h);
  }

  fillAt(x: number, y: number) {
    const layer = this.editableLayer();
    if (!layer) return;
    const { width: w, height: h } = this.doc;
    let mask = floodFillMask(this.refPixels().data, w, h, x, y, this.fill.tolerance);
    if (this.fill.gap > 0) mask = dilateMask(mask, w, h, this.fill.gap);
    const m = maskToCanvas(mask, w, h);
    this.paintThroughMask(layer, m, this.color, "塗りつぶし");
  }

  /** mask (白 = 塗る) の範囲を color で塗る。選択範囲・透明ピクセル保護を考慮 */
  paintThroughMask(layer: Layer, mask: HTMLCanvasElement, color: string, label: string) {
    const snap = new PixelSnapshot(this.doc, layer);
    const tmp = createCanvas(this.doc.width, this.doc.height);
    const t = ctx2d(tmp);
    t.fillStyle = color;
    t.fillRect(0, 0, tmp.width, tmp.height);
    t.globalCompositeOperation = "destination-in";
    t.drawImage(mask, 0, 0);
    applyStroke(layer.ctx, tmp, { opacity: 1, erase: false, lockAlpha: layer.lockAlpha, selection: this.doc.selection, scratch: this.scratch });
    layer.touch();
    const cmd = snap.commit(label);
    if (cmd) this.history.push(cmd);
    this.setColor(color, true);
    this.doc.emit("pixels");
  }

  wandAt(x: number, y: number) {
    const { width: w, height: h } = this.doc;
    const mask = floodFillMask(this.refPixels().data, w, h, x, y, this.fill.tolerance);
    this.setSelectionMask(maskToCanvas(mask, w, h), null);
  }

  // ------------------------------------------------------------ 選択範囲

  private setSelectionMask(mask: HTMLCanvasElement | null, path: Path2D | null) {
    const before = { mask: this.doc.selection, path: this.doc.selectionPath };
    this.doc.setSelection(mask, path);
    this.history.push({
      label: "選択範囲",
      undo: () => this.doc.setSelection(before.mask, before.path),
      redo: () => this.doc.setSelection(mask, path),
    });
  }

  selectPath(path: Path2D) {
    const c = createCanvas(this.doc.width, this.doc.height);
    const g = ctx2d(c);
    g.fillStyle = "#fff";
    g.fill(path);
    this.setSelectionMask(c, path);
  }

  selectAll() {
    const path = new Path2D();
    path.rect(0, 0, this.doc.width, this.doc.height);
    this.selectPath(path);
  }

  deselect() {
    if (this.doc.selection) this.setSelectionMask(null, null);
  }

  invertSelection() {
    const sel = this.doc.selection;
    const c = createCanvas(this.doc.width, this.doc.height);
    const g = ctx2d(c);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    if (sel) {
      g.globalCompositeOperation = "destination-out";
      g.drawImage(sel, 0, 0);
    }
    this.setSelectionMask(c, null);
  }

  /** 選択範囲 (なければレイヤー全体) を消去 */
  clearSelected() {
    const layer = this.editableLayer();
    if (!layer) return;
    const snap = new PixelSnapshot(this.doc, layer);
    if (this.doc.selection) {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = "destination-out";
      layer.ctx.drawImage(this.doc.selection, 0, 0);
      layer.ctx.restore();
    } else {
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    }
    layer.touch();
    const cmd = snap.commit("消去");
    if (cmd) this.history.push(cmd);
    this.doc.emit("pixels");
  }

  /** 選択範囲 (なければレイヤー全体) を描画色で塗りつぶし */
  fillSelected() {
    const layer = this.editableLayer();
    if (!layer) return;
    const all = createCanvas(this.doc.width, this.doc.height);
    const g = ctx2d(all);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, all.width, all.height);
    this.paintThroughMask(layer, all, this.color, "塗りつぶし");
  }
}

let checkerPattern: CanvasPattern | null = null;
function checker(g: CanvasRenderingContext2D) {
  if (!checkerPattern) {
    const c = createCanvas(16, 16);
    const x = ctx2d(c);
    x.fillStyle = "#fff";
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = "#e3e3e3";
    x.fillRect(0, 0, 8, 8);
    x.fillRect(8, 8, 8, 8);
    checkerPattern = g.createPattern(c, "repeat");
  }
  return checkerPattern!;
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** 画面下部に短いメッセージを出す */
export function toast(message: string, kind: "info" | "error" | "ok" = "info", ms = 3200) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add("hide"), ms);
  setTimeout(() => el.remove(), ms + 400);
}
