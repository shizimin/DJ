// CLIP STUDIO の素材ファイル (.layer, 先頭が "\x89C2F") の読み込み。
//
// 中身は SQLite だが先頭部分 (ヘッダーを含む 1〜5 ページ目) が暗号化されているため、
// SQLite として開くことはできない。平文で残っている 6 ページ目以降を直接走査して
// レコードを取り出し、Offscreen (属性 + ブロックストリーム) を探して画像を復元する。

import { countDataTiles, decodeOffscreen, looksLikeAttribute, looksLikeBlockStream, type DecodedBitmap } from "./csp-blocks";

const SIGNATURE = [0x89, 0x43, 0x32, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const PAGE = 1024;
const FIRST_PLAIN_PAGE = 6;

export function isC2F(b: Uint8Array) {
  return b.length > 8 && SIGNATURE.every((v, i) => b[i] === v);
}

/** PNG 風のチャンク (LE 長さ + 4 文字 + データ + CRC) から平文ページ部分を取り出す */
function plainPages(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8;
  let best: Uint8Array | null = null;
  while (o + 12 <= b.length) {
    const len = dv.getUint32(o, true);
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (type === "dATA" && len >= 2 && (len - 2) % PAGE === 0 && (!best || len - 2 > best.length)) {
      best = b.subarray(o + 10, o + 8 + len);
    }
    if (type === "TAIL") break;
    o += 12 + len;
  }
  return best;
}

function varint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 9; i++) {
    const x = b[p++];
    if (i === 8) return [v * 256 + x, p];
    v = v * 128 + (x & 0x7f);
    if (x < 0x80) return [v, p];
  }
  return [v, p];
}

type Field = number | string | Uint8Array | null;

function parseRecord(pl: Uint8Array): Field[] {
  const [hs, start] = varint(pl, 0);
  let p = start;
  let body = hs;
  const out: Field[] = [];
  while (p < hs) {
    const [t, np] = varint(pl, p);
    p = np;
    if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + pl[body + i];
      if (n && pl[body] & 0x80) v -= 2 ** (8 * n);
      out.push(v);
      body += n;
    } else if (t === 7) {
      out.push(new DataView(pl.buffer, pl.byteOffset + body, 8).getFloat64(0, false));
      body += 8;
    } else if (t === 8 || t === 9) {
      out.push(t - 8);
    } else if (t >= 12) {
      const n = (t - 12) >> 1;
      const bytes = pl.subarray(body, body + n);
      // テキストは UTF-16LE (素材 DB のエンコーディング)
      out.push(t % 2 ? new TextDecoder("utf-16le").decode(bytes) : bytes);
      body += n;
    } else out.push(null);
  }
  return out;
}

/** 平文ページから全テーブルのレコードを列挙する */
export function c2fRecords(file: Uint8Array): Field[][] {
  const pages = plainPages(file);
  if (!pages) throw new Error("素材データが見つかりません");
  const count = Math.floor(pages.length / PAGE);
  const page = (n: number) => {
    const i = n - FIRST_PLAIN_PAGE;
    return i >= 0 && i < count ? pages.subarray(i * PAGE, (i + 1) * PAGE) : null;
  };
  const U = PAGE;
  const maxLocal = U - 35;
  const minLocal = Math.floor(((U - 12) * 32) / 255) - 23;
  const records: Field[][] = [];
  for (let i = 0; i < count; i++) {
    const pg = pages.subarray(i * PAGE, (i + 1) * PAGE);
    if (pg[0] !== 0x0d) continue; // テーブルの葉ページのみ
    const cells = (pg[3] << 8) | pg[4];
    for (let c = 0; c < cells; c++) {
      try {
        const ptr = (pg[8 + 2 * c] << 8) | pg[9 + 2 * c];
        let [size, p] = varint(pg, ptr);
        [, p] = varint(pg, p); // rowid
        let local = size;
        if (size > maxLocal) {
          const k = minLocal + ((size - minLocal) % (U - 4));
          local = k > maxLocal ? minLocal : k;
        }
        const payload = new Uint8Array(size);
        payload.set(pg.subarray(p, p + local));
        let filled = local;
        let next = local < size ? ((pg[p + local] << 24) | (pg[p + local + 1] << 16) | (pg[p + local + 2] << 8) | pg[p + local + 3]) >>> 0 : 0;
        while (filled < size) {
          const ov = page(next);
          if (!ov) throw new Error("overflow page missing");
          const take = Math.min(size - filled, U - 4);
          payload.set(ov.subarray(4, 4 + take), filled);
          filled += take;
          next = ((ov[0] << 24) | (ov[1] << 16) | (ov[2] << 8) | ov[3]) >>> 0;
        }
        records.push(parseRecord(payload));
      } catch {
        /* 暗号化ページにまたがるレコードは読めないので飛ばす */
      }
    }
  }
  return records;
}

const PNG = [0x89, 0x50, 0x4e, 0x47];

export interface C2FImage extends DecodedBitmap {
  /** 画像データが読めず、埋め込みサムネイル PNG を使った場合 */
  png?: Uint8Array;
}

/** 素材 .layer から画像を取り出す。タイルが見つからない場合はサムネイル PNG を返す */
export function decodeC2F(file: Uint8Array): C2FImage {
  const records = c2fRecords(file);
  let best: { attr: Uint8Array; stream: Uint8Array; tiles: number } | null = null;
  let png: Uint8Array | null = null;
  for (const f of records) {
    for (let i = 0; i + 1 < f.length; i++) {
      const a = f[i];
      const s = f[i + 1];
      if (looksLikeAttribute(a) && looksLikeBlockStream(s)) {
        const tiles = countDataTiles(s);
        if (!best || tiles > best.tiles) best = { attr: a, stream: s, tiles };
      }
    }
    for (const v of f) {
      if (v instanceof Uint8Array && PNG.every((x, k) => v[k] === x) && (!png || v.length > png.length)) png = v;
    }
  }
  if (best && best.tiles > 0) return decodeOffscreen(best.attr, best.stream);
  if (png) return { width: 0, height: 0, rgba: null, gray: null, png };
  throw new Error("素材の画像データを読み取れませんでした");
}
