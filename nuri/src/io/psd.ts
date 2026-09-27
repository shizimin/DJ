// PSD の読み書き (CLIP STUDIO PAINT とレイヤーを保ったままやり取りするため)。

import { readPsd, writePsd, type BlendMode as PsdBlend, type Layer as PsdLayer, type Psd } from "ag-psd";
import { Doc, Group, type BlendMode, type Node } from "../core/doc";

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
  const walk = (children: PsdLayer[] | undefined, into: Group) => {
    for (const child of children ?? []) {
      if (child.children) {
        const g = new Group(child.name ?? "フォルダ");
        g.visible = !child.hidden;
        g.opacity = child.opacity ?? 1;
        g.blend = child.blendMode === "pass through" || !child.blendMode ? "pass-through" : fromPsdBlend(child.blendMode);
        g.open = child.opened ?? true;
        walk(child.children, g);
        into.children.push(g);
        continue;
      }
      const layer = doc.newLayer(child.name ?? "レイヤー");
      if (child.canvas) layer.ctx.drawImage(child.canvas, child.left ?? 0, child.top ?? 0);
      layer.visible = !child.hidden;
      layer.opacity = child.opacity ?? 1;
      layer.blend = fromPsdBlend(child.blendMode);
      layer.clip = !!child.clipping;
      layer.lockAlpha = !!child.transparencyProtected;
      into.children.push(layer);
    }
  };
  walk(psd.children, doc.root);
  if (!doc.layers.length && psd.canvas) {
    const layer = doc.newLayer("背景");
    layer.ctx.drawImage(psd.canvas, 0, 0);
    doc.root.children.push(layer);
  }
  doc.activeId = doc.layers[doc.layers.length - 1]?.id ?? 0;
  return doc;
}

function toPsdNode(n: Node): PsdLayer {
  if (n.kind === "group") {
    return {
      name: n.name,
      opened: n.open,
      opacity: n.opacity,
      hidden: !n.visible,
      blendMode: n.blend === "pass-through" ? "pass through" : TO_PSD[n.blend],
      children: n.children.map(toPsdNode),
    };
  }
  return {
    name: n.name,
    canvas: n.canvas,
    left: 0,
    top: 0,
    opacity: n.opacity,
    hidden: !n.visible,
    blendMode: TO_PSD[n.blend],
    clipping: n.clip,
    transparencyProtected: n.lockAlpha,
  };
}

export function writePsdFile(doc: Doc): ArrayBuffer {
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    canvas: doc.flatten(),
    children: doc.root.children.map(toPsdNode),
  };
  return writePsd(psd, { generateThumbnail: true, noBackground: true });
}
