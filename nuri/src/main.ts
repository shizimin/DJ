import "./style.css";
import { AiJobs, canvasToBlob } from "./ai/features";
import { loadSettings } from "./ai/providers";
import { createDocument } from "./core/doc";
import { Editor, isTyping, toast, TOOLS } from "./core/editor";
import { openFiles } from "./io/open";
import { readPsdFile, writePsdFile } from "./io/psd";
import { aiPanel } from "./ui/ai";
import { assetsPanel } from "./ui/assets";
import { colorPanel } from "./ui/color";
import { download, h, modal } from "./ui/dom";
import { layersPanel } from "./ui/layers";
import { subToolPanel, toolbar } from "./ui/tools";
import { loadBrushPrefs, saveBrushPrefs } from "./io/library";
import { setSqlWasmLocator } from "./io/sqlite";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

setSqlWasmLocator(() => sqlWasmUrl);

const app = document.getElementById("app")!;
const stageWrap = h("div", { class: "stage-wrap" });
const editor = new Editor(stageWrap);
const settings = loadSettings();
const jobs = new AiJobs(editor, () => settings);

const persistBrushes = () => saveBrushPrefs(editor).catch(() => {});
loadBrushPrefs(editor).then(() => editor.changed());

const layers = layersPanel(editor);
const subtool = subToolPanel(editor, persistBrushes);

// ------------------------------------------------------------ ファイル操作

async function newDocument() {
  const presets: [string, number, number][] = [
    ["A4 (350dpi)", 2894, 4093],
    ["B5 (350dpi)", 2508, 3541],
    ["イラスト 縦", 2000, 2800],
    ["イラスト 横", 2800, 2000],
    ["正方形", 2400, 2400],
    ["Full HD", 1920, 1080],
    ["4K", 3840, 2160],
  ];
  const w = h("input", { type: "number", value: 2000, min: 16, max: 10000 });
  const hh = h("input", { type: "number", value: 2800, min: 16, max: 10000 });
  const name = h("input", { value: "無題", class: "text" });
  const body = h(
    "div",
    { class: "new-doc" },
    h("label", { class: "field" }, "名前", name),
    h(
      "div",
      { class: "chips" },
      ...presets.map(([label, pw, ph]) =>
        h(
          "button",
          {
            class: "chip-text",
            onClick: () => {
              w.value = String(pw);
              hh.value = String(ph);
            },
          },
          `${label} ${pw}×${ph}`,
        ),
      ),
    ),
    h("div", { class: "row" }, h("label", { class: "field inline" }, "幅", w), h("label", { class: "field inline" }, "高さ", hh)),
  );
  modal("新規キャンバス", body, [
    { label: "キャンセル", onClick: () => {} },
    {
      label: "作成",
      primary: true,
      onClick: () => {
        const W = Math.max(16, Math.min(10000, Number(w.value) || 0));
        const H = Math.max(16, Math.min(10000, Number(hh.value) || 0));
        if (!confirmDiscard()) return false;
        editor.setDocument(createDocument(W, H, name.value || "無題"));
      },
    },
  ]);
}

function confirmDiscard() {
  return !editor.history.canUndo || confirm("現在のキャンバスの未保存の変更は失われます。続けますか？");
}

async function open() {
  const input = h("input", { type: "file", accept: ".psd,.clip,.sut,.png,.jpg,.jpeg,.webp,.layer", multiple: true });
  input.addEventListener("change", () => handleFiles([...(input.files ?? [])]));
  input.click();
}

async function handleFiles(files: File[]) {
  try {
    await openFiles(files, { editor, confirmDiscard, onBrushes: () => (persistBrushes(), subtool.refresh()), assets });
  } catch (e) {
    console.error(e);
    toast(`読み込めませんでした: ${(e as Error).message}`, "error", 8000);
  }
}

async function savePsd() {
  const buf = writePsdFile(editor.doc);
  download(new Blob([buf], { type: "image/vnd.adobe.photoshop" }), `${editor.doc.name}.psd`);
  toast("PSD を保存しました (CLIP STUDIO PAINT でそのまま開けます)", "ok");
}

async function exportPng() {
  download(await canvasToBlob(editor.doc.flatten()), `${editor.doc.name}.png`);
}

// ------------------------------------------------------------ レイアウト

const zoomLabel = h("button", { class: "zoom", title: "クリックで画面に合わせる (⌘0)", onClick: () => editor.fitView() });
const undoBtn = h("button", { title: "取り消し (⌘Z)", onClick: () => editor.history.undo() }, "↶");
const redoBtn = h("button", { title: "やり直し (⇧⌘Z)", onClick: () => editor.history.redo() }, "↷");
const docTitle = h("span", { class: "doc-title" });

