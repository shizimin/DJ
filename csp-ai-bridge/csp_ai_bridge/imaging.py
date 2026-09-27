"""画像の変換ユーティリティ (アップロード用縮小・マスク生成・サイズ合わせ)."""

import io

from PIL import Image, ImageOps


def to_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    if img.mode not in ("RGB", "RGBA", "L", "LA"):
        img = img.convert("RGBA")
    img.save(buf, format="PNG")
    return buf.getvalue()


def downscale(img: Image.Image, max_edge: int) -> Image.Image:
    """長辺が max_edge を超える場合だけ縮小する (API のサイズ制限・転送量対策)."""
    if max_edge and max(img.size) > max_edge:
        img = img.copy()
        img.thumbnail((max_edge, max_edge), Image.LANCZOS)
    return img


def edit_region(mask: Image.Image) -> Image.Image:
    """ユーザーが描いたマスク画像から「編集する領域 = 255」の L 画像を作る.

    透明度を持つ画像なら不透明な部分、持たない画像なら白以外の部分を編集領域とみなす。
    (CSP で新規レイヤーに選択範囲を塗りつぶしてコピーしたものを想定)
    """
    rgba = mask.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 255:
        return alpha.point(lambda a: 255 if a > 16 else 0)
    gray = rgba.convert("L")
    return gray.point(lambda v: 255 if v < 240 else 0)


def openai_mask(mask: Image.Image, size: tuple) -> Image.Image:
    """OpenAI 形式のマスク (編集箇所が透明 alpha=0) を base 画像サイズで作る."""
    region = edit_region(mask).resize(size, Image.NEAREST)
    out = Image.new("RGBA", size, (0, 0, 0, 255))
    out.putalpha(ImageOps.invert(region))
    return out


def gemini_mask_hint(mask: Image.Image, size: tuple) -> Image.Image:
    """Gemini 用のマスク画像 (白背景・編集箇所が黒)."""
    region = edit_region(mask).resize(size, Image.NEAREST)
    return ImageOps.invert(region).convert("RGB")


def fit_to_size(img: Image.Image, size: tuple) -> Image.Image:
    """結果を元キャンバスと同じサイズにする (CSP で貼り付け位置が揃うように).

    縦横比がほぼ同じなら単純リサイズ、違う場合は透明余白付きで中央に収める。
    """
    if img.size == tuple(size):
        return img
    tw, th = size
    sw, sh = img.size
    if abs((sw / sh) - (tw / th)) / (tw / th) < 0.02:
        return img.resize(size, Image.LANCZOS)
    scale = min(tw / sw, th / sh)
    resized = img.convert("RGBA").resize(
        (max(1, round(sw * scale)), max(1, round(sh * scale))), Image.LANCZOS
    )
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.paste(resized, ((tw - resized.width) // 2, (th - resized.height) // 2))
    return canvas
