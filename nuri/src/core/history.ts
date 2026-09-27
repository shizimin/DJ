// 取り消し / やり直し。

import { createCanvas, ctx2d, type Doc, type Layer } from "./doc";

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

/** レイヤー追加を記録するコマンド */
export function addLayerCommand(doc: Doc, layer: Layer, index?: number): Command {
  let at = index;
  return {
    label: "レイヤー追加",
    redo() {
      doc.insert(layer, at);
      at = doc.indexOf(layer);
    },
    undo() {
      doc.remove(layer);
    },
  };
}

export function removeLayerCommand(doc: Doc, layer: Layer): Command {
  const at = doc.indexOf(layer);
  return {
    label: "レイヤー削除",
    redo: () => doc.remove(layer),
    undo: () => doc.insert(layer, at),
  };
}

export function moveLayerCommand(doc: Doc, layer: Layer, to: number): Command {
  const from = doc.indexOf(layer);
  return {
    label: "レイヤー移動",
    redo: () => doc.move(layer, to),
    undo: () => doc.move(layer, from),
  };
}

/** レイヤープロパティ変更 (不透明度・合成モード等) */
export function propCommand<K extends keyof Layer>(doc: Doc, layer: Layer, key: K, value: Layer[K], before?: Layer[K]): Command {
  const old = before === undefined ? layer[key] : before;
  return {
    label: "レイヤー設定",
    redo() {
      layer[key] = value;
      doc.emit("layers");
    },
    undo() {
      layer[key] = old;
      doc.emit("layers");
    },
  };
}