const topbar = h(
  "header",
  { class: "topbar" },
  h("span", { class: "logo" }, "Nuri"),
  h("button", { onClick: newDocument, title: "新規 (⌘N)" }, "新規"),
  h("button", { onClick: open, title: "開く (⌘O) — PSD / CLIP / 画像 / ブラシ(.sut)" }, "開く"),
  h("button", { onClick: savePsd, title: "PSD で保存 (⌘S)" }, "保存"),
  h("button", { onClick: exportPng, title: "PNG 書き出し (⇧⌘E)" }, "PNG"),
  h("span", { class: "sep" }),
  undoBtn,
  redoBtn,
  h("span", { class: "sep" }),
  h("button", { title: "縮小 (⌘-)", onClick: () => editor.setZoom(editor.view.zoom / 1.25) }, "−"),
  zoomLabel,
  h("button", { title: "拡大 (⌘+)", onClick: () => editor.setZoom(editor.view.zoom * 1.25) }, "＋"),
  h("button", { title: "左回転 (Q)", onClick: () => editor.rotate(-15) }, "⟲"),
  h("button", { title: "回転をリセット", onClick: () => editor.rotate(null) }, "0°"),
  h("button", { title: "右回転 (R)", onClick: () => editor.rotate(15) }, "⟳"),
  h("span", { class: "spacer" }),
  docTitle,
);

const assets = assetsPanel(editor, { onBrushes: () => (persistBrushes(), subtool.refresh()), openFiles: handleFiles });

const rightTabs = { layers: ["レイヤー", layers.el], ai: ["AI", aiPanel(editor, settings, jobs)], assets: ["素材", assets.el] } as const;
type RightTab = keyof typeof rightTabs;
const rightBody = h("div", { class: "right-body" });
const rightButtons = new Map<RightTab, HTMLButtonElement>();
function showRight(id: RightTab) {
  rightBody.replaceChildren(rightTabs[id][1]);
  rightButtons.forEach((b, k) => b.classList.toggle("on", k === id));
}
const rightTabBar = h(
  "div",
  { class: "tabs main-tabs" },
  ...(Object.keys(rightTabs) as RightTab[]).map((id) => {
    const b = h("button", { onClick: () => showRight(id) }, rightTabs[id][0]);
    rightButtons.set(id, b);
    return b;
  }),
);

app.append(
  topbar,
  h(
    "main",
    { class: "workspace" },
    toolbar(editor),
    h("aside", { class: "left" }, subtool),
    stageWrap,
    h("aside", { class: "right" }, colorPanel(editor), rightTabBar, rightBody),
  ),
);
showRight("layers");

const syncTop = () => {
  zoomLabel.textContent = `${Math.round(editor.view.zoom * 100)}%`;
  undoBtn.disabled = !editor.history.canUndo;
  redoBtn.disabled = !editor.history.canRedo;
  docTitle.textContent = `${editor.doc.name} — ${editor.doc.width}×${editor.doc.height}`;
  document.title = `${editor.doc.name} - Nuri`;
};
editor.onChange(syncTop);
editor.history.onChange = syncTop;
syncTop();

// ------------------------------------------------------------ ショートカット (Mac は ⌘、他は Ctrl)

window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod) {
    const map: Record<string, () => void> = {
      z: () => (e.shiftKey ? editor.history.redo() : editor.history.undo()),
      y: () => editor.history.redo(),
      s: () => void savePsd(),
      o: () => void open(),
      n: () => (e.shiftKey ? layers.actions.add() : void newDocument()),
      a: () => editor.selectAll(),
      d: () => editor.deselect(),
      i: () => e.shiftKey && editor.invertSelection(),
      e: () => (e.shiftKey ? void exportPng() : layers.actions.mergeDown()),
      "0": () => editor.fitView(),
      "1": () => editor.setZoom(1),
      "=": () => editor.setZoom(editor.view.zoom * 1.25),
      "+": () => editor.setZoom(editor.view.zoom * 1.25),
      "-": () => editor.setZoom(editor.view.zoom / 1.25),
    };
    if (map[k]) {
      e.preventDefault();
      map[k]();
    }
    return;
  }
  if (k === "backspace" || k === "delete") {
    e.preventDefault();
    if (e.altKey) editor.fillSelected();
    else editor.clearSelected();
    return;
  }
  if (k === "[" || k === "]") {
    const b = editor.brush;
    b.size = Math.max(1, Math.min(500, Math.round(k === "]" ? b.size * 1.15 + 1 : b.size / 1.15 - 1)));
    editor.changed();
    editor.requestRender();
    persistBrushes();
    return;
  }
  if (k === "r") return editor.rotate(15);
  if (k === "q") return editor.rotate(-15);
  if (k === "x") {
    // 描画色と白を入れ替え
    editor.setColor(editor.color === "#ffffff" ? editor.recentColors.find((c) => c !== "#ffffff") ?? "#000000" : "#ffffff");
    return;
  }
  const tool = TOOLS.find((t) => t.key === k);
  if (tool) editor.setTool(tool.id);
});

// ------------------------------------------------------------ ドラッグ & ドロップ

window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    document.body.classList.add("dropping");
  }
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dropping");
});
window.addEventListener("drop", (e) => {
  document.body.classList.remove("dropping");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  handleFiles(files);
});

window.addEventListener("beforeunload", (e) => {
  if (editor.history.canUndo) e.preventDefault();
});

// デバッグ・自動テスト用
Object.assign(window, { nuri: { editor, jobs, settings, openFiles: handleFiles, psd: { readPsdFile, writePsdFile } } });
