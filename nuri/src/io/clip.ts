// .clip (CLIP STUDIO PAINT のファイル) の読み込み。
// 構造: "CSFCHUNK" ヘッダー + チャンク列 (Head / Exta × n / SQLi / Foot)。
// SQLi は SQLite データベースそのもので、レイヤー情報が入っている。
// Exta はラスターデータ (256×256 タイルの zlib 圧縮) で、Offscreen.BlockData の ID から参照される。

import type { Database } from "sql.js";
import type { BlendMode } from "../core/doc";
import { decodeOffscreen, Reader } from "./csp-blocks";
import { blob, getSql, num, rows, str, tableExists, type Row } from "./sqlite";

export interface ClipLayer {
  kind: "layer";
  name: string;
  /** フォルダ階層 ("フォルダ1/フォルダ2/") */
  path: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  clip: boolean;
  lockAlpha: boolean;
  locked: boolean;
  paper: boolean;
  /** 塗りつぶしレイヤー・用紙の色 */
  fill: [number, number, number] | null;
  /** ピクセルを解読する (x, y はキャンバス上の左上位置)。メモリ節約のため 1 枚ずつ呼ぶ */
  load(): ClipBitmap | null;
}

export interface ClipFolder {
  kind: "folder";
  name: string;
  visible: boolean;
  opacity: number;
  /** "pass-through" = 通過 */
  blend: BlendMode | "pass-through";
  clip: boolean;
  open: boolean;
  children: ClipNode[];
}

export type ClipNode = ClipLayer | ClipFolder;

