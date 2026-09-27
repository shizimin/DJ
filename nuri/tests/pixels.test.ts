import { describe, expect, it } from "vitest";
import { alphaBounds, coverRect, dilateMask, floodFillMask, lumaToAlpha, nearestAspect, xdogLineArt } from "../src/image/pixels";

function img(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fn(x, y), (y * w + x) * 4);
  return d;
}

describe("floodFillMask", () => {
  it("線で囲まれた範囲だけを塗る", () => {
    // 10x10 の白に、x=5 の縦線 (黒)
    const d = img(10, 10, (x) => (x === 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const m = floodFillMask(d, 10, 10, 1, 1, 10);
    expect(m.reduce((a, v) => a + v, 0)).toBe(50);
    expect(m[5]).toBe(0);
    expect(m[6]).toBe(0);
  });
  it("隙間を広げると線の下まで届く", () => {
    const m = new Uint8Array(9);
    m[4] = 1;
    expect(dilateMask(m, 3, 3, 1).reduce((a, v) => a + v, 0)).toBe(5);
  });
});

describe("線画", () => {
  it("白は透明・黒は不透明になる", () => {
    const d = img(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = lumaToAlpha(d, [10, 20, 30]);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(255);
    expect([out[4], out[5], out[6]]).toEqual([10, 20, 30]);
  });
  it("DoG で明暗の境目に線が出る", () => {
    // 左半分が暗い画像 → 境目付近だけに線
    const w = 40, h = 20;
    const d = img(w, h, (x) => (x < 20 ? [30, 30, 30, 255] : [240, 240, 240, 255]));
    const ink = xdogLineArt(d, w, h, { thickness: 1.2, detail: 0.6, denoise: 0 });
    const row = [...ink.subarray(10 * w, 11 * w)];
    expect(Math.max(...row.slice(15, 22))).toBeGreaterThan(100); // 境目
    expect(Math.max(...row.slice(0, 8))).toBe(0); // 平坦な暗部は線にならない
    expect(Math.max(...row.slice(32))).toBe(0);
  });
});

describe("配置", () => {
  it("coverRect はキャンバスを覆う", () => {
    const r = coverRect(100, 100, 200, 100);
    expect(r.w).toBe(200);
    expect(r.h).toBe(200);
    expect(r.y).toBe(-50);
  });
  it("nearestAspect", () => {
    expect(nearestAspect(2894, 4093, ["1:1", "2:3", "3:4", "16:9"])).toBe("2:3");
    expect(nearestAspect(1920, 1080, ["1024x1024", "1536x1024", "1024x1536"])).toBe("1536x1024");
  });
  it("alphaBounds", () => {
    const d = img(5, 5, (x, y) => (x === 3 && y === 1 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(alphaBounds(d, 5, 5)).toEqual({ x: 3, y: 1, w: 1, h: 1 });
    expect(alphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});
