import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, generate } from "../src/ai/providers";

const PNG_B64 = "iVBORw0KGgo=";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(json: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status: 200 });
  });
  return calls;
}

describe("Nano Banana Pro", () => {
  it("画像とマスクを送り、縦横比と解像度を指定する", async () => {
    const calls = mockFetch({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] });
    const out = await generate(
      { ...DEFAULT_SETTINGS, geminiKey: "KEY" },
      { prompt: "背景", images: [new Blob([new Uint8Array([1])], { type: "image/png" })], geminiMask: new Blob([new Uint8Array([2])], { type: "image/png" }), aspect: "3:4" },
    );
    expect(out.images).toHaveLength(1);
    expect(out.text).toBe("ok");
    expect(calls[0].url).toContain("/models/gemini-3-pro-image-preview:generateContent");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.contents[0].parts).toHaveLength(3);
    expect(body.contents[0].parts[0].text).toContain("[Mask]");
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "3:4", imageSize: "2K" });
  });
  it("ブロックされた理由を伝える", async () => {
    mockFetch({ promptFeedback: { blockReason: "SAFETY" } });
    await expect(generate({ ...DEFAULT_SETTINGS, geminiKey: "K" }, { prompt: "x", images: [] })).rejects.toThrow("SAFETY");
  });
  it("キー未設定はエラー", async () => {
    await expect(generate(DEFAULT_SETTINGS, { prompt: "x", images: [] })).rejects.toThrow("API キー");
  });
});

describe("GPT Image", () => {
  it("編集は multipart で image[] と mask を送る", async () => {
    const calls = mockFetch({ data: [{ b64_json: PNG_B64 }] });
    const img = new Blob([new Uint8Array([1])], { type: "image/png" });
    await generate({ ...DEFAULT_SETTINGS, provider: "openai", openaiKey: "K", quality: "high" }, { prompt: "p", images: [img, img], openaiMask: img, size: "1024x1536" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.get("mask")).toBeTruthy();
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("quality")).toBe("high");
    expect(form.get("size")).toBe("1024x1536");
  });
  it("新規生成は JSON", async () => {
    const calls = mockFetch({ data: [{ b64_json: PNG_B64 }] });
    await generate({ ...DEFAULT_SETTINGS, provider: "openai", openaiKey: "K" }, { prompt: "p", images: [], size: "auto" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "p", n: 1 });
    expect(body.size).toBeUndefined();
  });
});