export interface ClipBitmap {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface ClipFile {
  width: number;
  height: number;
  dpi: number;
  /** レイヤーツリー (各リストは下 → 上) */
  tree: ClipNode[];
  /** 全ラスターレイヤー (下 → 上) */
  layers: ClipLayer[];
  /** キャンバス全体のプレビュー PNG */
  preview: Uint8Array | null;
  /** 読み込めなかったレイヤー名 */
  skipped: string[];
}

/** LayerComposite → 合成モード (近いものに置き換え) */
const CLIP_BLEND: Record<number, BlendMode> = {
  0: "normal",
  1: "darken",
  2: "multiply",
  3: "color-burn",
  4: "multiply", // 焼き込み(リニア)
  5: "difference", // 減算 (近似)
  6: "darken", // カラー比較(暗)
  7: "lighten",
  8: "screen",
  9: "color-dodge",
  10: "color-dodge", // 覆い焼き(発光)
  11: "add",
  12: "add", // 加算(発光)
  13: "lighten", // カラー比較(明)
  14: "overlay",
  15: "soft-light",
  16: "hard-light",
  17: "hard-light", // ビビッドライト
  18: "hard-light", // リニアライト
  19: "hard-light", // ピンライト
  20: "hard-light", // ハードミックス
  21: "difference",
  22: "exclusion",
  23: "hue",
  24: "saturation",
  25: "color",
  26: "luminosity",
  30: "normal", // 通過 (フォルダ)
  36: "color-dodge", // 除算
};

export function isClip(bytes: Uint8Array) {
  return bytes.length > 24 && new Reader(bytes).ascii(0, 8) === "CSFCHUNK";
}

/** チャンクを分解して SQLite と外部データを取り出す */
export function splitChunks(bytes: Uint8Array) {
  const r = new Reader(bytes);
  if (r.ascii(0, 8) !== "CSFCHUNK") throw new Error(".clip ファイルではありません");
  let off = r.u64at(16) || 24;
  let sqlite: Uint8Array | null = null;
  const exta = new Map<string, Uint8Array>();
  while (off + 16 <= bytes.length) {
    if (r.ascii(off, 4) !== "CHNK") break;
    const type = r.ascii(off + 4, 4);
    const size = r.u64at(off + 8);
    const p = off + 16;
    if (type === "SQLi") sqlite = bytes.subarray(p, p + size);
    else if (type === "Exta") {
      const idLen = r.u64at(p);
      const id = r.ascii(p + 8, idLen);
      const dataLen = r.u64at(p + 8 + idLen);
      exta.set(id, bytes.subarray(p + 16 + idLen, p + 16 + idLen + dataLen));
    }
    off = p + size;
  }
  if (!sqlite) throw new Error(".clip の中にデータベースが見つかりません");
  return { sqlite, exta };
}

function colorOf(v: unknown) {
  // 32bit の各色 (0xDDDDDDDD など) → 8bit
  return Math.round((num(v as number) / 0xffffffff) * 255);
}

export async function parseClip(bytes: Uint8Array): Promise<ClipFile> {
  const { sqlite, exta } = splitChunks(bytes);
  const SQL = await getSql();
  const db = new SQL.Database(sqlite);
  try {
    return readDatabase(db, exta);
  } finally {
    db.close();
  }
}

function readDatabase(db: Database, exta: Map<string, Uint8Array>): ClipFile {
  const canvas = rows(db, "SELECT * FROM Canvas")[0];
  if (!canvas) throw new Error("キャンバス情報がありません");
  const width = Math.round(num(canvas.CanvasWidth));
  const height = Math.round(num(canvas.CanvasHeight));
  const layerRows = new Map<number, Row>(rows(db, "SELECT * FROM Layer").map((l) => [num(l.MainId), l]));
  const mipmaps = new Map(rows(db, "SELECT MainId, BaseMipmapInfo FROM Mipmap").map((m) => [num(m.MainId), num(m.BaseMipmapInfo)]));
  const infos = new Map(rows(db, "SELECT MainId, Offscreen FROM MipmapInfo").map((m) => [num(m.MainId), num(m.Offscreen)]));
  const offscreens = new Map(rows(db, "SELECT MainId, Attribute, BlockData FROM Offscreen").map((o) => [num(o.MainId), o]));
  let preview: Uint8Array | null = null;
  if (tableExists(db, "CanvasPreview")) preview = blob(rows(db, "SELECT ImageData FROM CanvasPreview LIMIT 1")[0]?.ImageData);

  const skipped: string[] = [];
  const decode = (mipmapId: number) => {
    const off = offscreens.get(infos.get(mipmaps.get(mipmapId) ?? -1) ?? -1);
    if (!off) return null;
    const attr = blob(off.Attribute);
    const ref = off.BlockData;
    if (!attr || ref == null) return null;
    // .clip では BlockData は外部チャンクの ID (ASCII)。素材ではデータそのものの場合もある
    const id = str(ref);
    const stream = exta.get(id) ?? (ref instanceof Uint8Array && ref.length > 64 ? ref : null);
    if (!stream) return null;
    return decodeOffscreen(attr, stream);
  };

  const layers: ClipLayer[] = [];
  type MaskSpec = { id: number; x: number; y: number };
  const maskOf = (l: Row): MaskSpec | null => {
    const id = num(l.LayerLayerMaskMipmap);
    if (!id || (num(l.LayerVisibility) & 2) !== 2) return null;
    const x = num(l.LayerOffsetX);
    const y = num(l.LayerOffsetY);
    return { id, x: num(l.LayerMaskOffsetX) + x + num(l.LayerMaskOffscrOffsetX), y: num(l.LayerMaskOffsetY) + y + num(l.LayerMaskOffscrOffsetY) };
  };
  const applyMask = (b: ClipBitmap, spec: MaskSpec) => {
    const m = decode(spec.id);
    if (!m?.gray) return;
    for (let yy = 0; yy < b.height; yy++) {
      const sy = b.y + yy - spec.y;
      for (let xx = 0; xx < b.width; xx++) {
        const sx = b.x + xx - spec.x;
        const v = sx >= 0 && sy >= 0 && sx < m.width && sy < m.height ? m.gray[sy * m.width + sx] : 0;
        const o = (yy * b.width + xx) * 4 + 3;
        b.rgba[o] = (b.rgba[o] * v) / 255;
      }
    }
  };

  const walk = (parentId: number, path: string, depth: number, masks: MaskSpec[]): ClipNode[] => {
    const out: ClipNode[] = [];
    if (depth > 64) return out;
    let id = num(layerRows.get(parentId)?.LayerFirstChildIndex);
    const seen = new Set<number>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const l = layerRows.get(id);
      if (!l) break;
      const name = str(l.LayerName) || "レイヤー";
      const visible = (num(l.LayerVisibility) & 1) === 1;
      const op = num(l.LayerOpacity, 256) / 256;
      if (num(l.LayerFolder) !== 0) {
        const fm = maskOf(l);
        const composite = num(l.LayerComposite);
        out.push({
          kind: "folder",
          name,
          visible,
          opacity: op,
          blend: composite === 30 ? "pass-through" : (CLIP_BLEND[composite] ?? "normal"),
          clip: num(l.LayerClip) !== 0,
          open: (num(l.LayerFolder) & 16) === 0,
          children: walk(id, `${path}${name}/`, depth + 1, fm ? [...masks, fm] : masks),
        });
      } else if (l.FilterLayerInfo != null || (l.TextLayerType != null && num(l.LayerRenderMipmap) === 0)) {
        skipped.push(name);
      } else {
        const x = num(l.LayerOffsetX);
        const y = num(l.LayerOffsetY);
        const renderId = num(l.LayerRenderMipmap);
        const fill: [number, number, number] | null =
          num(l.DrawColorEnable) === 1 ? [colorOf(l.DrawColorMainRed), colorOf(l.DrawColorMainGreen), colorOf(l.DrawColorMainBlue)] : null;
        const ownMask = maskOf(l);
        const allMasks = ownMask ? [...masks, ownMask] : masks;
        const load = (): ClipBitmap | null => {
          let b: ClipBitmap | null = null;
          if (fill) {
            // 用紙・塗りつぶしレイヤーは色で描く (マスクで範囲が決まる)
            const rgba = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < rgba.length; i += 4) {
              rgba[i] = fill[0];
              rgba[i + 1] = fill[1];
              rgba[i + 2] = fill[2];
              rgba[i + 3] = 255;
            }
            b = { rgba, width, height, x: 0, y: 0 };
          } else {
            const bmp = renderId ? decode(renderId) : null;
            if (!bmp) return null;
            let rgba = bmp.rgba;
            if (!rgba && bmp.gray) {
              // グレースケールのラスター: 明るさをそのまま使う
              rgba = new Uint8ClampedArray(bmp.width * bmp.height * 4);
              for (let i = 0; i < bmp.gray.length; i++) {
                rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = bmp.gray[i];
                rgba[i * 4 + 3] = 255;
              }
            }
            if (!rgba) return null;
            b = { rgba, width: bmp.width, height: bmp.height, x: x + num(l.LayerRenderOffscrOffsetX), y: y + num(l.LayerRenderOffscrOffsetY) };
          }
          // レイヤー自身とフォルダのマスク
          for (const m of allMasks) applyMask(b, m);
          return b;
        };
        const lock = num(l.LayerLock);
        const layerType = num(l.LayerType);
        if ((renderId && offscreens.has(infos.get(mipmaps.get(renderId) ?? -1) ?? -1)) || fill) {
          const layer: ClipLayer = {
            kind: "layer",
            name,
            path,
            visible,
            opacity: op,
            blend: CLIP_BLEND[num(l.LayerComposite)] ?? "normal",
            clip: num(l.LayerClip) !== 0,
            lockAlpha: (lock & 16) !== 0,
            locked: (lock & 1) !== 0,
            paper: layerType === 1584 || num(l.SpecialRenderType) === 20,
            fill,
            load: () => {
              try {
                return load();
              } catch (e) {
                console.warn("レイヤーを読み込めませんでした", name, e);
                skipped.push(name);
                return null;
              }
            },
          };
          layers.push(layer);
          out.push(layer);
        } else if (layerType !== 0) {
          skipped.push(name);
        }
      }
      id = num(l.LayerNextIndex);
    }
    return out;
  };
  const tree = walk(num(canvas.CanvasRootFolder), "", 0, []);
  return { width, height, dpi: num(canvas.CanvasResolution, 350), tree, layers, preview, skipped };
}
