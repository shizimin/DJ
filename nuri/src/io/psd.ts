// PSD の読み書き (CLIP STUDIO PAINT とレイヤーを保ったままやり取りするため)。

import { readPsd, writePsd, type BlendMode as PsdBlend, type Layer as PsdLayer, type Psd } from "ag-psd";
import { ctx2d, Doc, type BlendMode, type Layer } from "../core/doc";

const TO_PSD: Record<BlendMode, PsdBlend> = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color dodge",
  "color-burn": "color burn",
  add: "linear dodge",
  "hard-light": "hard light",
  "soft-light": "soft light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export function fromPsdBlend(b: PsdBlend | undefined): BlendMode {
  const found = (Object.entries(TO_PSD) as [BlendMode, PsdBlend][]).find(([, v]) => v === b);
  if (found) return found[0];
  if (b === "linear burn") return "multiply";
  if (b === "lighter color") return "lighten";
  if (b === "darker color") return "darken";
  if (b === "vivid light" || b === "linear light" || b === "pin light") return "hard-light";
  return "normal";
}

export function readPsdFile(buf: ArrayBuffer, name: string): Doc {
  const psd = readPsd(buf, { skipThumbnail: true });
  const doc = new Doc(psd.width, psd.height);
  doc.name = name.replace(/\.psd$/i, "");
  const walk = (children: PsdLayer[] | undefined, prefix: string, hidden: boolean, opacity: number) => {
    for (const child of children ?? []) {
      if (child.children) {
        // フォルダは展開して名前に階層を残す
        walk(child.children, `${prefix}${child.name ?? "フォルダ"}/`, hidden || !!child.hidden, opacity * (child.opacity ?? 1));
        continue;
      }
      const layer = doc.newLayer(`${prefix}${child.name ?? "レイヤー"}`);
      if (child.canvas) layer.ctx.drawImage(child.canvas, child.left ?? 0, child.top ?? 0);
      layer.visible = !hidden && !child.hidden;
      layer.opacity = opacity * (child.opacity ?? 1);
      layer.blend = fromPsdBlend(child.blendMode);
      layer.clip = !!child.clipping;
      layer.lockAlpha = !!child.transparencyProtected;
      doc.layers.push(layer);
    }
  };
  walk(psd.children, "", false, 1);
  if (!doc.layers.length && psd.canvas) {
    const layer = doc.newLayer("背景");
    layer.ctx.drawImage(psd.canvas, 0, 0);
    doc.layers.push(layer);
  }
  doc.activeId = doc.layers[doc.layers.length - 1]?.id ?? 0;
  return doc;
}

export function writePsdFile(doc: Doc): ArrayBuffer {
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    canvas: doc.flatten(),
    children: doc.layers.map((l: Layer) => ({
      name: l.name,
      canvas: l.canvas,
      left: 0,
      top: 0,
      opacity: l.opacity,
      hidden: !l.visible,
      blendMode: TO_PSD[l.blend],
      clipping: l.clip,
      transparencyProtected: l.lockAlpha,
    })),
  };
  return writePsd(psd, { generateThumbnail: true, noBackground: true });
}

/** 画像ファイル (PNG/JPEG/WebP) からドキュメントを作る */
export async function imageToDoc(file: Blob, name: string): Promise<Doc> {
  const bmp = await createImageBitmap(file);
  const doc = new Doc(bmp.width, bmp.height);
  doc.name = name.replace(/\.[^.]+$/, "");
  const layer = doc.newLayer(doc.name);
  ctx2d(layer.canvas).drawImage(bmp, 0, 0);
  bmp.close();
  doc.layers.push(layer);
  doc.activeId = layer.id;
  return doc;
}
