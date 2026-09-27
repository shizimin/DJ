// ファイルを開く / 取り込む (PSD・CLIP・画像・.sut ブラシ・素材 .layer)。

import type { Brush } from "../core/brush";
import { createCanvas, ctx2d, Doc, type Layer } from "../core/doc";
import { toast, type Editor } from "../core/editor";
import { addLayerCommand } from "../core/history";
import { decodeC2F, isC2F } from "./c2f";
import { isClip, parseClip, type ClipFile } from "./clip";
import { newId, putAsset, type Asset } from "./library";
import { readPsdFile } from "./psd";
import { parseSut } from "./sut";

export interface OpenContext {
  editor: Editor;
  confirmDiscard: () => boolean;
  onBrushes: () => void;
  assets: { refresh: () => void };
}

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

export async function openFiles(files: File[], ctx: OpenContext) {
  for (const file of files) {
    const e = ext(file.name);
    if (e === "sut" || e === "sutg") {
      await importBrushes(file, ctx);
    } else if (e === "layer") {
      await importMaterial(file, file.name.replace(/\.layer$/i, ""), "CLIP STUDIO 素材");
      ctx.assets.refresh();
      toast(`素材「${file.name}」を追加しました (素材タブ)`, "ok");
    } else if (e === "clip") {
      if (!ctx.confirmDiscard()) return;
      const doc = await clipToDoc(new Uint8Array(await file.arrayBuffer()), file.name);
      ctx.editor.setDocument(doc);
    } else if (e === "psd") {
      if (!ctx.confirmDiscard()) return;
      ctx.editor.setDocument(readPsdFile(await file.arrayBuffer(), file.name));
      toast(`${file.name} を開きました`, "ok");
    } else if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e)) {
      await addImageLayer(ctx.editor, file, file.name);
    } else {
      toast(`${file.name}: 対応していない形式です`, "error");
    }
  }
}

/** 画像を新規レイヤーとして追加 (キャンバスより大きければ縮小して中央に配置) */
export async function addImageLayer(editor: Editor, image: Blob, name: string) {
  const bmp = await createImageBitmap(image);
  const doc = editor.doc;
  const layer = doc.newLayer(name.replace(/\.[^.]+$/, "").slice(0, 40));
  const s = Math.min(1, doc.width / bmp.width, doc.height / bmp.height);
  const w = bmp.width * s;
  const h = bmp.height * s;
  layer.ctx.imageSmoothingQuality = "high";
  layer.ctx.drawImage(bmp, Math.round((doc.width - w) / 2), Math.round((doc.height - h) / 2), w, h);
  bmp.close();
  editor.history.run(addLayerCommand(doc, layer));
  return layer;
}

// ---------------------------------------------------------------- .clip

export async function clipToDoc(bytes: Uint8Array, name: string): Promise<Doc> {
  if (!isClip(bytes)) throw new Error(".clip ファイルではありません");
  toast(`${name} を読み込んでいます…`);
  const clip = await parseClip(bytes);
  const doc = buildDoc(clip);
  doc.name = name.replace(/\.clip$/i, "");
  const notes: string[] = [];
  if (clip.skipped.length) notes.push(`${clip.skipped.length} 枚のレイヤー (色調補正・ベクター・テキスト等) は画像として読めなかったため省略`);
  toast(`${name} を開きました (${doc.layers.length} レイヤー)${notes.length ? `\n${notes.join("\n")}` : ""}`, "ok", 6000);
  return doc;
}

function buildDoc(clip: ClipFile): Doc {
  const doc = new Doc(clip.width, clip.height);
  for (const cl of clip.layers) {
    const bmp = cl.load();
    if (!bmp) continue;
    const layer: Layer = doc.newLayer(`${cl.path}${cl.name}`);
    layer.ctx.putImageData(new ImageData(bmp.rgba as Uint8ClampedArray<ArrayBuffer>, bmp.width, bmp.height), bmp.x, bmp.y);
    Object.assign(layer, {
      visible: cl.visible,
      opacity: cl.opacity,
      blend: cl.blend,
      clip: cl.clip,
      lockAlpha: cl.lockAlpha,
      locked: cl.locked,
      paper: cl.paper,
    });
    doc.layers.push(layer);
  }
  if (!doc.layers.length) throw new Error("読み込めるレイヤーがありませんでした");
  // クリッピングの土台がない一番下のレイヤーは解除
  if (doc.layers[0].clip) doc.layers[0].clip = false;
  doc.activeId = doc.layers[doc.layers.length - 1].id;
  return doc;
}

/** .clip の中身を 1 枚の画像素材として登録 (プレビュー PNG を利用) */
export async function clipToAsset(bytes: Uint8Array, name: string) {
  const clip = await parseClip(bytes);
  let blob: Blob;
  if (clip.preview) blob = new Blob([clip.preview as Uint8Array<ArrayBuffer>], { type: "image/png" });
  else {
    const doc = buildDoc(clip);
    blob = await new Promise<Blob>((r) => doc.flatten().toBlob((b) => r(b!), "image/png"));
  }
  const asset: Asset = { id: newId(), name, kind: "clip", blob, source: "CLIP", added: Date.now() };
  await putAsset(asset);
  return asset;
}

// ---------------------------------------------------------------- .sut ブラシ

