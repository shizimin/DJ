// CLIP STUDIO PAINT のブラシ (.sut / .sutg) の読み込み。
// .sut は SQLite で、Node (ブラシ名) と Variant (設定値) のテーブルを持つ。
// ブラシ先端の画像は MaterialFile.FileData (tar) の中の素材 .layer (C2F) に入っている。

import { decodeC2F } from "./c2f";
import { blob, getSql, num, rows, str, tableExists, type Row } from "./sqlite";
import { readTar } from "./tar";

export interface SutBrush {
  name: string;
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  minSize: number;
  stabilizer: number;
  eraser: boolean;
  /** 先端画像 (濃さ 0..255)。円形ブラシは null */
  tip: { width: number; height: number; alpha: Uint8Array } | null;
}

interface Effector {
  pressure: boolean;
  min: number;
}

/** *Effector 列 (筆圧などの影響元設定) の解読 */
export function readEffector(v: unknown): Effector {
  const b = v instanceof Uint8Array ? v : null;
  if (!b || b.length < 16) return { pressure: false, min: 0 };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = dv.getUint32(8, false);
  const min = dv.getUint32(12, false);
  return { pressure: (flags & 0x10) !== 0, min: Math.min(100, min) / 100 };
}

interface Material {
  kind: "tip" | "texture" | "unknown";
  image: { width: number; height: number; alpha: Uint8Array } | null;
}

function readMaterial(fileData: Uint8Array): Material {
  const files = readTar(fileData);
  let kind: Material["kind"] = "unknown";
  for (const [name, data] of files) {
    if (name.endsWith("layerData.xml")) {
      const xml = new TextDecoder().decode(data);
      if (xml.includes("BrushPattern")) kind = "tip";
      else if (xml.includes("PaperTexture")) kind = "texture";
    }
  }
  const layerFile = [...files.entries()].find(([n]) => /data\/.*\.layer$/.test(n))?.[1];
  if (!layerFile) return { kind, image: null };
  try {
    const img = decodeC2F(layerFile);
    if (img.gray) {
      // 最大値で正規化 (やわらかい先端は最大 95 程度で保存されていることがある)
      let max = 1;
      for (const v of img.gray) if (v > max) max = v;
      const alpha = new Uint8Array(img.gray.length);
      for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round((img.gray[i] / max) * 255);
      return { kind, image: { width: img.width, height: img.height, alpha } };
    }
    if (img.rgba) {
      // カラー素材: 暗さ × 不透明度を濃さとする
      const alpha = new Uint8Array(img.width * img.height);
      for (let i = 0; i < alpha.length; i++) {
        const p = i * 4;
        const l = 0.299 * img.rgba[p] + 0.587 * img.rgba[p + 1] + 0.114 * img.rgba[p + 2];
        alpha[i] = Math.round(((255 - l) / 255) * img.rgba[p + 3]);
      }
      return { kind, image: { width: img.width, height: img.height, alpha } };
    }
  } catch (e) {
    console.warn("ブラシ先端を読み込めませんでした", e);
  }
  return { kind, image: null };
}

function toBrush(name: string, v: Row, tip: SutBrush["tip"]): SutBrush {
  const size = readEffector(v.BrushSizeEffector);
  const opacity = readEffector(v.BrushOpacityEffector);
  const flow = readEffector(v.BrushFlowEffector);
  let px = num(v.BrushSize, 10);
  if (num(v.BrushSizeUnit) === 2) px *= 10;
  const autoInterval = num(v.BrushAutoIntervalType);
  return {
    name,
    size: Math.max(1, Math.min(500, Math.round(px))),
    opacity: Math.max(0.01, Math.min(1, num(v.Opacity, 100) / 100)),
    flow: Math.max(0.01, Math.min(1, num(v.BrushFlow, 100) / 100)),
    hardness: Math.max(0, Math.min(1, num(v.BrushHardness, 100) / 100)),
    spacing: autoInterval === 0 ? Math.max(0.02, Math.min(2, num(v.BrushInterval, 10) / 100)) : tip ? 0.15 : 0.08,
    pressureSize: size.pressure,
    pressureOpacity: opacity.pressure || flow.pressure,
    minSize: size.pressure ? size.min : 1,
    stabilizer: Math.min(20, Math.round(num(v.BrushRevision) / 2)),
    eraser: num(v.CompositeMode) === 18,
    tip,
  };
}

export async function parseSut(bytes: Uint8Array): Promise<SutBrush[]> {
  const SQL = await getSql();
  const db = new SQL.Database(bytes);
  try {
    if (!tableExists(db, "Node") || !tableExists(db, "Variant")) throw new Error("ブラシファイル (.sut) ではありません");
    const nodes = rows(db, "SELECT n.NodeName AS __name, v.* FROM Node n JOIN Variant v ON v.VariantID = n.NodeVariantID WHERE n.NodeVariantID <> 0");
    const materials = tableExists(db, "MaterialFile")
      ? rows(db, "SELECT FileData FROM MaterialFile ORDER BY _PW_ID").map((m) => {
          const data = blob(m.FileData);
          return data ? readMaterial(data) : { kind: "unknown" as const, image: null };
        })
      : [];
    // 素材参照と MaterialFile の行は対応が取れないことがあるため、先端素材を使用順に割り当てる
    const tips = materials.filter((m) => m.kind !== "texture" && m.image);
    let next = 0;
    return nodes.map((v) => {
      const usesTip = num(v.BrushUsePatternImage) === 1 && next < tips.length;
      const tip = usesTip ? tips[next++].image : null;
      return toBrush(str(v.__name) || "ブラシ", v, tip);
    });
  } finally {
    db.close();
  }
}
