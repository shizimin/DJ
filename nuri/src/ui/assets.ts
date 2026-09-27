// 素材パネル: CLIP STUDIO の素材 (.layer / 素材フォルダ / .clip / .sut) と画像を管理し、
// クリックでキャンバスに貼り付ける。

import { toast, type Editor } from "../core/editor";
import { deleteAsset, listAssets, newId, putAsset, type Asset } from "../io/library";
import { addImageLayer, clipToAsset, importMaterial, importMaterialFolder } from "../io/open";
import { h } from "./dom";

export function assetsPanel(editor: Editor, opts: { onBrushes: () => void; openFiles: (files: File[]) => Promise<void> }) {
  const grid = h("div", { class: "asset-grid" });
  const search = h("input", { class: "text", placeholder: "素材を検索" });
  const status = h("p", { class: "hint" });
  let assets: Asset[] = [];
  const urls: string[] = [];

  const render = () => {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const q = search.value.trim().toLowerCase();
    const shown = assets.filter((a) => !q || a.name.toLowerCase().includes(q));
    grid.replaceChildren(
      ...shown.map((a) => {
        const url = URL.createObjectURL(a.blob);
        urls.push(url);
        return h(
          "div",
          {
            class: "asset",
            title: `${a.name}\n${a.source ?? ""}\nクリックで新規レイヤーとして貼り付け`,
            onClick: () => addImageLayer(editor, a.blob, a.name).then(() => toast(`「${a.name}」を貼り付けました`, "ok")),
          },
          h("img", { src: url, alt: a.name, loading: "lazy", draggable: false }),
          h("span", {}, a.name),
          h(
            "button",
            {
              class: "del",
              title: "素材を削除",
              onClick: async (e: Event) => {
                e.stopPropagation();
                if (!confirm(`「${a.name}」を素材から削除しますか？`)) return;
                await deleteAsset(a.id);
                refresh();
              },
            },
            "✕",
          ),
        );
      }),
    );
    status.textContent = assets.length ? `${shown.length} / ${assets.length} 件` : "まだ素材がありません。";
  };
  search.addEventListener("input", render);

  async function refresh() {
    try {
      assets = await listAssets();
    } catch (e) {
      status.textContent = `素材を読み込めません: ${(e as Error).message}`;
      return;
    }
    render();
  }

  const addFiles = async (files: File[]) => {
    let n = 0;
    for (const f of files) {
      const lower = f.name.toLowerCase();
      try {
        if (lower.endsWith(".sut") || lower.endsWith(".sutg")) {
          await opts.openFiles([f]);
          continue;
        }
        if (lower.endsWith(".layer")) await importMaterial(f, f.name.replace(/\.layer$/i, ""), "CLIP STUDIO 素材");
        else if (lower.endsWith(".clip")) await clipToAsset(new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.clip$/i, ""));
        else if (f.type.startsWith("image/")) await putAsset({ id: newId(), name: f.name.replace(/\.[^.]+$/, ""), kind: "image", blob: f, source: "画像", added: Date.now() });
        else throw new Error("対応していない形式です");
        n++;
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, "error", 6000);
      }
    }
    if (n) toast(`${n} 件の素材を追加しました`, "ok");
    refresh();
  };

  const pickFolder = () => {
    const input = h("input", { type: "file", multiple: true });
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])].filter((f) => /\.layer$|catalog\.xml$/i.test(f.name));
      if (!files.length) return void toast("素材 (.layer) が見つかりませんでした。Material フォルダを選んでください", "error", 6000);
      toast(`素材を取り込んでいます… (${files.length} ファイル)`);
      const res = await importMaterialFolder(files, (done, total) => (status.textContent = `取り込み中… ${done} / ${total}`));
      toast(`${res.ok} 件の素材を取り込みました${res.failed.length ? ` (${res.failed.length} 件は形式未対応)` : ""}`, res.ok ? "ok" : "error", 6000);
      refresh();
    });
    input.click();
  };

  const pickFilesBtn = () => {
    const input = h("input", { type: "file", multiple: true, accept: ".layer,.clip,.sut,.sutg,image/*" });
    input.addEventListener("change", () => addFiles([...(input.files ?? [])]));
    input.click();
  };

  const drop = h("div", { class: "dropzone" }, "ここに .layer / .clip / .sut / 画像 をドロップ");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFiles([...(e.dataTransfer?.files ?? [])]);
  });

  const el = h(
    "section",
    { class: "panel assets-panel" },
    h("div", { class: "row" }, h("button", { onClick: pickFilesBtn }, "＋ ファイル"), h("button", { onClick: pickFolder }, "📁 CSP 素材フォルダ")),
    h(
      "details",
      { class: "hint" },
      h("summary", {}, "CLIP STUDIO の素材の場所 (Mac)"),
      h(
        "p",
        {},
        "ダウンロードした素材は次のフォルダにあります。「CSP 素材フォルダ」で Material フォルダ (または個別の素材フォルダ) を選ぶと、まとめて取り込めます。",
      ),
      h("code", {}, "~/Library/CELSYS/CLIPStudioCommon/Material"),
      h("p", {}, "選択画面で ⌘⇧G を押してパスを貼り付けると開けます。見つからない場合は「書類/CELSYS」の中も確認してください。ブラシは CSP のサブツールを「素材として登録」または書き出した .sut をドロップしてください。"),
    ),
    drop,
    search,
    status,
    grid,
  );
  refresh();
  return { el, refresh };
}
