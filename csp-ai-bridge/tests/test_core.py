import base64
import io
import json
import struct

import pytest
from PIL import Image

from csp_ai_bridge import clipboard, config, imaging, providers


def png_b64(color=(255, 0, 0), size=(8, 8)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class FakeResp:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def capture(monkeypatch):
    calls = []

    def install(payload):
        def fake(req, timeout=None):
            calls.append(req)
            return FakeResp(payload)
        monkeypatch.setattr(providers.urllib.request, "urlopen", fake)
        return calls
    return install


def test_edit_region_alpha_and_white():
    rgba = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    rgba.putpixel((1, 1), (255, 0, 0, 255))
    assert imaging.edit_region(rgba).getbbox() == (1, 1, 2, 2)
    rgb = Image.new("RGB", (4, 4), "white")
    rgb.putpixel((2, 3), (10, 10, 10))
    assert imaging.edit_region(rgb).getbbox() == (2, 3, 3, 4)


def test_openai_mask_transparent_where_edit():
    m = Image.new("RGB", (2, 2), "white")
    m.putpixel((0, 0), (0, 0, 0))
    out = imaging.openai_mask(m, (4, 4))
    assert out.size == (4, 4)
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((3, 3))[3] == 255


def test_fit_to_size():
    same_ratio = imaging.fit_to_size(Image.new("RGB", (100, 50)), (200, 100))
    assert same_ratio.size == (200, 100)
    boxed = imaging.fit_to_size(Image.new("RGB", (100, 100), "red"), (200, 100))
    assert boxed.size == (200, 100) and boxed.getpixel((0, 0))[3] == 0
    assert boxed.getpixel((100, 50)) == (255, 0, 0, 255)


def test_downscale():
    assert imaging.downscale(Image.new("RGB", (4000, 1000)), 2048).size == (2048, 512)
    assert imaging.downscale(Image.new("RGB", (100, 100)), 2048).size == (100, 100)


def test_gemini_request_and_parse(capture):
    calls = capture({"candidates": [{"content": {"parts": [
        {"text": "done"}, {"inlineData": {"mimeType": "image/png", "data": png_b64()}}]}}]})
    p = providers.GeminiProvider("KEY")
    req = providers.GenRequest("colorize", images=[Image.new("RGB", (8, 8))],
                               mask=Image.new("RGB", (8, 8), "black"), aspect_ratio="16:9")
    res = p.run(req)
    assert len(res.images) == 1 and res.text == "done"
    r = calls[0]
    assert r.full_url.endswith("/models/gemini-3-pro-image-preview:generateContent")
    assert r.get_header("X-goog-api-key") == "KEY"
    body = json.loads(r.data)
    parts = body["contents"][0]["parts"]
    assert "mask" in parts[0]["text"].lower() and len(parts) == 3  # text + image + mask
    assert body["generationConfig"]["imageConfig"] == {"aspectRatio": "16:9", "imageSize": "2K"}


def test_gemini_block_reason(capture):
    capture({"promptFeedback": {"blockReason": "SAFETY"}})
    with pytest.raises(providers.ProviderError, match="SAFETY"):
        providers.GeminiProvider("K").run(providers.GenRequest("x"))


def test_openai_generate_json(capture):
    calls = capture({"data": [{"b64_json": png_b64()}, {"b64_json": png_b64()}]})
    res = providers.OpenAIProvider("K").run(providers.GenRequest("cat", n=2, quality="high"))
    assert len(res.images) == 2
    body = json.loads(calls[0].data)
    assert calls[0].full_url.endswith("/images/generations")
    assert body["n"] == 2 and body["quality"] == "high" and "size" not in body


def test_openai_edit_multipart_with_mask(capture):
    calls = capture({"data": [{"b64_json": png_b64()}]})
    req = providers.GenRequest("fix", images=[Image.new("RGB", (8, 8)), Image.new("RGB", (4, 4))],
                               mask=Image.new("RGB", (8, 8), "black"))
    providers.OpenAIProvider("K", model="gpt-image-2").run(req)
    r = calls[0]
    assert r.full_url.endswith("/images/edits")
    assert r.get_header("Content-type").startswith("multipart/form-data; boundary=")
    assert r.data.count(b'name="image[]"') == 2 and b'name="mask"' in r.data
    assert b"gpt-image-2" in r.data


def test_missing_key():
    with pytest.raises(providers.ProviderError):
        providers.create({"gemini_api_key": ""}, "gemini")


def test_dib_formats():
    img = Image.new("RGBA", (3, 2), (10, 20, 30, 128))
    v5 = clipboard.dibv5_bytes(img)
    assert struct.unpack_from("<Iii", v5) == (124, 3, 2)
    assert len(v5) == 124 + 3 * 2 * 4
    assert v5[124:128] == bytes([30, 20, 10, 128])  # BGRA
    dib = clipboard.dib_bytes(img)
    assert struct.unpack_from("<IiiHH", dib) == (40, 3, 2, 1, 24)


def test_config_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "envkey")
    path = tmp_path / "c.json"
    cfg = config.load(path)
    assert cfg["gemini_api_key"] == "envkey"
    cfg["openai_model"] = "gpt-image-1"
    config.save(cfg, path)
    assert config.load(path)["openai_model"] == "gpt-image-1"
