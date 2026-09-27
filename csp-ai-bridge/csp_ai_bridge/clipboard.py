"""OS のクリップボードと画像をやり取りする.

CLIP STUDIO PAINT は「編集 → コピー」で画像をクリップボードに置き、
「編集 → 貼り付け」でクリップボード画像を新規レイヤーとして貼り付けられる。
"""

import io
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

from PIL import Image, ImageGrab


class ClipboardError(Exception):
    pass


def get_image() -> Optional[Image.Image]:
    try:
        data = ImageGrab.grabclipboard()
    except Exception as e:  # 環境によっては未対応
        raise ClipboardError(f"クリップボードを読めません: {e}") from None
    if isinstance(data, Image.Image):
        data.load()
        return data
    if isinstance(data, list):  # エクスプローラー等でファイルをコピーした場合
        for path in data:
            try:
                img = Image.open(path)
                img.load()
                return img
            except (OSError, ValueError):
                continue
    return None


def set_image(img: Image.Image) -> None:
    if sys.platform == "win32":
        _set_windows(img)
    elif sys.platform == "darwin":
        _set_macos(img)
    else:
        _set_linux(img)


# ---------------------------------------------------------------- Windows

def dib_bytes(img: Image.Image) -> bytes:
    """CF_DIB (24bit, 透明部分は白で合成) のバイト列."""
    rgba = img.convert("RGBA")
    flat = Image.new("RGB", rgba.size, (255, 255, 255))
    flat.paste(rgba, mask=rgba.getchannel("A"))
    buf = io.BytesIO()
    flat.save(buf, format="BMP")
    return buf.getvalue()[14:]  # BITMAPFILEHEADER を除く


def dibv5_bytes(img: Image.Image) -> bytes:
    """CF_DIBV5 (32bit BGRA, 透明度あり) のバイト列."""
    rgba = img.convert("RGBA")
    w, h = rgba.size
    pixels = rgba.transpose(Image.FLIP_TOP_BOTTOM).tobytes("raw", "BGRA")
    header = struct.pack(
        "<IiiHHIIiiIIIIIII36sIIIIIII",
        124, w, h, 1, 32, 3, len(pixels), 2835, 2835, 0, 0,  # BI_BITFIELDS
        0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000,
        0x73524742, b"\0" * 36, 0, 0, 0,  # LCS_sRGB
        4, 0, 0, 0,  # LCS_GM_IMAGES
    )
    return header + pixels


def _set_windows(img: Image.Image) -> None:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterClipboardFormatW.restype = wintypes.UINT
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]

    def put(fmt, data):
        handle = kernel32.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
        if not handle:
            raise ClipboardError("メモリ確保に失敗しました")
        ptr = kernel32.GlobalLock(handle)
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(fmt, handle):
            raise ClipboardError("クリップボードへの書き込みに失敗しました")

    for _ in range(20):  # 他アプリがクリップボードを開いている場合に備えてリトライ
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise ClipboardError("クリップボードを開けません")
    try:
        user32.EmptyClipboard()
        put(8, dib_bytes(img))  # CF_DIB
        put(17, dibv5_bytes(img))  # CF_DIBV5
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        put(user32.RegisterClipboardFormatW("PNG"), buf.getvalue())
    finally:
        user32.CloseClipboard()


# ---------------------------------------------------------------- macOS / Linux

def _temp_png(img: Image.Image) -> Path:
    path = Path(tempfile.gettempdir()) / "csp_ai_bridge_clip.png"
    img.save(path, format="PNG")
    return path


def _set_macos(img: Image.Image) -> None:
    path = _temp_png(img)
    script = f'set the clipboard to (read (POSIX file "{path}") as «class PNGf»)'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        raise ClipboardError(result.stderr.strip() or "osascript が失敗しました")


def _set_linux(img: Image.Image) -> None:
    path = _temp_png(img)
    if shutil.which("wl-copy"):
        cmd = ["wl-copy", "--type", "image/png"]
    elif shutil.which("xclip"):
        cmd = ["xclip", "-selection", "clipboard", "-t", "image/png", "-i"]
    else:
        raise ClipboardError("xclip か wl-copy をインストールしてください")
    with open(path, "rb") as f:
        subprocess.run(cmd, stdin=f, check=True)
