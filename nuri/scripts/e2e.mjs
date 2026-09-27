// 実ブラウザでの動作確認 (Playwright + Chromium)。
// 使い方: npm run build && node scripts/e2e.mjs [CSP サンプルのディレクトリ]
// AI の API はモックに差し替えるので、API キーや料金は不要。
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const fixtures = process.argv[2] ?? "";
const out = process.env.E2E_OUT ?? "e2e-output";
mkdirSync(out, { recursive: true });
const server = spawn("npx", ["vite", "preview", "--port", "5199", "--strictPort"], { stdio: "pipe", detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid); // npx の子プロセス (vite) ごと終了
  } catch {}
};
process.on("exit", stopServer);
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("5199") && resolve());
  server.stderr.on("data", (d) => String(d).includes("in use") && reject(new Error(String(d))));
});

// クラウド環境では同梱の Chromium を使う (ローカルでは Playwright の既定)
const exe = process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name} ${extra}`);
  if (!ok) failed++;
};

// AI API のモック: 400x300 の青い PNG を返す
const bluePng = await (async () => {
  const p = await browser.newPage();
  const b64 = await p.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const g = c.getContext("2d");
    g.fillStyle = "#3366ff";
    g.fillRect(0, 0, 400, 300);
    g.fillStyle = "#000";
    g.fillRect(100, 100, 200, 8);
    return c.toDataURL("image/png").split(",")[1];
  });
  await p.close();
  return b64;
})();
const aiRequests = [];
await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
  aiRequests.push(JSON.parse(route.request().postData()));
  await new Promise((r) => setTimeout(r, 300));
  await route.fulfill({ json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: bluePng } }] } }] } });
});

await page.goto("http://localhost:5199/");
await page.waitForSelector("canvas.stage");
await page.waitForTimeout(300);
const state = () =>
  page.evaluate(() => {
    const { editor } = window.nuri;
    return { layers: editor.doc.layers.map((l) => l.name), w: editor.doc.width, h: editor.doc.height, undo: editor.history.canUndo };
  });

// 1. 描画
const box = await page.locator("canvas.stage").boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx - 150, cy);
await page.mouse.down();
for (let i = 0; i <= 30; i++) await page.mouse.move(cx - 150 + i * 10, cy + Math.sin(i / 4) * 60);
await page.mouse.up();
const painted = await page.evaluate(() => {
  const l = window.nuri.editor.doc.active;
  const d = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
});
check("ペンで描ける", painted > 500, `(${painted}px)`);
await page.keyboard.press("Meta+z");
const afterUndo = await page.evaluate(() => {
  const l = window.nuri.editor.doc.active;
  const d = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
});
check("取り消しできる", afterUndo === 0);
await page.keyboard.press("Meta+Shift+z");
await page.screenshot({ path: join(out, "1-draw.png") });

// 2. 塗りつぶし・レイヤー追加
await page.keyboard.press("Meta+Shift+n");
check("レイヤー追加", (await state()).layers.length === 3);

// 3. AI 背景生成 (モック)
await page.evaluate(() => (window.nuri.settings.geminiKey = "TEST"));
await page.getByRole("button", { name: "AI", exact: true }).click();
await page.locator(".ai-panel textarea").first().fill("夕暮れの教室");
await page.getByRole("button", { name: "✨ 背景を生成" }).click();
await page.waitForFunction(() => window.nuri.editor.doc.layers.some((l) => l.name.startsWith("AI背景")), null, { timeout: 10000 });
const s3 = await state();
check("AI 背景がレイヤーとして用紙の上に入る", s3.layers[1].startsWith("AI背景"), JSON.stringify(s3.layers));
const req = aiRequests[0];
check("背景生成は今の絵を送る", req.contents[0].parts.length === 2 && req.contents[0].parts[0].text.includes("夕暮れの教室"));
check("キャンバスに近い縦横比を指定", req.generationConfig.imageConfig.aspectRatio === "4:3", req.generationConfig.imageConfig.aspectRatio);
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, "2-ai-background.png") });

// 4. 写真の線画化 (ローカル & AI)
await page.locator(".ai-panel .tabs button", { hasText: "線画化" }).click();
await page.evaluate(() => {
  const { editor } = window.nuri;
  const d = editor.doc;
  const l = d.newLayer("写真");
  const g = l.ctx;
  g.fillStyle = "#ddd";
  g.fillRect(200, 200, 800, 600);
  g.fillStyle = "#333";
  g.beginPath();
  g.arc(600, 500, 180, 0, Math.PI * 2);
  g.fill();
  d.insert(l);
  editor.changed();
});
await page.locator(".segmented button", { hasText: "ローカル (無料)" }).click();
await page.getByRole("button", { name: "✏️ 線画レイヤーを作る" }).click();
await page.waitForFunction(() => window.nuri.editor.doc.layers.some((l) => l.name === "線画 (ローカル)"), null, { timeout: 20000 });
check("ローカル線画化", true);
await page.evaluate(() => {
  const d = window.nuri.editor.doc;
  d.activeId = d.layers.find((l) => l.name === "写真").id;
  window.nuri.editor.changed();
});
await page.locator(".segmented button", { hasText: "AI で線画化" }).click();
await page.getByRole("button", { name: "✏️ 線画レイヤーを作る" }).click();
await page.waitForFunction(() => window.nuri.editor.doc.layers.some((l) => l.name === "線画 (AI)"), null, { timeout: 10000 });
const lineReq = aiRequests[1];
check("AI 線画化のプロンプト", lineReq.contents[0].parts[0].text.includes("line art"));
const aiLine = await page.evaluate(() => {
  const l = window.nuri.editor.doc.layers.find((x) => x.name === "線画 (AI)");
  const d = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data;
  let opaque = 0, clear = 0;
  for (let i = 3; i < d.length; i += 4) d[i] > 200 ? opaque++ : d[i] === 0 && clear++;
  return { opaque, clear };
});
check("AI 線画は白が透明・線だけ残る", aiLine.opaque > 100 && aiLine.clear > 100, JSON.stringify(aiLine));
await page.screenshot({ path: join(out, "3-lineart.png") });

// 5. 選択範囲の描き直し
await page.keyboard.press("l");
await page.mouse.move(cx - 100, cy - 100);
await page.mouse.down();
for (const [dx, dy] of [[100, -100], [100, 0], [0, 100], [-100, 100], [-100, 0]]) await page.mouse.move(cx + dx, cy + dy, { steps: 5 });
await page.mouse.up();
check("投げなわ選択", await page.evaluate(() => !!window.nuri.editor.doc.selection));
await page.locator(".ai-panel .tabs button", { hasText: "描き直し" }).click();
await page.locator(".ai-panel textarea").fill("花を描く");
await page.getByRole("button", { name: "🖌 描き直す" }).click();
await page.waitForFunction(() => window.nuri.editor.doc.layers.some((l) => l.name.startsWith("AI描き直し")), null, { timeout: 10000 });
check("描き直しはマスク付きで送る", aiRequests[2].contents[0].parts.length === 3);
const outside = await page.evaluate(() => {
  const l = window.nuri.editor.doc.layers.find((x) => x.name.startsWith("AI描き直し"));
  return l.ctx.getImageData(5, 5, 1, 1).data[3];
});
check("描き直しは選択範囲の外に影響しない", outside === 0);
await page.keyboard.press("Meta+d");

// 6. CSP ファイル
if (fixtures && existsSync(join(fixtures, "clip_to_psd/tests/test_export_all_features.clip"))) {
  const load = async (rel, name) => {
    const bytes = [...readFileSync(join(fixtures, rel))];
    await page.evaluate(
      async ([bytes, name]) => {
        await window.nuri.openFiles([new File([new Uint8Array(bytes)], name)]);
      },
      [bytes, name],
    );
  };
  page.on("dialog", (d) => d.accept());
  await load("clip_to_psd/tests/test_export_all_features.clip", "sample.clip");
  const s6 = await state();
  check(".clip を開ける", s6.w === 928 && s6.layers.length > 50, `${s6.w}x${s6.h} ${s6.layers.length} layers`);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "レイヤー", exact: true }).click();
  await page.screenshot({ path: join(out, "4-clip.png") });
  if (existsSync(join(fixtures, "Brush-Converter/sample.sut"))) {
    await load("Brush-Converter/sample.sut", "sample.sut");
    const brush = await page.evaluate(() => {
      const b = window.nuri.editor.brush;
      return { name: b.name, tip: !!b.tip, size: b.size };
    });
    check(".sut ブラシを読める", brush.tip && brush.size === 80, JSON.stringify(brush));
    // 読み込んだブラシで描く
    await page.mouse.move(cx - 200, cy + 150);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) await page.mouse.move(cx - 200 + i * 20, cy + 150);
    await page.mouse.up();
    await page.screenshot({ path: join(out, "5-sut-brush.png") });
  }
  if (existsSync(join(fixtures, "mat/2_data_material_0.layer"))) {
    await page.getByRole("button", { name: "素材", exact: true }).click();
    await load("mat/2_data_material_0.layer", "texture.layer");
    await page.waitForTimeout(500);
    const n = await page.locator(".asset").count();
    check("素材 .layer を取り込める", n >= 1, `(${n})`);
    await page.locator(".asset").first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, "6-assets.png") });
  }
}

// 7. PSD 保存 → 読み込み
const psd = await page.evaluate(() => {
  const { editor, psd } = window.nuri;
  const before = editor.doc.layers.map((l) => [l.name, l.blend, Math.round(l.opacity * 100), l.visible, l.clip]);
  const doc = psd.readPsdFile(psd.writePsdFile(editor.doc), "roundtrip.psd");
  const after = doc.layers.map((l) => [l.name, l.blend, Math.round(l.opacity * 100), l.visible, l.clip]);
  return { same: JSON.stringify(before) === JSON.stringify(after), n: after.length };
});
check("PSD で保存して開き直してもレイヤー情報が保たれる", psd.same, `(${psd.n} layers)`);

check("コンソールエラーなし", errors.length === 0, errors.slice(0, 3).join("\n"));
await browser.close();
stopServer();
process.exit(failed ? 1 : 0);
