// 合成した .clip / ブロックストリームで解読処理を確認する。
import { createRequire } from "node:module";
import { deflate } from "pako";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeOffscreen, readAttribute } from "../src/io/csp-blocks";
import { parseClip, splitChunks } from "../src/io/clip";
import { getSql, setSqlWasmLocator } from "../src/io/sqlite";
import { readEffector } from "../src/io/sut";
import { readTar } from "../src/io/tar";

beforeAll(() => {
  const require = createRequire(import.meta.url);
  setSqlWasmLocator((f) => require.resolve(`sql.js/dist/${f}`));
});

class W {
  parts: number[] = [];
  u32(v: number) {
    this.parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    return this;
  }
  u32le(v: number) {
    this.parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    return this;
  }
  u64(v: number) {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v >>> 0);
  }
  str(s: string) {
    this.u32(s.length);
    for (const c of s) this.parts.push(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255);
    return this;
  }
  bytes(b: Uint8Array | number[]) {
    this.parts.push(...b);
    return this;
  }
  get out() {
    return new Uint8Array(this.parts);
  }
}

function attribute(w: number, h: number, colorChannels: number) {
  const cols = Math.ceil(w / 256);
  const rows = Math.ceil(h / 256);
  const params = new W();
  params.str("Parameter").u32(w).u32(h).u32(cols).u32(rows);
  for (let i = 0; i < 16; i++) params.u32(i === 1 ? 1 : i === 2 ? colorChannels : i === 8 ? 256 : 0);
  const init = new W().str("InitColor").u32(0).u32(0).u32(0).u32(0).u32(0);
  const block = new W().str("BlockSize").u32(12).u32(cols * rows).u32(4);
  for (let i = 0; i < cols * rows; i++) block.u32(0);
  return new W().u32(16).u32(params.out.length).u32(init.out.length).u32(block.out.length).bytes(params.out).bytes(init.out).bytes(block.out).out;
}

function tileRecord(index: number, raw: Uint8Array | null) {
  const body = new W().str("BlockDataBeginChunk").u32(index).u32(raw ? raw.length : 327680).u32(256).u32(256).u32(raw ? 1 : 0);
  if (raw) {
    const z = deflate(raw);
    body.u32(z.length + 4).u32le(z.length).bytes(z);
  }
  body.str("BlockDataEndChunk");
  const b = body.out;
  return new W().u32(b.length + 4).bytes(b).out;
}

/** 左上だけ赤 (α=200) の RGBA タイル */
function redTile() {
  const t = new Uint8Array(5 * 65536);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++) {
      const i = y * 256 + x;
      t[i] = 200; // α
      t[65536 + i * 4 + 2] = 255; // R (BGRX の R)
    }
  return t;
}

describe("ブロックストリーム", () => {
  it("属性を読める", () => {
    const a = readAttribute(attribute(300, 20, 4));
    expect(a).toMatchObject({ width: 300, height: 20, cols: 2, rows: 1, colorChannels: 4 });
  });
  it("RGBA タイルを組み立てる", () => {
    const stream = new W().bytes(tileRecord(0, redTile())).bytes(tileRecord(1, null)).out;
    const bmp = decodeOffscreen(attribute(300, 20, 4), stream);
    expect(bmp.rgba!.length).toBe(300 * 20 * 4);
    expect([...bmp.rgba!.subarray(0, 4)]).toEqual([255, 0, 0, 200]);
    expect(bmp.rgba![(15 * 300 + 15) * 4 + 3]).toBe(0);
  });
});

