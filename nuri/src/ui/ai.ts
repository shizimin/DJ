// AI パネル: 背景生成 / 写真の線画化 / 描き直し / 設定 と、実行中ジョブの一覧。

import { AiJobs, localLineArt } from "../ai/features";
import { GEMINI_MODELS, OPENAI_MODELS, PROVIDER_LABEL, saveSettings, type AiSettings, type ProviderId } from "../ai/providers";
import type { Editor } from "../core/editor";
import { toast } from "../core/editor";
import { addLayerCommand, propCommand } from "../core/history";
import { DEFAULT_LINEART, type LineArtOptions } from "../image/pixels";
import { h, pickFiles, select, slider } from "./dom";

const STYLES: [string, string][] = [
  ["", "おまかせ (絵に合わせる)"],
  ["anime background art, cel-shaded, vivid", "アニメ背景"],
  ["soft watercolor", "水彩"],
  ["painterly, thick brush strokes", "厚塗り"],
  ["photorealistic", "写実的"],
  ["black-and-white manga background with screentone", "漫画 (白黒・トーン)"],
  ["pixel art", "ドット絵"],
];

const SCENES = ["放課後の教室", "夕暮れの街並み", "木漏れ日の森", "青空と入道雲", "散らかった部屋", "おしゃれなカフェ", "ファンタジーの城", "ネオンの夜景"];

function textarea(placeholder: string, rows = 3) {
  return h("textarea", { placeholder, rows, class: "prompt" });
}

function segmented<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void) {
  const wrap = h("div", { class: "segmented" });
  const render = (cur: T) =>
    wrap.replaceChildren(
      ...options.map(([v, label]) =>
        h(
          "button",
          {
            class: v === cur ? "on" : "",
            onClick: () => {
              render(v);
              onChange(v);
            },
          },
          label,
        ),
      ),
    );
  render(value);
  return wrap;
}

