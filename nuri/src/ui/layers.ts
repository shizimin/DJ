// レイヤーパネル: 表示切替・サムネイル・名前変更・並べ替え・合成モード・不透明度・クリッピング。

import { BLEND_MODES, createCanvas, ctx2d, type BlendMode, type Layer } from "../core/doc";
import type { Editor } from "../core/editor";
import { addLayerCommand, moveLayerCommand, PixelSnapshot, propCommand, removeLayerCommand } from "../core/history";
import { h, select, slider } from "./dom";

const THUMB = 40;

function drawThumb(layer: Layer, c: HTMLCanvasElement) {
  const g = c.getContext("2d")!;
  const s = Math.min(THUMB / layer.canvas.width, THUMB / layer.canvas.height);
  const w = layer.canvas.width * s;
  const hh = layer.canvas.height * s;
  g.clearRect(0, 0, THUMB, THUMB);
  g.fillStyle = "#fff";
  g.fillRect((THUMB - w) / 2, (THUMB - hh) / 2, w, hh);
  g.drawImage(layer.canvas, (THUMB - w) / 2, (THUMB - hh) / 2, w, hh);
}

export function layersPanel(editor: Editor) {
  const list = h("div", { class: "layer-list" });
  const thumbs = new Map<number, { canvas: HTMLCanvasElement; version: number }>();
  let dragId = 0;

  const blendSel = select<BlendMode>("normal", BLEND_MODES, (v) => {
    const l = editor.doc.active;
    if (l) editor.history.run(propCommand(editor.doc, l, "blend", v));
  });
  let opacityBefore = 1;
  const opacity = slider({
    label: "不透明度",
    min: 0,
    max: 100,
    value: 100,
    format: (v) => `${v}%`,
    onInput: (v) => {
      const l = editor.doc.active;
      if (!l) return;
      l.opacity = v / 100;
      editor.doc.emit("pixels");
    },
    onCommit: (v) => {
      const l = editor.doc.active;
      if (l) editor.history.push(propCommand(editor.doc, l, "opacity", v / 100, opacityBefore));
    },
  });
  opacity.addEventListener("pointerdown", () => (opacityBefore = editor.doc.active?.opacity ?? 1));

  const toggle = (label: string, title: string, key: "clip" | "lockAlpha" | "locked") => {
    const b = h(
      "button",
      {
        class: "toggle",
        title,
        onClick: () => {
          const l = editor.doc.active;
          if (l) editor.history.run(propCommand(editor.doc, l, key, !l[key]));
        },
      },
      label,
    );
    return Object.assign(b, { key });
  };
  const toggles = [
    toggle("クリップ", "下のレイヤーでクリッピング", "clip"),
    toggle("透明保護", "透明ピクセルをロック", "lockAlpha"),
    toggle("🔒", "レイヤーをロック", "locked"),
  ];

  const actions = {
    add() {
      const d = editor.doc;
      editor.history.run(addLayerCommand(d, d.newLayer()));
    },
    duplicate() {
      const d = editor.doc;
      const src = d.active;
      if (!src) return;
      const l = d.newLayer(`${src.name} のコピー`);
      l.ctx.drawImage(src.canvas, 0, 0);
      Object.assign(l, { opacity: src.opacity, blend: src.blend, clip: src.clip, visible: src.visible });
      editor.history.run(addLayerCommand(d, l, d.indexOf(src) + 1));
    },
    remove() {
      const d = editor.doc;
      if (d.active && d.layers.length > 1) editor.history.run(removeLayerCommand(d, d.active));
    },
    mergeDown() {
      const d = editor.doc;
      const top = d.active;
      if (!top) return;
      const i = d.indexOf(top);
      if (i <= 0) return;
      const below = d.layers[i - 1];
      const snap = new PixelSnapshot(d, below);
      // 2 枚だけを合成した結果を下のレイヤーに書き込む
      const tmp = createCanvas(d.width, d.height);
      const saved = d.layers;
      const belowVisible = below.visible;
      below.visible = true;
      d.layers = [below, top];
      d.compositeRange(ctx2d(tmp), 0, 2);
      d.layers = saved;
      below.visible = belowVisible;
      below.ctx.globalCompositeOperation = "copy";
      const bo = below.opacity;
      below.ctx.drawImage(tmp, 0, 0);
      below.ctx.globalCompositeOperation = "source-over";
      below.opacity = 1;
      below.touch();
      const pixels = snap.commit("下のレイヤーに結合")!;
      const removal = removeLayerCommand(d, top);
      removal.redo();
      editor.history.push({
        label: "下のレイヤーに結合",
        undo() {
          removal.undo();
          pixels.undo();
          below.opacity = bo;
          d.emit("layers");
        },
        redo() {
          pixels.redo();
          below.opacity = 1;
          removal.redo();
        },
      });
      d.activeId = below.id;
      d.emit("layers");
    },
    up() {
      const d = editor.doc;
      const l = d.active;
      if (l && d.indexOf(l) < d.layers.length - 1) editor.history.run(moveLayerCommand(d, l, d.indexOf(l) + 1));
    },
    down() {
      const d = editor.doc;
      const l = d.active;
      if (l && d.indexOf(l) > 0) editor.history.run(moveLayerCommand(d, l, d.indexOf(l) - 1));
    },
  };

  const row = (layer: Layer) => {
    const d = editor.doc;
    let t = thumbs.get(layer.id);
    if (!t) {
      t = { canvas: h("canvas", { width: THUMB, height: THUMB, class: "thumb" }), version: -1 };
      thumbs.set(layer.id, t);
    }
    if (t.version !== layer.version) {
      drawThumb(layer, t.canvas);
      t.version = layer.version;
    }
    const name = h("span", { class: "name", title: "ダブルクリックで名前を変更" }, layer.name);
    name.addEventListener("dblclick", () => {
      const input = h("input", { value: layer.name, class: "rename" });
      name.replaceWith(input);
      input.focus();
      input.select();
      const done = () => {
        if (input.value && input.value !== layer.name) editor.history.run(propCommand(d, layer, "name", input.value));
        else d.emit("layers");
      };
      input.addEventListener("blur", done);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.value = layer.name;
          input.blur();
        }
      });
    });
    const el = h(
      "div",
      {
        class: `layer${layer.id === d.activeId ? " active" : ""}${layer.clip ? " clipped" : ""}`,
        draggable: true,
        onClick: () => {
          d.activeId = layer.id;
          d.emit("layers");
        },
        onDragstart: () => (dragId = layer.id),
        onDragover: (e: DragEvent) => {
          e.preventDefault();
          el.classList.add("drop");
        },
        onDragleave: () => el.classList.remove("drop"),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          el.classList.remove("drop");
          const src = d.layers.find((l) => l.id === dragId);
          if (src && src !== layer) editor.history.run(moveLayerCommand(d, src, d.indexOf(layer)));
        },
      },
      h(
        "button",
        {
          class: `eye${layer.visible ? "" : " off"}`,
          title: "表示/非表示",
          onClick: (e: Event) => {
            e.stopPropagation();
            editor.history.run(propCommand(d, layer, "visible", !layer.visible));
          },
        },
        layer.visible ? "●" : "○",
      ),
      t.canvas,
      h(
        "div",
        { class: "meta" },
        name,
        h(
          "span",
          { class: "sub" },
          `${BLEND_MODES[layer.blend]} ${Math.round(layer.opacity * 100)}%`,
          layer.locked ? " 🔒" : "",
          layer.lockAlpha ? " ▦" : "",
        ),
      ),
    );
    return el;
  };

  let pending = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const d = editor.doc;
      list.replaceChildren(...[...d.layers].reverse().map(row));
      const a = d.active;
      if (a) {
        blendSel.value = a.blend;
        opacity.set(Math.round(a.opacity * 100));
        toggles.forEach((t) => t.classList.toggle("on", !!a[t.key]));
      }
    });
  };
  editor.onChange(render);
  // ピクセル変更時のサムネイル更新は間引く
  let thumbTimer = 0;
  const scheduleThumbs = () => {
    clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(render, 250);
  };
  let lastDoc = editor.doc;
  let unhook = lastDoc.on("pixels", scheduleThumbs);
  editor.onChange(() => {
    if (editor.doc === lastDoc) return;
    lastDoc = editor.doc;
    thumbs.clear();
    unhook();
    unhook = lastDoc.on("pixels", scheduleThumbs);
  });
  render();

  const el = h(
    "section",
    { class: "panel layers-panel" },
    h("div", { class: "layer-props" }, blendSel, opacity, h("div", { class: "toggles" }, ...toggles)),
    list,
    h(
      "div",
      { class: "layer-actions" },
      h("button", { title: "新規レイヤー (⇧⌘N)", onClick: actions.add }, "＋"),
      h("button", { title: "複製", onClick: actions.duplicate }, "⧉"),
      h("button", { title: "下のレイヤーに結合 (⌘E)", onClick: actions.mergeDown }, "⤓"),
      h("button", { title: "上へ", onClick: actions.up }, "▲"),
      h("button", { title: "下へ", onClick: actions.down }, "▼"),
      h("button", { title: "削除", onClick: actions.remove }, "🗑"),
    ),
  );
  return { el, actions };
}