describe(".clip", () => {
  it("合成した .clip を読める (レイヤー順・不透明度・合成モード・位置)", async () => {
    const SQL = await getSql();
    const db = new SQL.Database();
    db.run(`CREATE TABLE Canvas (MainId, CanvasWidth, CanvasHeight, CanvasResolution, CanvasRootFolder);
      CREATE TABLE Layer (MainId, LayerName, LayerType, LayerFolder, LayerVisibility, LayerOpacity, LayerComposite, LayerClip, LayerLock,
        LayerFirstChildIndex, LayerNextIndex, LayerOffsetX, LayerOffsetY, LayerRenderOffscrOffsetX, LayerRenderOffscrOffsetY,
        LayerRenderMipmap, LayerLayerMaskMipmap, DrawColorEnable, DrawColorMainRed, DrawColorMainGreen, DrawColorMainBlue, SpecialRenderType, FilterLayerInfo);
      CREATE TABLE Mipmap (MainId, BaseMipmapInfo);
      CREATE TABLE MipmapInfo (MainId, Offscreen);
      CREATE TABLE Offscreen (MainId, Attribute, BlockData);
      INSERT INTO Canvas VALUES (1, 300, 20, 350, 1);
      INSERT INTO Layer VALUES (1,'',256,1,1,256,0,0,0, 2,0, 0,0,0,0, 0,0, NULL,NULL,NULL,NULL,NULL,NULL);
      INSERT INTO Layer VALUES (2,'Paper',1584,0,1,256,0,0,0, 0,3, 0,0,0,0, 0,0, 1,4294967295,4294967295,4294967295,20,NULL);
      INSERT INTO Layer VALUES (3,'線画',1,0,1,128,2,1,16, 0,0, -10,0,15,5, 7,0, NULL,NULL,NULL,NULL,NULL,NULL);
      INSERT INTO Mipmap VALUES (7, 8);
      INSERT INTO MipmapInfo VALUES (8, 9);`);
    db.run("INSERT INTO Offscreen VALUES (9, ?, ?)", [attribute(300, 20, 4), new TextEncoder().encode("extrnlidTEST")]);
    const sqlite = db.export();
    const stream = new W().bytes(tileRecord(0, redTile())).bytes(tileRecord(1, null)).out;
    const id = "extrnlidTEST";
    const exta = new W().u64(id.length).bytes([...id].map((c) => c.charCodeAt(0))).u64(stream.length).bytes(stream).out;
    const chunk = (type: string, payload: Uint8Array) => new W().bytes([..."CHNK" + type].map((c) => c.charCodeAt(0))).u64(payload.length).bytes(payload).out;
    const body = new W().bytes(chunk("Head", new Uint8Array(40))).bytes(chunk("Exta", exta)).bytes(chunk("SQLi", sqlite)).bytes(chunk("Foot", new Uint8Array(0))).out;
    const file = new W().bytes([..."CSFCHUNK"].map((c) => c.charCodeAt(0))).u64(24 + body.length).u64(24).bytes(body).out;

    expect(splitChunks(file).exta.has(id)).toBe(true);
    const clip = await parseClip(file);
    expect(clip).toMatchObject({ width: 300, height: 20, dpi: 350 });
    expect(clip.layers.map((l) => l.name)).toEqual(["Paper", "線画"]); // 下 → 上
    const [paper, line] = clip.layers;
    expect(paper.paper).toBe(true);
    expect([...paper.load()!.rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(line).toMatchObject({ opacity: 0.5, blend: "multiply", clip: true, lockAlpha: true });
    const b = line.load()!;
    expect([b.x, b.y]).toEqual([5, 5]); // LayerOffset + OffscrOffset
    expect([...b.rgba.subarray(0, 4)]).toEqual([255, 0, 0, 200]);
  });
});

describe(".sut", () => {
  it("筆圧設定 (Effector) を読める", () => {
    const e = new W().u32(44).u32(0xf0).u32(0x90).u32(10).u32(100).out;
    expect(readEffector(e)).toEqual({ pressure: true, min: 0.1 });
    expect(readEffector(new W().u32(44).u32(0xf0).u32(0).u32(0).out).pressure).toBe(false);
    expect(readEffector(3).pressure).toBe(false);
  });
  it("tar を読める", () => {
    const header = new Uint8Array(512);
    const put = (s: string, at: number) => [...s].forEach((c, i) => (header[at + i] = c.charCodeAt(0)));
    put("data/material.layer", 0);
    put("00000000005", 124);
    put("0", 156);
    const tar = new Uint8Array(512 * 3);
    tar.set(header);
    tar.set([1, 2, 3, 4, 5], 512);
    expect([...readTar(tar).get("data/material.layer")!]).toEqual([1, 2, 3, 4, 5]);
  });
});