export function aiPanel(editor: Editor, settings: AiSettings, jobs: AiJobs) {
  const persist = () => saveSettings(settings);
  const needsKey = () => {
    const key = settings.provider === "openai" ? settings.openaiKey : settings.geminiKey;
    if (!key) {
      toast(`${PROVIDER_LABEL[settings.provider]} の API キーを「設定」タブで入力してください`, "error");
      showTab("settings");
      return true;
    }
    return false;
  };
  const guard = (fn: () => Promise<void>) => () => {
    if (needsKey()) return;
    fn().catch((e) => toast((e as Error).message, "error"));
    toast("AI に送信しました。生成中も描き続けられます", "ok");
  };

  // ---------------------------------------------------------- 背景生成
  let bgMode: "behind" | "only" = "behind";
  const bgText = textarea("例: 夕暮れの教室、窓から差し込むオレンジの光");
  const bgStyle = select("", STYLES, () => {});
  const bgTab = h(
    "div",
    { class: "tab-body" },
    segmented<"behind" | "only">(
      "behind",
      [
        ["behind", "キャラの後ろに描く"],
        ["only", "背景だけ生成"],
      ],
      (v) => (bgMode = v),
    ),
    h("p", { class: "hint" }, "「キャラの後ろに描く」は今の絵を AI に見せて、構図・光・画風を合わせた背景を作ります。結果は用紙のすぐ上に新規レイヤーとして入るので、キャラのレイヤーはそのまま残ります。"),
    bgText,
    h("div", { class: "chips" }, ...SCENES.map((s) => h("button", { class: "chip-text", onClick: () => (bgText.value = s) }, s))),
    h("label", { class: "field" }, "画風", bgStyle),
    h(
      "button",
      {
        class: "primary wide",
        onClick: guard(() => jobs.background({ description: bgText.value.trim(), style: bgStyle.value, mode: bgMode })),
      },
      "✨ 背景を生成",
    ),
  );

  // ---------------------------------------------------------- 写真の線画化
  let method: "ai" | "local" = "ai";
  const la = { weight: "medium", detail: "normal", style: "manga" };
  const local: LineArtOptions = { ...DEFAULT_LINEART };
  const lineColor = h("input", { type: "color", value: "#000000" });
  const fadePhoto = h("input", { type: "checkbox", checked: true });
  const extra = h("input", { placeholder: "追加の指示 (任意) 例: 人物は描かない", class: "text" });
  const sourceName = h("strong", {});
  const aiOpts = h(
    "div",
    { class: "sub-opts" },
    h("label", { class: "field" }, "線の太さ", select("medium", [["thin", "細い"], ["medium", "普通"], ["bold", "太い"]], (v) => (la.weight = v))),
    h("label", { class: "field" }, "描き込み", select("normal", [["simple", "シンプル"], ["normal", "普通"], ["detailed", "細かく"]], (v) => (la.detail = v))),
    h("label", { class: "field" }, "用途", select("manga", [["manga", "キャラ・イラスト"], ["background", "背景 (建物・小物)"], ["sketch", "鉛筆スケッチ風"]], (v) => (la.style = v))),
    extra,
  );
  const localOpts = h(
    "div",
    { class: "sub-opts", hidden: true },
    slider({ label: "線の太さ", min: 0.6, max: 4, step: 0.1, value: local.thickness, onInput: (v) => (local.thickness = v) }),
    slider({ label: "描き込み", min: 0, max: 1, step: 0.05, value: local.detail, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (local.detail = v) }),
    slider({ label: "ノイズ除去", min: 0, max: 3, step: 0.1, value: local.denoise, onInput: (v) => (local.denoise = v) }),
    h("p", { class: "hint" }, "AI を使わずに輪郭を抽出します (無料・オフライン・すぐ終わる)。細部の整理は AI の方が得意です。"),
  );

  const importPhoto = async () => {
    const [file] = await pickFiles("image/*");
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const d = editor.doc;
    const layer = d.newLayer(`写真 ${file.name}`.slice(0, 40));
    const s = Math.min(1, d.width / bmp.width, d.height / bmp.height);
    const w = bmp.width * s;
    const hh = bmp.height * s;
    layer.ctx.imageSmoothingQuality = "high";
    layer.ctx.drawImage(bmp, (d.width - w) / 2, (d.height - hh) / 2, w, hh);
    bmp.close();
    editor.history.run(addLayerCommand(d, layer));
  };

  const runLineArt = async () => {
    const d = editor.doc;
    const src = d.active;
    if (!src) return;
    const fade = () => {
      if (fadePhoto.checked && src.opacity > 0.3) editor.history.run(propCommand(d, src, "opacity", 0.3));
    };
    if (method === "local") {
      toast("線画を抽出しています…");
      await new Promise((r) => setTimeout(r, 30));
      const layer = localLineArt(d, src, local, lineColor.value);
      if (!layer) return void toast("レイヤーが空です", "error");
      const parent = d.parentOf(src) ?? d.root;
      editor.history.run(addLayerCommand(d, layer, parent.children.indexOf(src) + 1, parent));
      fade();
      toast("線画レイヤーを追加しました", "ok");
      return;
    }
    if (needsKey()) return;
    toast("AI に送信しました。生成中も描き続けられます", "ok");
    fade();
    await jobs.lineArtAI(src, { ...la, color: lineColor.value, extra: extra.value.trim() });
  };

  const lineTab = h(
    "div",
    { class: "tab-body" },
    h("p", { class: "hint" }, "対象: アクティブなレイヤー → ", sourceName),
    h("button", { class: "wide", onClick: () => importPhoto().catch((e) => toast(e.message, "error")) }, "📷 写真を読み込む…"),
    segmented<"ai" | "local">(
      "ai",
      [
        ["ai", "AI で線画化"],
        ["local", "ローカル (無料)"],
      ],
      (v) => {
        method = v;
        aiOpts.hidden = v !== "ai";
        localOpts.hidden = v !== "local";
      },
    ),
    aiOpts,
    localOpts,
    h("div", { class: "row" }, h("label", { class: "field inline" }, "線の色", lineColor), h("label", { class: "check" }, fadePhoto, "元の写真を薄くする")),
    h("button", { class: "primary wide", onClick: () => runLineArt().catch((e) => toast((e as Error).message, "error")) }, "✏️ 線画レイヤーを作る"),
    h("p", { class: "hint" }, "結果は白が透明になった線だけのレイヤーとして写真の上に追加されます。"),
  );

  // ---------------------------------------------------------- 描き直し
  const redrawText = textarea("例: 右手にコーヒーカップを持たせる / 服を浴衣にする", 3);
  const selInfo = h("p", { class: "hint" });
  const redrawTab = h(
    "div",
    { class: "tab-body" },
    selInfo,
    redrawText,
    h(
      "button",
      {
        class: "primary wide",
        onClick: () => {
          if (!redrawText.value.trim()) return void toast("指示を入力してください", "error");
          guard(() => jobs.redraw({ instruction: redrawText.value.trim() }))();
        },
      },
      "🖌 描き直す",
    ),
  );

  // ---------------------------------------------------------- 設定
  const modelList = h("datalist", { id: "ai-models" });
  const modelInput = h("input", { class: "text", list: "ai-models" } as Record<string, unknown>);
  modelInput.setAttribute("list", "ai-models");
  const syncModel = () => {
    const models = settings.provider === "openai" ? OPENAI_MODELS : GEMINI_MODELS;
    modelList.replaceChildren(...models.map((m) => h("option", { value: m })));
    modelInput.value = settings.provider === "openai" ? settings.openaiModel : settings.geminiModel;
  };
  modelInput.addEventListener("change", () => {
    if (settings.provider === "openai") settings.openaiModel = modelInput.value.trim();
    else settings.geminiModel = modelInput.value.trim();
    persist();
    syncHeader();
  });
  const keyInput = (key: "geminiKey" | "openaiKey") => {
    const el = h("input", { type: "password", class: "text", value: settings[key], placeholder: "API キー", autocomplete: "off" });
    el.addEventListener("change", () => {
      settings[key] = el.value.trim();
      persist();
    });
    return el;
  };
  const providerSel = select<ProviderId>(settings.provider, [["gemini", "Nano Banana Pro (Google)"], ["openai", "GPT Image (OpenAI)"]], (v) => {
    settings.provider = v;
    persist();
    syncModel();
    syncHeader();
  });
  const settingsTab = h(
    "div",
    { class: "tab-body" },
    h("label", { class: "field" }, "使う AI", providerSel),
    h("label", { class: "field" }, "モデル", modelInput, modelList),
    h("label", { class: "field" }, "Gemini キー", keyInput("geminiKey")),
    h("p", { class: "hint" }, h("a", { href: "https://aistudio.google.com/apikey", target: "_blank" }, "Google AI Studio"), " で取得 (Nano Banana Pro は有料枠が必要)"),
    h("label", { class: "field" }, "OpenAI キー", keyInput("openaiKey")),
    h("p", { class: "hint" }, h("a", { href: "https://platform.openai.com/api-keys", target: "_blank" }, "OpenAI Platform"), " で取得"),
    h(
      "label",
      { class: "field" },
      "解像度 (Nano Banana Pro)",
      select(settings.imageSize, [["1K", "1K"], ["2K", "2K"], ["4K", "4K (高価)"]], (v) => {
        settings.imageSize = v;
        persist();
      }),
    ),
    h(
      "label",
      { class: "field" },
      "品質 (GPT Image)",
      select(settings.quality, [["auto", "自動"], ["low", "低 (速い)"], ["medium", "中"], ["high", "高"]], (v) => {
        settings.quality = v;
        persist();
      }),
    ),
    slider({
      label: "送信サイズ上限",
      min: 512,
      max: 4096,
      step: 256,
      value: settings.maxUpload,
      format: (v) => `${v}px`,
      onInput: (v) => {
        settings.maxUpload = v;
        persist();
      },
    }),
    h("p", { class: "hint" }, "API キーはこの Mac のブラウザ内 (localStorage) にだけ保存され、Google / OpenAI 以外には送信されません。利用料金は各社の API 料金がかかります。"),
  );

  // ---------------------------------------------------------- タブとジョブ
  const tabs = { bg: ["背景", bgTab], line: ["線画化", lineTab], redraw: ["描き直し", redrawTab], settings: ["設定", settingsTab] } as const;
  type TabId = keyof typeof tabs;
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const body = h("div", {});
  function showTab(id: TabId) {
    body.replaceChildren(tabs[id][1]);
    tabButtons.forEach((b, k) => b.classList.toggle("on", k === id));
  }
  const tabBar = h(
    "div",
    { class: "tabs" },
    ...(Object.keys(tabs) as TabId[]).map((id) => {
      const b = h("button", { onClick: () => showTab(id) }, tabs[id][0]);
      tabButtons.set(id, b);
      return b;
    }),
  );
  const header = h("div", { class: "ai-header" });
  const syncHeader = () => {
    header.replaceChildren(
      h("span", { class: "badge" }, PROVIDER_LABEL[settings.provider]),
      h("span", { class: "model" }, settings.provider === "openai" ? settings.openaiModel : settings.geminiModel),
      h(
        "button",
        {
          class: "link",
          onClick: () => {
            settings.provider = settings.provider === "gemini" ? "openai" : "gemini";
            providerSel.value = settings.provider;
            persist();
            syncModel();
            syncHeader();
          },
        },
        "切替",
      ),
    );
  };

  const jobList = h("div", { class: "jobs" });
  const notified = new Set<number>();
  jobs.onChange((list) => {
    jobList.replaceChildren(
      ...list.slice(0, 6).map((j) =>
        h(
          "div",
          { class: `job ${j.status}` },
          h("div", { class: "job-title" }, j.status === "running" ? h("span", { class: "spinner" }) : j.status === "done" ? "✓ " : j.status === "error" ? "⚠ " : "– ", j.title),
          h("div", { class: "job-sub" }, j.provider, j.message ? ` · ${j.message}` : ""),
          j.status === "running" ? h("button", { class: "link", onClick: () => jobs.cancel(j.id) }, "キャンセル") : null,
        ),
      ),
      list.some((j) => j.status !== "running") ? h("button", { class: "link", onClick: () => jobs.clearFinished() }, "履歴を消去") : "",
    );
    for (const j of list) {
      if (notified.has(j.id) || j.status === "running" || j.status === "cancelled") continue;
      notified.add(j.id);
      if (j.status === "done") toast(`完了: ${j.title} → 新しいレイヤーを追加しました`, "ok");
      else toast(`エラー: ${j.message}`, "error", 8000);
    }
  });

  editor.onChange(() => {
    sourceName.textContent = editor.doc.active?.name ?? "(なし)";
    selInfo.textContent = editor.doc.selection
      ? "選択範囲の中だけを描き直します (範囲外は元のまま)。"
      : "選択範囲がないので画像全体を描き直します。投げなわ (L) で範囲を選ぶと、その部分だけ変更できます。";
  });

  syncModel();
  syncHeader();
  showTab("bg");
  return h("section", { class: "panel ai-panel" }, header, tabBar, body, jobList);
}
