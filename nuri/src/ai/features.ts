// AI 機能: 背景生成・写真の線画化・選択範囲の描き直し。
// 結果は常に「新しいレイヤー」として追加するので、元の絵は壊れない (取り消しも可能)。

import { createCanvas, ctx2d, type Doc, type Layer } from "../core/doc";
import type { Editor } from "../core/editor";
import { addLayerCommand } from "../core/history";
import {
  alphaBounds,
  coverRect,
  inkToRgba,
  lumaToAlpha,
  nearestAspect,
  xdogLineArt,
  type LineArtOptions,
  type Rect,
} from "../image/pixels";
import { generate, GEMINI_ASPECTS, modelOf, OPENAI_SIZES, PROVIDER_LABEL, type AiSettings, type GenInput } from "./providers";

// ---------------------------------------------------------------- 画像ヘルパー

export function canvasToBlob(c: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("画像の変換に失敗しました"))), type));
}

export async function blobToCanvas(b: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b);
  const c = createCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

export function scaleDown(src: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const s = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (s >= 1) return src;
  const c = createCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  const g = ctx2d(c);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function crop(src: CanvasImageSource, r: Rect, background?: string): HTMLCanvasElement {
  const c = createCanvas(Math.round(r.w), Math.round(r.h));
  const g = ctx2d(c);
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, c.width, c.height);
  }
  g.drawImage(src, -r.x, -r.y);
  return c;
}

function layerBounds(layer: Layer): Rect | null {
  const { width: w, height: h } = layer.canvas;
  return alphaBounds(layer.ctx.getImageData(0, 0, w, h).data, w, h, 8);
}

// ---------------------------------------------------------------- ジョブ管理

export interface Job {
  id: number;
  title: string;
  provider: string;
  status: "running" | "done" | "error" | "cancelled";
  message?: string;
  started: number;
  controller: AbortController;
}

type JobListener = (jobs: Job[]) => void;

export class AiJobs {
  jobs: Job[] = [];
  private seq = 1;
  private listeners = new Set<JobListener>();

  constructor(
    private editor: Editor,
    public settings: () => AiSettings,
  ) {}

