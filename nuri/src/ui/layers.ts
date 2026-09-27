// レイヤーパネル: フォルダの入れ子・開閉・ドラッグでの並べ替え/フォルダへの出し入れ・
// 表示切替・サムネイル・名前変更・合成モード・不透明度・クリッピング・結合。

import { BLEND_MODES, Group, type GroupBlend, type Layer, type Node } from "../core/doc";
import type { Editor } from "../core/editor";
import { addLayerCommand, moveLayerCommand, PixelSnapshot, propCommand, removeLayerCommand, type Command } from "../core/history";
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

/** 複数のコマンドを 1 回の取り消し単位にまとめる */
function batch(label: string, cmds: Command[]): Command {
  return {
    label,
    redo: () => cmds.forEach((c) => c.redo()),
    undo: () => [...cmds].reverse().forEach((c) => c.undo()),
  };
}

const BLEND_OPTIONS: [GroupBlend, string][] = Object.entries(BLEND_MODES) as [GroupBlend, string][];

export function layersPanel(editor: Editor) {
  const list = h("div", { class: "layer-list" });
  const thumbs = new Map<number, { canvas: HTMLCanvasElement; version: number }>();
  let dragId = 0;

  const blendSel = select<GroupBlend>("normal", BLEND_OPTIONS, (v) => {
    const n = editor.doc.activeNode;
    if (!n) return;
    if (n.kind === "layer" && v !== "pass-through") editor.history.run(propCommand(editor.doc, n, "blend", v));
    if (n.kind === "group") editor.history.run(propCommand(editor.doc, n, "blend", v));
  });
  const passOption = h("option", { value: "pass-through" }, "通過");
  blendSel.prepend(passOption);

  let opacityBefore = 1;
  const opacity = slider({
    label: "不透明度",
    min: 0,
    max: 100,
    value: 100,
    format: (v) => `${v}%`,
    onInput: (v) => {
      const n = editor.doc.activeNode;
      if (!n) return;
      n.opacity = v / 100;
      editor.doc.emit("pixels");
    },
    onCommit: (v) => {
      const n = editor.doc.activeNode;
      if (n) editor.history.push(propCommand(editor.doc, n, "opacity", v / 100, opacityBefore));
    },
  });
  opacity.addEventListener("pointerdown", () => (opacityBefore = editor.doc.activeNode?.opacity ?? 1));

  const toggle = (label: string, title: string, key: "clip" | "lockAlpha" | "locked") => {
    const b = h(
      "button",
      {
        class: "toggle",
        title,
        onClick: () => {
          const n = editor.doc.activeNode;
          if (!n) return;
          if (key === "lockAlpha") {
            if (n.kind === "layer") editor.history.run(propCommand(editor.doc, n, "lockAlpha", !n.lockAlpha));
          } else editor.history.run(propCommand(editor.doc, n as Layer, key, !n[key]));
        },
      },
      label,
    );
    return Object.assign(b, { key });
  };
  const toggles = [
    toggle("クリップ", "下のレイヤーでクリッピング", "clip"),
    toggle("透明保護", "透明ピクセルをロック", "lockAlpha"),
    toggle("🔒", "ロック", "locked"),
  ];

  const actions = {
    add() {
      const d = editor.doc;
      editor.history.run(addLayerCommand(d, d.newLayer()));
    },
    addFolder() {
      const d = editor.doc;
      editor.history.run(addLayerCommand(d, d.newGroup()));
    },
    /** アクティブなレイヤー (フォルダ) を新しいフォルダに入れる */
    group() {
      const d = editor.doc;
      const n = d.activeNode;
      if (!n) return;
      const parent = d.parentOf(n) ?? d.root;
      const folder = d.newGroup();
      const at = parent.children.indexOf(n);
      const add = addLayerCommand(d, folder, at + 1, parent);
      add.redo();
      const move = moveLayerCommand(d, n, 0, folder);
      move.redo();
      d.activeId = folder.id;
      editor.history.push(batch("フォルダにまとめる", [add, move]));
      d.emit("layers");
    },
    duplicate() {
      const d = editor.doc;
      const src = d.activeNode;
      if (!src) return;
      const clone = (n: Node): Node => {
        if (n.kind === "layer") {
          const l = d.newLayer(n.name);
          l.ctx.drawImage(n.canvas, 0, 0);
          Object.assign(l, { opacity: n.opacity, blend: n.blend, clip: n.clip, visible: n.visible, lockAlpha: n.lockAlpha });
          return l;
        }
        const g = new Group(n.name);
        Object.assign(g, { opacity: n.opacity, blend: n.blend, visible: n.visible, open: n.open });
        g.children = n.children.map(clone);
        return g;
      };
      const copy = clone(src);
      copy.name = `${src.name} のコピー`;
      const parent = d.parentOf(src) ?? d.root;
      editor.history.run(addLayerCommand(d, copy, parent.children.indexOf(src) + 1, parent));
    },
    remove() {
      const d = editor.doc;
      const n = d.activeNode;
      if (!n) return;
      if (n.kind === "layer" && d.layers.length <= 1) return;
      if (n.kind === "group" && d.layers.every((l) => d.isInside(l, n))) return;
      editor.history.run(removeLayerCommand(d, n));
    },
    /** 下のレイヤーに結合 / フォルダを 1 枚のレイヤーに統合 */
    mergeDown() {
      const d = editor.doc;
      const top = d.activeNode;
      if (!top) return;
      const parent = d.parentOf(top) ?? d.root;
      const i = parent.children.indexOf(top);
      if (top.kind === "group") {
        const merged = d.newLayer(top.name);
        merged.ctx.drawImage(d.renderNode(top), 0, 0);
        Object.assign(merged, { opacity: top.opacity, blend: top.blend === "pass-through" ? "normal" : top.blend, visible: top.visible, clip: top.clip });
        const rm = removeLayerCommand(d, top);
        const add = addLayerCommand(d, merged, i, parent);
        editor.history.run(batch("フォルダを統合", [rm, add]));
        return;
      }
      const below = parent.children[i - 1];
      if (!below || below.kind !== "layer") return;
      const snap = new PixelSnapshot(d, below);
      // 2 枚だけを合成した結果を下のレイヤーに書き込む
      const tmpGroup = new Group("tmp");
      tmpGroup.children = [below, top];
      const belowVisible = below.visible;
      below.visible = true;
      const merged = d.renderNode(tmpGroup);
      below.visible = belowVisible;
      const bo = below.opacity;
      below.ctx.globalCompositeOperation = "copy";
      below.ctx.drawImage(merged, 0, 0);
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
      const n = d.activeNode;
      if (!n) return;
      const parent = d.parentOf(n) ?? d.root;
      const i = parent.children.indexOf(n);
      if (i < parent.children.length - 1) editor.history.run(moveLayerCommand(d, n, i + 1));
      else if (parent !== d.root) {
        // フォルダの一番上からさらに上へ → フォルダの外に出す
        const gp = d.parentOf(parent) ?? d.root;
        editor.history.run(moveLayerCommand(d, n, gp.children.indexOf(parent) + 1, gp));
      }
    },
    down() {
      const d = editor.doc;
      const n = d.activeNode;
      if (!n) return;
      const parent = d.parentOf(n) ?? d.root;
      const i = parent.children.indexOf(n);
      if (i > 0) editor.history.run(moveLayerCommand(d, n, i - 1));
      else if (parent !== d.root) {
        const gp = d.parentOf(parent) ?? d.root;
        editor.history.run(moveLayerCommand(d, n, gp.children.indexOf(parent), gp));
      }
    },
  };

  /** ドロップ位置: 行の上 1/4 = 上へ、下 1/4 = 下へ、フォルダの中央 = フォルダの中へ */
  const dropZone = (e: DragEvent, el: HTMLElement, node: Node): "above" | "below" | "into" => {
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (node.kind === "group" && y > 0.25 && y < 0.75) return "into";
    return y < 0.5 ? "above" : "below";
  };

  const row = (node: Node, depth: number) => {
    const d = editor.doc;
    const isGroup = node.kind === "group";
    let icon: HTMLElement;
    if (isGroup) {
      icon = h(
        "button",
        {
          class: "folder-toggle",
          title: node.open ? "閉じる" : "開く",
          onClick: (e: Event) => {
            e.stopPropagation();
            node.open = !node.open;
            render();
          },
        },
        node.open ? "▾📂" : "▸📁",
      );
    } else {
      let t = thumbs.get(node.id);
      if (!t) {
        t = { canvas: h("canvas", { width: THUMB, height: THUMB, class: "thumb" }), version: -1 };
        thumbs.set(node.id, t);
      }
      if (t.version !== node.version) {
        drawThumb(node, t.canvas);
        t.version = node.version;
      }
      icon = t.canvas;
    }
    const name = h("span", { class: "name", title: "ダブルクリックで名前を変更" }, node.name);
    name.addEventListener("dblclick", () => {
      const input = h("input", { value: node.name, class: "rename" });
      name.replaceWith(input);
      input.focus();
      input.select();
      const done = () => {
        if (input.value && input.value !== node.name) editor.history.run(propCommand(d, node, "name", input.value));
        else d.emit("layers");
      };
      input.addEventListener("blur", done);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.value = node.name;
          input.blur();
        }
      });
    });
    const blendLabel = node.blend === "pass-through" ? "通過" : BLEND_MODES[node.blend];
    const el = h(
      "div",
      {
        class: `layer${node.id === d.activeId ? " active" : ""}${node.clip ? " clipped" : ""}${isGroup ? " folder" : ""}${d.isVisible(node) ? "" : " hidden-layer"}`,
        style: `padding-left:${4 + depth * 14}px`,
        draggable: true,
        onClick: () => {
          d.activeId = node.id;
          d.emit("layers");
        },
        onDragstart: (e: DragEvent) => {
          dragId = node.id;
          e.dataTransfer?.setData("text/plain", String(node.id));
        },
        onDragover: (e: DragEvent) => {
          e.preventDefault();
          el.dataset.drop = dropZone(e, el, node);
        },
        onDragleave: () => delete el.dataset.drop,
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const zone = dropZone(e, el, node);
          delete el.dataset.drop;
          const src = d.find(dragId);
          if (!src || src === node) return;
          if (src.kind === "group" && (node === src || d.isInside(node, src))) return;
          if (zone === "into" && node.kind === "group") {
            editor.history.run(moveLayerCommand(d, src, node.children.length, node));
            node.open = true;
            return;
          }
          const parent = d.parentOf(node) ?? d.root;
          const srcParent = d.parentOf(src);
          let at = parent.children.indexOf(node) + (zone === "above" ? 1 : 0);
          // 同じフォルダ内で下から上へ動かすときは、取り除いた分だけ位置がずれる
          if (srcParent === parent && parent.children.indexOf(src) < at) at--;
          editor.history.run(moveLayerCommand(d, src, at, parent));
        },
      },
      h(
        "button",
        {
          class: `eye${node.visible ? "" : " off"}`,
          title: "表示/非表示",
          onClick: (e: Event) => {
            e.stopPropagation();
            editor.history.run(propCommand(d, node, "visible", !node.visible));
          },
        },
        node.visible ? "●" : "○",
      ),
      icon,
      h(
        "div",
        { class: "meta" },
        name,
        h("span", { class: "sub" }, `${blendLabel} ${Math.round(node.opacity * 100)}%`, node.locked ? " 🔒" : "", node.kind === "layer" && node.lockAlpha ? " ▦" : ""),
      ),
    );
    return el;
  };

  let pending = false;
  function render() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const d = editor.doc;
      const rows: HTMLElement[] = [];
      const walk = (g: Group, depth: number) => {
        // 上のレイヤーから表示する
        for (let i = g.children.length - 1; i >= 0; i--) {
          const n = g.children[i];
          rows.push(row(n, depth));
          if (n.kind === "group" && n.open) walk(n, depth + 1);
        }
      };
      walk(d.root, 0);
      list.replaceChildren(...rows);
      const a = d.activeNode;
      if (a) {
        passOption.disabled = a.kind === "layer";
        blendSel.value = a.blend;
        opacity.set(Math.round(a.opacity * 100));
        toggles.forEach((t) => {
          const on = t.key === "lockAlpha" ? a.kind === "layer" && a.lockAlpha : !!a[t.key];
          t.classList.toggle("on", on);
          t.disabled = t.key === "lockAlpha" && a.kind === "group";
        });
        mergeBtn.title = a.kind === "group" ? "フォルダを 1 枚のレイヤーに統合 (⌘E)" : "下のレイヤーに結合 (⌘E)";
      }
    });
  }
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

  // リストの空いている所にドロップ → 一番上 (root) へ
  list.addEventListener("dragover", (e) => e.preventDefault());
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const d = editor.doc;
    const src = d.find(dragId);
    if (src) editor.history.run(moveLayerCommand(d, src, d.root.children.length, d.root));
  });

  const mergeBtn = h("button", { title: "下のレイヤーに結合 (⌘E)", onClick: actions.mergeDown }, "⤓");
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
      h("button", { title: "新規フォルダ", onClick: actions.addFolder }, "📁"),
      h("button", { title: "複製", onClick: actions.duplicate }, "⧉"),
      mergeBtn,
      h("button", { title: "上へ", onClick: actions.up }, "▲"),
      h("button", { title: "下へ", onClick: actions.down }, "▼"),
      h("button", { title: "削除", onClick: actions.remove }, "🗑"),
    ),
  );
  return { el, actions };
}
