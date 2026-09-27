// 実際の CSP ファイルでの確認 (ライセンスの都合でリポジトリには含めない)。
// NURI_FIXTURES にファイルのあるディレクトリを指定したときだけ実行する。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeC2F } from "../src/io/c2f";
import { parseClip } from "../src/io/clip";
import { setSqlWasmLocator } from "../src/io/sqlite";
import { parseSut } from "../src/io/sut";

const dir = process.env.NURI_FIXTURES ?? "";
const file = (p: string) => join(dir, p);
const has = (p: string) => !!dir && existsSync(file(p));

beforeAll(() => {
  const require = createRequire(import.meta.url);
  setSqlWasmLocator((f) => require.resolve(`sql.js/dist/${f}`));
});

describe.skipIf(!dir)("実ファイル", () => {
  it.skipIf(!has("clip_to_psd/tests/test_export_all_features.clip"))("clip を読める", async () => {
    const clip = await parseClip(new Uint8Array(readFileSync(file("clip_to_psd/tests/test_export_all_features.clip"))));
    expect(clip.width).toBe(928);
    expect(clip.height).toBe(647);
    expect(clip.preview?.[1]).toBe(0x50); // PNG
    expect(clip.layers[0].paper).toBe(true);
    const named = clip.layers.find((l) => l.name === "Layer 2 opacity")!;
    expect(named.opacity).toBeCloseTo(207 / 256);
    const add = clip.layers.find((l) => l.name === "add-no-glow")!;
    expect(add.blend).toBe("add");
    let pixels = 0;
    for (const l of clip.layers) {
      const b = l.load();
      if (!b) continue;
      for (let i = 3; i < b.rgba.length; i += 4) if (b.rgba[i]) pixels++;
    }
    expect(pixels).toBeGreaterThan(1000);
    console.log(`layers=${clip.layers.length} skipped=${clip.skipped.length}`, clip.layers.slice(0, 8).map((l) => `${l.path}${l.name}:${l.blend}`));
  });

  it.skipIf(!has("Brush-Converter/sample.sut"))("sut を読める", async () => {
    const brushes = await parseSut(new Uint8Array(readFileSync(file("Brush-Converter/sample.sut"))));
    expect(brushes).toHaveLength(1);
    const b = brushes[0];
    expect(b.size).toBe(80);
    expect(b.pressureSize).toBe(true);
    expect(b.minSize).toBeCloseTo(0.1);
    expect(b.tip).not.toBeNull();
    console.log(b.name, b.tip!.width, b.tip!.height, b.tip!.alpha.reduce((a, v) => Math.max(a, v), 0));
  });

  it.skipIf(!has("mat/1_data_material.layer"))("素材 .layer を読める", () => {
    for (const n of ["1_data_material.layer", "2_data_material_0.layer"]) {
      if (!has(`mat/${n}`)) continue;
      const img = decodeC2F(new Uint8Array(readFileSync(file(`mat/${n}`))));
      console.log(n, img.width, img.height, !!img.gray, !!img.rgba, !!img.png);
      expect(img.width).toBeGreaterThan(0);
    }
  });
});
