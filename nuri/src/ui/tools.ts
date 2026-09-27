// 左端のツールバーと、ブラシ一覧・ツール設定パネル。

import type { Brush } from "../core/brush";
import { TOOLS, type Editor } from "../core/editor";
import { h, slider } from "./dom";

export function toolbar(editor: Editor) {
  const buttons = TOOLS.map((t) =>
    h("button", { class: "tool", title: `${t.label} (${t.key.toUpperCase()})`, onClick: () => editor.setTool(t.id) }, t.icon),
  );
  const sync = () => TOOLS.forEach((t, i) => buttons[i].classList.toggle("active", editor.tool === t.id));
  editor.onChange(sync);
  sync();
  return h("nav", { class: "toolbar" }, ...buttons);
}

function brushSettings(editor: Editor, brush: Brush, onChange: () => void) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const set = <K extends keyof Brush>(k: K, v: Brush[K]) => {
    brush[k] = v;
    onChange();
  };
  const check = (label: string, key: "pressureSize" | "pressureOpacity" | "rotate") =>
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: !!brush[key], onChange: (e: Event) => set(key, (e.target as HTMLInputElement).checked) }),
      label,
    );
  const sizeSlider = slider({ label: "サイズ", min: 1, max: 500, value: brush.size, format: (v) => `${v}px`, onInput: (v) => set("size", v) });
  editor.onChange(() => sizeSlider.set(brush.size));
  return h(
    "div",
    { class: "brush-settings" },
    sizeSlider,
    slider({ label: "不透明度", min: 0.05, max: 1, step: 0.01, value: brush.opacity, format: pct, onInput: (v) => set("opacity", v) }),
    slider({ label: "濃さ", min: 0.02, max: 1, step: 0.01, value: brush.flow, format: pct, onInput: (v) => set("flow", v) }),
    brush.tip ? null : slider({ label: "硬さ", min: 0, max: 1, step: 0.01, value: brush.hardness, format: pct, onInput: (v) => set("hardness", v) }),
    slider({ label: "間隔", min: 0.02, max: 1.5, step: 0.01, value: brush.spacing, format: pct, onInput: (v) => set("spacing", v) }),
    slider({ label: "手ブレ補正", min: 0, max: 20, value: brush.stabilizer, onInput: (v) => set("stabilizer", v) }),
    h("div", { class: "checks" }, check("筆圧でサイズ", "pressureSize"), check("筆圧で濃さ", "pressureOpacity"), brush.tip ? check("進行方向に回転", "rotate") : null),
    slider({ label: "最小サイズ", min: 0, max: 1, step: 0.01, value: brush.minSize, format: pct, onInput: (v) => set("minSize", v) }),
  );
}

function tipPreview(brush: Brush) {
  const c = h("canvas", { width: 28, height: 28, class: "tip" });
  const g = c.getContext("2d")!;
  if (brush.tip) {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 28, 28);
    const t = document.createElement("canvas");
    t.width = t.height = 26;
    const tg = t.getContext("2d")!;
    tg.drawImage(brush.tip.canvas, 0, 0, 26, 26);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#222";
    tg.fillRect(0, 0, 26, 26);
    g.drawImage(t, 1, 1);
  } else {
    const r = 11;
    const grad = g.createRadialGradient(14, 14, 0, 14, 14, r);
    grad.addColorStop(0, "#222");
    grad.addColorStop(Math.min(0.99, brush.hardness), "#222");
    grad.addColorStop(1, "rgba(34,34,34,0)");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 28, 28);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(14, 14, r, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

export function subToolPanel(editor: Editor, persist: () => void) {
  const root = h("section", { class: "panel subtool" });
  let lastKey = "";
  const render = () => {
    const key = `${editor.tool}:${editor.brushIndex}:${editor.eraserIndex}:${editor.brushes.length}`;
    if (key === lastKey) return;
    lastKey = key;
    const tool = editor.tool;
    if (tool === "brush" || tool === "eraser") {
      const list = tool === "brush" ? editor.brushes : editor.erasers;
      const idx = tool === "brush" ? editor.brushIndex : editor.eraserIndex;
      root.replaceChildren(
        h("h3", {}, tool === "brush" ? "ブラシ" : "消しゴム"),
        h(
          "div",
          { class: "brush-list" },
          ...list.map((b, i) =>
            h(
              "div",
              {
                class: `brush-item${i === idx ? " active" : ""}`,
                title: b.source ? `${b.name} (${b.source})` : b.name,
                onClick: () => {
                  if (tool === "brush") editor.brushIndex = i;
                  else editor.eraserIndex = i;
                  editor.changed();
                },
              },
              tipPreview(b),
              h("span", {}, b.name),
              b.source && tool === "brush"
                ? h(
                    "button",
                    {
                      class: "icon small",
                      title: "削除",
                      onClick: (e: Event) => {
                        e.stopPropagation();
                        editor.brushes.splice(i, 1);
                        editor.brushIndex = Math.min(editor.brushIndex, editor.brushes.length - 1);
                        persist();
                        editor.changed();
                      },
                    },
                    "✕",
                  )
                : null,
            ),
          ),
        ),
        brushSettings(editor, list[idx], () => {
          persist();
          editor.requestRender();
        }),
      );
    } else if (tool === "fill" || tool === "wand") {
      root.replaceChildren(
        h("h3", {}, tool === "fill" ? "塗りつぶし" : "自動選択"),
        slider({ label: "許容誤差", min: 0, max: 128, value: editor.fill.tolerance, onInput: (v) => (editor.fill.tolerance = v) }),
        ...(tool === "fill" ? [slider({ label: "隙間を広げる", min: 0, max: 6, value: editor.fill.gap, format: (v) => `${v}px`, onInput: (v) => (editor.fill.gap = v) })] : []),
        h(
          "label",
          { class: "check" },
          h("input", { type: "checkbox", checked: editor.fill.allLayers, onChange: (e: Event) => (editor.fill.allLayers = (e.target as HTMLInputElement).checked) }),
          "他レイヤーを参照",
        ),
      );
    } else {
      const tips: Record<string, string> = {
        picker: "クリックした場所の色を取得します。ペン使用中は Option+クリックでも取得できます。",
        "select-rect": "ドラッグで矩形選択。クリックで解除。⌘A 全選択 / ⌘D 解除 / ⇧⌘I 反転",
        "select-lasso": "ドラッグで自由な形に選択します。選択範囲は AI の「描き直し」範囲にも使えます。",
        move: "ドラッグでアクティブなレイヤーを移動します。",
        hand: "ドラッグで表示位置を移動。Space を押しながらでも使えます。",
      };
      root.replaceChildren(h("h3", {}, TOOLS.find((t) => t.id === tool)?.label ?? ""), h("p", { class: "hint" }, tips[tool] ?? ""));
    }
  };
  editor.onChange(render);
  render();
  return Object.assign(root, { refresh: () => ((lastKey = ""), render()) });
}
