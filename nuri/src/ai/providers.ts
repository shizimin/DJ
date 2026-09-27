// 画像生成 API (Nano Banana Pro / GPT Image) をブラウザから直接呼ぶクライアント。
// API キーはこの端末の localStorage にのみ保存され、各社の API にだけ送信される。

export type ProviderId = "gemini" | "openai";

export interface AiSettings {
  provider: ProviderId;
  geminiKey: string;
  openaiKey: string;
  geminiModel: string;
  openaiModel: string;
  geminiBase: string;
  openaiBase: string;
  /** Nano Banana Pro の出力解像度 */
  imageSize: "1K" | "2K" | "4K";
  /** GPT Image の品質 */
  quality: "auto" | "low" | "medium" | "high";
  /** 送信する画像の最大辺 */
  maxUpload: number;
}

export const DEFAULT_SETTINGS: AiSettings = {
  provider: "gemini",
  geminiKey: "",
  openaiKey: "",
  geminiModel: "gemini-3-pro-image-preview",
  openaiModel: "gpt-image-2",
  geminiBase: "https://generativelanguage.googleapis.com/v1beta",
  openaiBase: "https://api.openai.com/v1",
  imageSize: "2K",
  quality: "auto",
  maxUpload: 2048,
};

export const GEMINI_MODELS = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"];
export const OPENAI_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-1"];
export const GEMINI_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const OPENAI_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

const STORAGE_KEY = "nuri.ai.settings";

export function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 読めない場合は既定値 */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: AiSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* プライベートモード等 */
  }
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: "Nano Banana Pro",
  openai: "GPT Image",
};

export class AiError extends Error {}

export interface GenInput {
  prompt: string;
  /** PNG。先頭が編集対象 */
  images: Blob[];
  /** OpenAI 形式のマスク (編集部分が透明) */
  openaiMask?: Blob;
  /** Gemini 形式のマスク (白背景・編集部分が黒) */
  geminiMask?: Blob;
  /** Gemini の縦横比 */
  aspect?: string;
  /** OpenAI のサイズ */
  size?: string;
  background?: "auto" | "transparent" | "opaque";
}

export interface GenOutput {
  images: Blob[];
  text: string;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBlob(b64: string, type = "image/png"): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? text;
  } catch {
    return text.slice(0, 500);
  }
}

const MASK_NOTE =
  "\n\n[Mask] The last attached image is a mask. Edit ONLY the region that is black in the mask; keep every other part of the first image unchanged.";

async function gemini(s: AiSettings, input: GenInput, signal?: AbortSignal): Promise<GenOutput> {
  if (!s.geminiKey) throw new AiError("Gemini の API キーが未設定です (AI 設定から入力してください)");
  const images = [...input.images];
  let prompt = input.prompt;
  if (input.geminiMask && images.length) {
    images.push(input.geminiMask);
    prompt += MASK_NOTE;
  }
  const parts: unknown[] = [{ text: prompt }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.type || "image/png", data: await blobToBase64(img) } });
  }
  const imageConfig: Record<string, string> = {};
  if (input.aspect) imageConfig.aspectRatio = input.aspect;
  if (s.imageSize && s.geminiModel.includes("pro")) imageConfig.imageSize = s.imageSize;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
  };
  const url = `${s.geminiBase.replace(/\/$/, "")}/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new AiError(`Gemini HTTP ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const out: Blob[] = [];
  const texts: string[] = [];
  for (const cand of data.candidates ?? []) {
    for (const part of cand?.content?.parts ?? []) {
      if (part.thought) continue;
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) out.push(base64ToBlob(inline.data, inline.mimeType ?? inline.mime_type ?? "image/png"));
      else if (part.text) texts.push(part.text);
    }
  }
  if (!out.length) {
    const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason;
    throw new AiError(`画像が返されませんでした${reason ? ` (理由: ${reason})` : ""}${texts.length ? `\n${texts.join(" ")}` : ""}`);
  }
  return { images: out, text: texts.join("\n") };
}

async function openai(s: AiSettings, input: GenInput, signal?: AbortSignal): Promise<GenOutput> {
  if (!s.openaiKey) throw new AiError("OpenAI の API キーが未設定です (AI 設定から入力してください)");
  const base = s.openaiBase.replace(/\/$/, "");
  const opts: Record<string, string> = { model: s.openaiModel, prompt: input.prompt, output_format: "png" };
  if (input.size && input.size !== "auto") opts.size = input.size;
  if (s.quality !== "auto") opts.quality = s.quality;
  if (input.background && input.background !== "auto") opts.background = input.background;
  let res: Response;
  if (input.images.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(opts)) form.append(k, v);
    const field = input.images.length > 1 ? "image[]" : "image";
    input.images.forEach((img, i) => form.append(field, img, `image${i}.png`));
    if (input.openaiMask) form.append("mask", input.openaiMask, "mask.png");
    res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.openaiKey}` },
      body: form,
      signal,
    });
  } else {
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...opts, n: 1 }),
      signal,
    });
  }
  if (!res.ok) throw new AiError(`OpenAI HTTP ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const images = (data.data ?? []).filter((d: { b64_json?: string }) => d.b64_json).map((d: { b64_json: string }) => base64ToBlob(d.b64_json));
  if (!images.length) throw new AiError("画像が返されませんでした");
  return { images, text: (data.data ?? []).map((d: { revised_prompt?: string }) => d.revised_prompt ?? "").join("\n").trim() };
}

export function generate(s: AiSettings, input: GenInput, signal?: AbortSignal): Promise<GenOutput> {
  return s.provider === "openai" ? openai(s, input, signal) : gemini(s, input, signal);
}

export function modelOf(s: AiSettings) {
  return s.provider === "openai" ? s.openaiModel : s.geminiModel;
}