  onChange(fn: JobListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.jobs);
  }

  cancel(id: number) {
    const j = this.jobs.find((x) => x.id === id);
    if (j && j.status === "running") {
      j.controller.abort();
      j.status = "cancelled";
      this.emit();
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === "running");
    this.emit();
  }

  /** AI を呼んで、結果をレイヤーとして追加する共通処理 */
  private async run(title: string, input: GenInput, place: (doc: Doc, result: HTMLCanvasElement) => void) {
    const s = this.settings();
    const job: Job = {
      id: this.seq++,
      title,
      provider: `${PROVIDER_LABEL[s.provider]} (${modelOf(s)})`,
      status: "running",
      started: Date.now(),
      controller: new AbortController(),
    };
    this.jobs.unshift(job);
    this.emit();
    const doc = this.editor.doc;
    try {
      const out = await generate(s, input, job.controller.signal);
      if (job.status === "cancelled") return;
      if (this.editor.doc !== doc) throw new Error("生成中にドキュメントが切り替わったため破棄しました");
      const result = await blobToCanvas(out.images[0]);
      place(doc, result);
      job.status = "done";
      job.message = `${((Date.now() - job.started) / 1000).toFixed(0)} 秒${out.text ? ` — ${out.text.slice(0, 120)}` : ""}`;
    } catch (e) {
      if (job.status === "cancelled") return;
      job.status = "error";
      job.message = (e as Error).name === "AbortError" ? "キャンセルしました" : (e as Error).message;
    }
    this.emit();
  }

  private upload(c: HTMLCanvasElement) {
    return canvasToBlob(scaleDown(c, this.settings().maxUpload));
  }

  private sizeHints(w: number, h: number): Pick<GenInput, "aspect" | "size"> {
    return { aspect: nearestAspect(w, h, GEMINI_ASPECTS), size: nearestAspect(w, h, OPENAI_SIZES) };
  }

  // ------------------------------------------------------------ 背景生成

  async background(opts: { description: string; style: string; mode: "behind" | "only" }) {
    const doc = this.editor.doc;
    const style = opts.style ? ` Art style: ${opts.style}.` : "";
    let input: GenInput;
    if (opts.mode === "behind") {
      const src = doc.flatten({ background: "#ffffff" });
      input = {
        prompt:
          `Add a complete, detailed background to this illustration. Background: ${opts.description || "a fitting scene"}.${style}\n` +
          "Keep the character(s) and every foreground element exactly as they are — same pose, line art, colors, size and position. " +
          "Match the illustration's style, perspective, horizon line and lighting, and fill the entire canvas edge to edge.",
        images: [await this.upload(src)],
        ...this.sizeHints(doc.width, doc.height),
      };
    } else {
      input = {
        prompt:
          `A background illustration with no people or characters: ${opts.description || "a scenic landscape"}.${style} ` +
          "Composition suitable as the background layer of a drawing, with room in the foreground for characters. No text.",
        images: [],
        ...this.sizeHints(doc.width, doc.height),
      };
    }
    await this.run(`背景生成: ${opts.description || "おまかせ"}`, input, (d, result) => {
      const layer = d.newLayer(`AI背景 ${opts.description}`.trim().slice(0, 40));
      const r = coverRect(result.width, result.height, d.width, d.height);
      layer.ctx.imageSmoothingQuality = "high";
      layer.ctx.drawImage(result, r.x, r.y, r.w, r.h);
      // 用紙レイヤーの直上 (キャラクターより下) に置く
      const paper = d.root.children.findIndex((l) => l.kind === "layer" && l.paper);
      this.editor.history.run(addLayerCommand(d, layer, paper + 1, d.root));
    });
  }

  // ------------------------------------------------------------ 写真の線画化

  lineArtPrompt(o: { weight: string; detail: string; style: string }) {
    const weight = { thin: "thin, delicate", medium: "medium", bold: "bold, confident" }[o.weight] ?? "medium";
    const detail =
      { simple: "only the main contours and important shapes; omit textures and small details", normal: "main contours plus the important interior lines", detailed: "detailed, including textures, folds and small objects" }[o.detail] ??
      "main contours plus the important interior lines";
    const style =
      { manga: "clean manga / anime inking", background: "precise background line drawing for manga (architecture and objects, straight lines kept straight)", sketch: "loose pencil sketch" }[o.style] ??
      "clean manga / anime inking";
    return (
      `Convert this photo into line art. Style: ${style}. Line weight: ${weight}. Level of detail: ${detail}.\n` +
      "Output ONLY black lines on a pure white background: no shading, no gray fills, no color, no screentone, no text or signature. " +
      "Keep exactly the same composition, framing, proportions and perspective as the photo so the lines align when overlaid on it."
    );
  }

  /** AI で写真を線画にし、source レイヤーの上に「線画」レイヤーを追加 */
  async lineArtAI(source: Layer, o: { weight: string; detail: string; style: string; color: string; extra: string }) {
    const bounds = layerBounds(source);
    if (!bounds) throw new Error("レイヤーが空です");
    const src = crop(source.canvas, bounds, "#ffffff");
    const prompt = this.lineArtPrompt(o) + (o.extra ? `\nAdditional instructions: ${o.extra}` : "");
    await this.run("写真の線画化 (AI)", { prompt, images: [await this.upload(src)], ...this.sizeHints(bounds.w, bounds.h) }, (d, result) =>
      this.placeLineArt(d, source, bounds, result, o.color, "線画 (AI)"),
    );
  }

  private placeLineArt(d: Doc, source: Layer, bounds: Rect, result: HTMLCanvasElement, color: string, name: string) {
    // 元の範囲にぴったり合わせる (AI は同じ縦横比で返すので単純に伸縮)
    const fitted = createCanvas(Math.round(bounds.w), Math.round(bounds.h));
    const fg = ctx2d(fitted);
    fg.imageSmoothingQuality = "high";
    fg.drawImage(result, 0, 0, fitted.width, fitted.height);
    const img = fg.getImageData(0, 0, fitted.width, fitted.height);
    img.data.set(lumaToAlpha(img.data, hexToRgb(color)));
    fg.putImageData(img, 0, 0);
    const layer = d.newLayer(name);
    layer.ctx.drawImage(fitted, bounds.x, bounds.y);
    // 写真レイヤーのすぐ上 (同じフォルダ内) に置く
    const parent = d.parentOf(source);
    this.editor.history.run(parent ? addLayerCommand(d, layer, parent.children.indexOf(source) + 1, parent) : addLayerCommand(d, layer));
  }

  // ------------------------------------------------------------ 選択範囲の描き直し

  async redraw(opts: { instruction: string }) {
    const doc = this.editor.doc;
    const sel = doc.selection;
    const src = doc.flatten({ background: "#ffffff" });
    const small = scaleDown(src, this.settings().maxUpload);
    const input: GenInput = {
      prompt:
        `${opts.instruction}\nKeep the illustration's style, line art and colors consistent. ` +
        (sel ? "Change only the masked region." : "Keep the composition."),
      images: [await canvasToBlob(small)],
      ...this.sizeHints(doc.width, doc.height),
    };
    if (sel) {
      const scaled = scaleDown(sel, this.settings().maxUpload);
      const w = small.width;
      const h = small.height;
      // OpenAI: 編集部分を透明に
      const om = createCanvas(w, h);
      const og = ctx2d(om);
      og.fillStyle = "#000";
      og.fillRect(0, 0, w, h);
      og.globalCompositeOperation = "destination-out";
      og.drawImage(scaled, 0, 0, w, h);
      // Gemini: 白背景・編集部分が黒
      const gm = createCanvas(w, h);
      const gg = ctx2d(gm);
      gg.fillStyle = "#fff";
      gg.fillRect(0, 0, w, h);
      const black = createCanvas(w, h);
      const bg = ctx2d(black);
      bg.drawImage(scaled, 0, 0, w, h);
      bg.globalCompositeOperation = "source-in";
      bg.fillStyle = "#000";
      bg.fillRect(0, 0, w, h);
      gg.drawImage(black, 0, 0);
      input.openaiMask = await canvasToBlob(om);
      input.geminiMask = await canvasToBlob(gm);
      input.size = "auto"; // マスク編集は元画像と同じサイズで
    }
    const selSnapshot = sel ? crop(sel, { x: 0, y: 0, w: sel.width, h: sel.height }) : null;
    await this.run(`描き直し: ${opts.instruction.slice(0, 30)}`, input, (d, result) => {
      const layer = d.newLayer(`AI描き直し ${opts.instruction}`.slice(0, 40));
      layer.ctx.imageSmoothingQuality = "high";
      layer.ctx.drawImage(result, 0, 0, d.width, d.height);
      if (selSnapshot) {
        // 選択範囲の外は元の絵のまま残す
        layer.ctx.globalCompositeOperation = "destination-in";
        layer.ctx.drawImage(selSnapshot, 0, 0);
        layer.ctx.globalCompositeOperation = "source-over";
      }
      this.editor.history.run(addLayerCommand(d, layer, d.root.children.length, d.root));
    });
  }
}

// ---------------------------------------------------------------- ローカル線画化 (AI 不使用)

/** DoG フィルタで線画を作る (無料・オフライン)。source の上に新規レイヤーを返す */
export function localLineArt(doc: Doc, source: Layer, opts: LineArtOptions, color: string): Layer | null {
  const bounds = layerBounds(source);
  if (!bounds) return null;
  const pad = 4;
  const r = {
    x: Math.max(0, bounds.x - pad),
    y: Math.max(0, bounds.y - pad),
    w: Math.min(doc.width, bounds.x + bounds.w + pad) - Math.max(0, bounds.x - pad),
    h: Math.min(doc.height, bounds.y + bounds.h + pad) - Math.max(0, bounds.y - pad),
  };
  const src = crop(source.canvas, r, "#ffffff");
  const data = ctx2d(src).getImageData(0, 0, src.width, src.height);
  const ink = xdogLineArt(data.data, src.width, src.height, opts);
  const out = new ImageData(inkToRgba(ink, hexToRgb(color)) as Uint8ClampedArray<ArrayBuffer>, src.width, src.height);
  const layer = doc.newLayer("線画 (ローカル)");
  layer.ctx.putImageData(out, r.x, r.y);
  return layer;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}
