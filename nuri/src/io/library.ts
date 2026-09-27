// 素材ライブラリとブラシ設定の保存 (IndexedDB / localStorage)。
// すべてこの Mac のブラウザ内に保存される。

import type { Brush } from "../core/brush";
import { createCanvas, ctx2d } from "../core/doc";
import type { Editor } from "../core/editor";

const DB_NAME = "nuri";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("brushes")) db.createObjectStore("brushes", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- 素材

export interface Asset {
  id: string;
  name: string;
  /** image: 画像素材 / clip: .clip ファイル由来 / tone: パターン */
  kind: "image" | "clip" | "pattern";
  blob: Blob;
  source?: string;
  added: number;
}

export const listAssets = async () => (await tx<Asset[]>("assets", "readonly", (s) => s.getAll())).sort((a, b) => b.added - a.added);
export const putAsset = (a: Asset) => tx("assets", "readwrite", (s) => s.put(a));
export const deleteAsset = (id: string) => tx("assets", "readwrite", (s) => s.delete(id));

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------- ブラシ

interface StoredBrush extends Omit<Brush, "tip"> {
  tipPng?: string;
  order: number;
}

function canvasFromDataUrl(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = createCanvas(img.width, img.height);
      ctx2d(c).drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = reject;
    img.src = url;
  });
}

const PREFS_KEY = "nuri.brush.prefs";
const BRUSH_FIELDS = ["size", "opacity", "flow", "hardness", "spacing", "pressureSize", "pressureOpacity", "minSize", "stabilizer", "rotate"] as const;

/** 組み込みブラシの設定は localStorage、読み込んだブラシ (.sut) は IndexedDB に保存 */
export async function saveBrushPrefs(editor: Editor) {
  const prefs: Record<string, Partial<Brush>> = {};
  for (const b of [...editor.brushes, ...editor.erasers]) {
    if (b.source) continue;
    prefs[b.id] = Object.fromEntries(BRUSH_FIELDS.map((k) => [k, b[k]]));
  }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ prefs, brushIndex: editor.brushIndex, eraserIndex: editor.eraserIndex, color: editor.color, recent: editor.recentColors }));
  } catch {
    /* 保存できない環境 */
  }
  const imported = editor.brushes.filter((b) => b.source);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("brushes", "readwrite");
    const s = t.objectStore("brushes");
    s.clear();
    imported.forEach((b, order) => {
      const { tip, ...rest } = b;
      const stored: StoredBrush = { ...rest, order, tipPng: tip?.dataUrl ?? tip?.canvas.toDataURL("image/png") };
      s.put(stored);
    });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function loadBrushPrefs(editor: Editor) {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const { prefs, brushIndex, eraserIndex, color, recent } = JSON.parse(raw);
      for (const b of [...editor.brushes, ...editor.erasers]) if (prefs?.[b.id]) Object.assign(b, prefs[b.id]);
      if (typeof color === "string") editor.color = color;
      if (Array.isArray(recent)) editor.recentColors = recent;
      editor.eraserIndex = Math.min(eraserIndex ?? 0, editor.erasers.length - 1);
      const stored = (await tx<StoredBrush[]>("brushes", "readonly", (s) => s.getAll())).sort((a, b) => a.order - b.order);
      for (const sb of stored) {
        const { tipPng, order: _order, ...rest } = sb;
        const brush: Brush = { ...rest };
        if (tipPng) brush.tip = { canvas: await canvasFromDataUrl(tipPng), dataUrl: tipPng };
        editor.brushes.push(brush);
      }
      editor.brushIndex = Math.min(brushIndex ?? 0, editor.brushes.length - 1);
    }
  } catch (e) {
    console.warn("ブラシ設定を読み込めませんでした", e);
  }
}
