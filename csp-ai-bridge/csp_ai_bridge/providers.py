"""画像生成 API クライアント (Nano Banana Pro / GPT Image).

外部ライブラリに依存せず urllib のみで HTTP を扱う。
"""

import base64
import io
import json
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import List, Optional

from PIL import Image

from . import imaging


class ProviderError(Exception):
    pass


@dataclass
class GenRequest:
    prompt: str
    images: List[Image.Image] = field(default_factory=list)  # 先頭が編集対象の元画像
    mask: Optional[Image.Image] = None
    n: int = 1
    # GPT Image 用
    size: str = "auto"
    quality: str = "auto"
    background: str = "auto"
    # Nano Banana Pro 用
    aspect_ratio: str = ""
    image_size: str = "2K"


@dataclass
class GenResult:
    images: List[Image.Image]
    text: str = ""


def _post_json(url, body: bytes, headers: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        raise ProviderError(f"HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise ProviderError(f"接続エラー: {e.reason}") from None
    except TimeoutError:
        raise ProviderError("タイムアウトしました") from None


def _multipart(fields, files):
    boundary = uuid.uuid4().hex
    buf = io.BytesIO()
    for name, value in fields:
        buf.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )
    for name, filename, data, ctype in files:
        buf.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode("utf-8")
        )
        buf.write(data)
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode("utf-8"))
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


def _decode_image(b64: str) -> Image.Image:
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    img.load()
    return img


class OpenAIProvider:
    label = "GPT Image"

    def __init__(self, api_key, model="gpt-image-2", base_url="https://api.openai.com/v1", timeout=300):
        if not api_key:
            raise ProviderError("OpenAI の API キーが設定されていません (設定 → API キー)")
        self.api_key, self.model, self.timeout = api_key, model, timeout
        self.base_url = base_url.rstrip("/")

    def _options(self, req: GenRequest):
        opts = [("model", self.model), ("prompt", req.prompt), ("n", str(req.n)),
                ("output_format", "png")]
        for key in ("size", "quality", "background"):
            value = getattr(req, key)
            if value and value != "auto":
                opts.append((key, value))
        return opts

    def run(self, req: GenRequest) -> GenResult:
        auth = {"Authorization": f"Bearer {self.api_key}"}
        if req.images:
            field_name = "image[]" if len(req.images) > 1 else "image"
            files = [(field_name, f"image{i}.png", imaging.to_png_bytes(img), "image/png")
                     for i, img in enumerate(req.images)]
            if req.mask is not None:
                mask = imaging.openai_mask(req.mask, req.images[0].size)
                files.append(("mask", "mask.png", imaging.to_png_bytes(mask), "image/png"))
            body, ctype = _multipart(self._options(req), files)
            url = f"{self.base_url}/images/edits"
        else:
            body = json.dumps(dict(self._options(req)) | {"n": req.n}).encode("utf-8")
            ctype = "application/json"
            url = f"{self.base_url}/images/generations"
        data = _post_json(url, body, auth | {"Content-Type": ctype}, self.timeout)
        images = [_decode_image(d["b64_json"]) for d in data.get("data", []) if d.get("b64_json")]
        if not images:
            raise ProviderError("画像が返されませんでした")
        texts = [d.get("revised_prompt", "") for d in data.get("data", [])]
        return GenResult(images, "\n".join(t for t in texts if t))


class GeminiProvider:
    label = "Nano Banana Pro"

    MASK_INSTRUCTION = (
        "\n\n[Mask] The last attached image is a mask: edit ONLY the area that is black "
        "in the mask and keep every other pixel of the first image unchanged."
    )

    def __init__(self, api_key, model="gemini-3-pro-image-preview",
                 base_url="https://generativelanguage.googleapis.com/v1beta", timeout=300):
        if not api_key:
            raise ProviderError("Gemini の API キーが設定されていません (設定 → API キー)")
        self.api_key, self.model, self.timeout = api_key, model, timeout
        self.base_url = base_url.rstrip("/")

    def build_body(self, req: GenRequest) -> dict:
        images = list(req.images)
        prompt = req.prompt
        if req.mask is not None and images:
            images.append(imaging.gemini_mask_hint(req.mask, images[0].size))
            prompt += self.MASK_INSTRUCTION
        parts = [{"text": prompt}] + [
            {"inline_data": {"mime_type": "image/png",
                             "data": base64.b64encode(imaging.to_png_bytes(img)).decode("ascii")}}
            for img in images
        ]
        image_config = {}
        if req.aspect_ratio:
            image_config["aspectRatio"] = req.aspect_ratio
        if req.image_size:
            image_config["imageSize"] = req.image_size
        gen_config = {"responseModalities": ["TEXT", "IMAGE"]}
        if image_config:
            gen_config["imageConfig"] = image_config
        return {"contents": [{"role": "user", "parts": parts}], "generationConfig": gen_config}

    def _run_once(self, body: bytes) -> GenResult:
        url = f"{self.base_url}/models/{self.model}:generateContent"
        headers = {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}
        data = _post_json(url, body, headers, self.timeout)
        images, texts = [], []
        for cand in data.get("candidates", []):
            for part in (cand.get("content") or {}).get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data") and not part.get("thought"):
                    images.append(_decode_image(inline["data"]))
                elif part.get("text") and not part.get("thought"):
                    texts.append(part["text"])
        if not images:
            reason = (data.get("promptFeedback") or {}).get("blockReason")
            if not reason and data.get("candidates"):
                reason = data["candidates"][0].get("finishReason")
            msg = "画像が返されませんでした"
            if reason:
                msg += f" (理由: {reason})"
            if texts:
                msg += f"\n{' '.join(texts)}"
            raise ProviderError(msg)
        return GenResult(images, "\n".join(texts))

    def run(self, req: GenRequest) -> GenResult:
        body = json.dumps(self.build_body(req)).encode("utf-8")
        results = [self._run_once(body) for _ in range(max(1, req.n))]
        return GenResult([i for r in results for i in r.images],
                         "\n".join(r.text for r in results if r.text))


def create(cfg: dict, provider: str):
    if provider == "openai":
        return OpenAIProvider(cfg.get("openai_api_key"), cfg.get("openai_model"),
                              cfg.get("openai_base_url"), cfg.get("timeout", 300))
    return GeminiProvider(cfg.get("gemini_api_key"), cfg.get("gemini_model"),
                          cfg.get("gemini_base_url"), cfg.get("timeout", 300))
