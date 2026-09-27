// 取り消し / やり直し。

import { createCanvas, ctx2d, type Doc, type Group, type Layer, type Node } from "./doc";

export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  onChange = () => {};

  constructor(private limit = 60) {}

  /** 実行済みのコマンドを記録する */
  push(cmd: Command) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange();
  }

  /** 実行して記録する */
  run(cmd: Command) {
    cmd.redo();
    this.push(cmd);
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.onChange();
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.onChange();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}

/**
 * レイヤーのピクセル変更を記録するためのスナップショット。
 * begin() で変更前をコピーし、commit() で変更範囲だけを保存する。
 */
export class PixelSnapshot {
  private before: HTMLCanvasElement;

  constructor(
    private doc: Doc,
    private layer: Layer,
  ) {
    this.before = createCanvas(layer.canvas.width, layer.canvas.height);
    ctx2d(this.before).drawImage(layer.canvas, 0, 0);
  }

  /** rect を省略するとレイヤー全体 */
  commit(label: string, rect?: { x: number; y: number; w: number; h: number }): Command | null {
    const { layer, doc } = this;
    const W = layer.canvas.width;
    const H = layer.canvas.height;
    let x = 0, y = 0, w = W, h = H;
    if (rect) {
      x = Math.max(0, Math.floor(rect.x));
      y = Math.max(0, Math.floor(rect.y));
      w = Math.min(W, Math.ceil(rect.x + rect.w)) - x;
      h = Math.min(H, Math.ceil(rect.y + rect.h)) - y;
    }
    if (w <= 0 || h <= 0) return null;
    const before = ctx2d(this.before).getImageData(x, y, w, h);
    const after = layer.ctx.getImageData(x, y, w, h);
    const apply = (img: ImageData) => {
      layer.ctx.putImageData(img, x, y);
      layer.touch();
      doc.emit("pixels");
    };
    return { label, undo: () => apply(before), redo: () => apply(after) };
  }
}

/** レイヤー (フォルダ) 追加を記録するコマンド。parent 省略時はアクティブの上 */
export function addLayerCommand(doc: Doc, node: Node, index?: number, parent?: Group): Command {
  let slot: { parent: Group; index: number } | null = parent ? { parent, index: index ?? parent.children.length } : index !== undefined ? { parent: doc.root, index } : null;
  return {
    label: node.kind === "group" ? "フォルダ追加" : "レイヤー追加",
    redo() {
      slot ??= doc.defaultSlot();
      doc.insert(node, slot.index, slot.parent);
    },
    undo() {
      doc.remove(node);
    },
  };
}

export function removeLayerCommand(doc: Doc, node: Node): Command {
  const parent = doc.parentOf(node) ?? doc.root;
  const at = parent.children.indexOf(node);
  return {
    label: "レイヤー削除",
    redo: () => doc.remove(node),
    undo: () => doc.insert(node, at, parent),
  };
}

export function moveLayerCommand(doc: Doc, node: Node, to: number, toParent?: Group): Command {
  const fromParent = doc.parentOf(node) ?? doc.root;
  const from = fromParent.children.indexOf(node);
  const target = toParent ?? fromParent;
  return {
    label: "レイヤー移動",
    redo: () => doc.move(node, to, target),
    undo: () => doc.move(node, from, fromParent),
  };
}

/** レイヤー / フォルダのプロパティ変更 (不透明度・合成モード等) */
export function propCommand<T extends Node, K extends keyof T>(doc: Doc, node: T, key: K, value: T[K], before?: T[K]): Command {
  const old = before === undefined ? node[key] : before;
  return {
    label: "レイヤー設定",
    redo() {
      node[key] = value;
      doc.emit("layers");
    },
    undo() {
      node[key] = old;
      doc.emit("layers");
    },
  };
}
