// CLIP STUDIO PAINT のラスターデータ (Offscreen) の解読。
// .clip の外部チャンクと、素材 .layer (C2F) の BlockData は同じ「ブロックストリーム」形式。
//
// 形式は公開されていないため、オープンソースの解析結果 (dobrokot/clip_to_psd など) を
// 元に独自に実装している。すべてビッグエンディアン (一部リトルエンディアンの長さを除く)。

import { inflate } from "pako";

export const TILE = 256;

export class Reader {
  private dv: DataView;
  constructor(
    public bytes: Uint8Array,
    public pos = 0,
  ) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  /** 現在位置から読み進める */
  u32() {
    const v = this.dv.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }
  /** 指定位置を読む (位置は動かさない) */
  u32at(at: number) {
    return this.dv.getUint32(at, false);
  }
  u32le(at: number) {
    return this.dv.getUint32(at, true);
  }
  u64at(at: number) {
    return Number(this.dv.getBigUint64(at, false));
  }
  /** u32 文字数 + UTF-16BE */
  utf16(): string {
    const n = this.u32();
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint16(this.pos + i * 2, false));
    this.pos += n * 2;
    return s;
  }
  ascii(at: number, n: number) {
    return String.fromCharCode(...this.bytes.subarray(at, at + n));
  }
}

export interface OffscreenAttr {
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** アルファ (または単一) チャンネル数 */
  alphaChannels: number;
  /** カラーチャンネル数 (RGBA レイヤーは 4、マスク・グレーは 0) */
  colorChannels: number;
  /** 1bit パック (未対応) */
  oneBit: boolean;
  /** 空ブロックを白で埋める */
  fillWhite: boolean;
}

/** Offscreen.Attribute の解読 (セクション長はヘッダーの値に従う) */
export function readAttribute(bytes: Uint8Array): OffscreenAttr {
  const r = new Reader(bytes);
  const headerSize = r.u32();
  const paramSize = r.u32();
  const initSize = r.u32();
  r.u32(); // BlockSize セクション長
  r.pos = headerSize;
  const paramStart = r.pos;
  if (r.utf16() !== "Parameter") throw new Error("Offscreen 属性の形式が不明です");
  const width = r.u32();
  const height = r.u32();
  const cols = r.u32();
  const rows = r.u32();
  const params: number[] = [];
  while (r.pos + 4 <= paramStart + paramSize) params.push(r.u32());
  r.pos = paramStart + paramSize;
  const initStart = r.pos;
  let fillWhite = false;
  if (initSize >= 22 && r.utf16() === "InitColor") {
    r.u32();
    fillWhite = r.u32() === 1;
  }
  r.pos = initStart + initSize;
  return {
    width,
    height,
    cols,
    rows,
    alphaChannels: params[1] ?? 1,
    colorChannels: params[2] ?? 0,
    oneBit: params[8] === 32,
    fillWhite,
  };
}

const BEGIN = "BlockDataBeginChunk";

/** ブロックストリームからタイル (index → 展開済みデータ) を取り出す */
export function readTiles(stream: Uint8Array): Map<number, Uint8Array> {
  const r = new Reader(stream);
  const tiles = new Map<number, Uint8Array>();
  let i = 0;
  while (i + 8 <= stream.length) {
    const size = r.u32at(i);
    const nameLen = r.u32at(i + 4);
    if (nameLen !== BEGIN.length) break; // BlockStatus / BlockCheckSum 以降は不要
    r.pos = i + 4;
    if (r.utf16() !== BEGIN) break;
    const p = r.pos;
    const index = r.u32at(p);
    const hasData = r.u32at(p + 16);
    if (hasData) {
      const zlen = r.u32le(p + 24);
      tiles.set(index, inflate(stream.subarray(p + 28, p + 28 + zlen)));
    }
    if (size <= 0) break;
    i += size;
  }
  return tiles;
}

export interface DecodedBitmap {
  width: number;
  height: number;
  /** RGBA (ストレートアルファ)。単一チャンネルの場合は null */
  rgba: Uint8ClampedArray | null;
  /** 単一チャンネル (マスク・ブラシ先端・グレー素材) */
  gray: Uint8Array | null;
}

/** 属性 + ブロックストリームからビットマップを組み立てる */
export function decodeOffscreen(attrBytes: Uint8Array, stream: Uint8Array): DecodedBitmap {
  const a = readAttribute(attrBytes);
  if (a.oneBit) throw new Error("1bit レイヤーには未対応です");
  const tiles = readTiles(stream);
  const { width: W, height: H } = a;
  if (a.colorChannels >= 3) {
    const out = new Uint8ClampedArray(W * H * 4);
    if (a.fillWhite) out.fill(255);
    for (const [index, t] of tiles) {
      const ox = (index % a.cols) * TILE;
      const oy = Math.floor(index / a.cols) * TILE;
      for (let y = 0; y < TILE; y++) {
        const Y = oy + y;
        if (Y >= H) break;
        for (let x = 0; x < TILE; x++) {
          const X = ox + x;
          if (X >= W) break;
          const i = y * TILE + x;
          const c = TILE * TILE + i * 4;
          const o = (Y * W + X) * 4;
          out[o] = t[c + 2];
          out[o + 1] = t[c + 1];
          out[o + 2] = t[c];
          out[o + 3] = t[i];
        }
      }
    }
    return { width: W, height: H, rgba: out, gray: null };
  }
  const gray = new Uint8Array(W * H);
  if (a.fillWhite) gray.fill(255);
  for (const [index, t] of tiles) {
    const ox = (index % a.cols) * TILE;
    const oy = Math.floor(index / a.cols) * TILE;
    for (let y = 0; y < TILE && oy + y < H; y++) {
      const w = Math.min(TILE, W - ox);
      if (w > 0) gray.set(t.subarray(y * TILE, y * TILE + w), (oy + y) * W + ox);
    }
  }
  return { width: W, height: H, rgba: null, gray };
}

/** ストリームに含まれるデータ付きタイルの数 (候補選び用) */
export function countDataTiles(stream: Uint8Array) {
  try {
    return readTiles(stream).size;
  } catch {
    return 0;
  }
}

export function looksLikeAttribute(b: unknown): b is Uint8Array {
  return b instanceof Uint8Array && b.length > 40 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 16;
}

export function looksLikeBlockStream(b: unknown): b is Uint8Array {
  if (!(b instanceof Uint8Array) || b.length < 46) return false;
  const r = new Reader(b);
  if (r.u32at(4) !== BEGIN.length) return false;
  r.pos = 4;
  return r.utf16() === BEGIN;
}