function tipCanvas(tip: { width: number; height: number; alpha: Uint8Array }) {
  // 大きすぎる先端は縮小 (スタンプ描画の負荷を抑える)
  const c = createCanvas(tip.width, tip.height);
  const g = ctx2d(c);
  const img = g.createImageData(tip.width, tip.height);
  for (let i = 0; i < tip.alpha.length; i++) {
    const p = i * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
    img.data[p + 3] = tip.alpha[i];
  }
  g.putImageData(img, 0, 0);
  const max = 256;
  if (Math.max(tip.width, tip.height) <= max) return c;
  const s = max / Math.max(tip.width, tip.height);
  const small = createCanvas(Math.max(1, Math.round(tip.width * s)), Math.max(1, Math.round(tip.height * s)));
  const sg = ctx2d(small);
  sg.imageSmoothingQuality = "high";
  sg.drawImage(c, 0, 0, small.width, small.height);
  return small;
}

export async function importBrushes(file: File, ctx: OpenContext) {
  const list = await parseSut(new Uint8Array(await file.arrayBuffer()));
  if (!list.length) throw new Error("ブラシが見つかりませんでした");
  const { editor } = ctx;
  let added = 0;
  for (const sb of list) {
    const brush: Brush = {
      id: `sut-${newId()}`,
      name: sb.name,
      size: sb.size,
      opacity: sb.opacity,
      flow: sb.flow,
      hardness: sb.hardness,
      spacing: sb.spacing,
      pressureSize: sb.pressureSize,
      pressureOpacity: sb.pressureOpacity,
      minSize: sb.minSize,
      stabilizer: sb.stabilizer,
      source: file.name,
    };
    if (sb.tip) {
      const canvas = tipCanvas(sb.tip);
      brush.tip = { canvas, dataUrl: canvas.toDataURL("image/png") };
    }
    if (sb.eraser) {
      editor.erasers.push(brush);
    } else {
      editor.brushes.push(brush);
      editor.brushIndex = editor.brushes.length - 1;
    }
    added++;
  }
  editor.setTool(list.every((b) => b.eraser) ? "eraser" : "brush");
  ctx.onBrushes();
  toast(`ブラシを ${added} 個読み込みました: ${list.map((b) => b.name).join("、")}`, "ok");
}

// ---------------------------------------------------------------- 素材 (.layer)

function grayToCanvas(w: number, h: number, gray: Uint8Array) {
  // 単色素材 (トーン・ブラシ先端・テクスチャ): 濃さを黒のアルファとして使う
  const c = createCanvas(w, h);
  const g = ctx2d(c);
  const img = g.createImageData(w, h);
  let max = 1;
  for (const v of gray) if (v > max) max = v;
  for (let i = 0; i < gray.length; i++) img.data[i * 4 + 3] = Math.round((gray[i] / max) * 255);
  g.putImageData(img, 0, 0);
  return c;
}

export async function materialToBlob(bytes: Uint8Array): Promise<Blob> {
  if (!isC2F(bytes)) throw new Error("CLIP STUDIO の素材ファイルではありません");
  const img = decodeC2F(bytes);
  if (img.png) return new Blob([img.png as Uint8Array<ArrayBuffer>], { type: "image/png" });
  let c: HTMLCanvasElement;
  if (img.rgba) {
    c = createCanvas(img.width, img.height);
    ctx2d(c).putImageData(new ImageData(img.rgba as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  } else c = grayToCanvas(img.width, img.height, img.gray!);
  return new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error("変換に失敗しました"))), "image/png"));
}

export async function importMaterial(file: Blob, name: string, source: string) {
  const blob = await materialToBlob(new Uint8Array(await file.arrayBuffer()));
  const asset: Asset = { id: newId(), name, kind: "image", blob, source, added: Date.now() };
  await putAsset(asset);
  return asset;
}

/**
 * CLIP STUDIO の素材フォルダ (フォルダ選択) を取り込む。
 * 各素材パッケージの catalog.xml から名前を取り、data/*.layer を画像にする。
 */
export async function importMaterialFolder(files: File[], onProgress: (done: number, total: number) => void) {
  const byDir = new Map<string, { layers: File[]; catalog?: File }>();
  for (const f of files) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = path.split("/");
    const lower = f.name.toLowerCase();
    // 素材パッケージのフォルダ = data/ の 1 つ上
    const dataIdx = parts.lastIndexOf("data");
    if (lower.endsWith(".layer") && dataIdx > 0) {
      const dir = parts.slice(0, dataIdx).join("/");
      const e = byDir.get(dir) ?? { layers: [] };
      e.layers.push(f);
      byDir.set(dir, e);
    } else if (lower === "catalog.xml") {
      const dir = parts.slice(0, -1).join("/");
      const e = byDir.get(dir) ?? { layers: [] };
      e.catalog = f;
      byDir.set(dir, e);
    }
  }
  const entries = [...byDir.entries()].filter(([, e]) => e.layers.length);
  let done = 0;
  let ok = 0;
  const failed: string[] = [];
  for (const [dir, e] of entries) {
    let name = dir.split("/").pop() ?? "素材";
    if (e.catalog) {
      const m = /<name>([^<]+)<\/name>/.exec(await e.catalog.text());
      if (m) name = m[1].trim();
    }
    for (const [i, f] of e.layers.entries()) {
      try {
        await importMaterial(f, e.layers.length > 1 ? `${name} ${i + 1}` : name, "CLIP STUDIO 素材フォルダ");
        ok++;
      } catch {
        failed.push(name);
      }
    }
    onProgress(++done, entries.length);
  }
  return { ok, failed, packages: entries.length };
}
