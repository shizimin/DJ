// sql.js (SQLite の WebAssembly 版) の読み込み。必要になったときだけロードする。

import type { Database, SqlJsStatic, SqlValue } from "sql.js";

let locate: (file: string) => string = (f) => f;
let loading: Promise<SqlJsStatic> | null = null;

/** wasm ファイルの場所を設定する (ブラウザでは Vite の ?url、テストではファイルパス) */
export function setSqlWasmLocator(fn: (file: string) => string) {
  locate = fn;
}

export function getSql(): Promise<SqlJsStatic> {
  loading ??= import("sql.js").then((m) => (m.default ?? m)({ locateFile: locate }));
  return loading;
}

export type Row = Record<string, SqlValue>;

export function rows(db: Database, sql: string, params: SqlValue[] = []): Row[] {
  const st = db.prepare(sql);
  st.bind(params);
  const out: Row[] = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

export function tableExists(db: Database, name: string) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
}

export const num = (v: SqlValue | undefined, d = 0) => (typeof v === "number" ? v : v == null ? d : Number(v) || d);
export const blob = (v: SqlValue | undefined) => (v instanceof Uint8Array ? v : null);
export const str = (v: SqlValue | undefined) => (typeof v === "string" ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : v == null ? "" : String(v));
