"""設定の読み書き (~/.csp_ai_bridge/config.json)."""

import json
import os
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CSP_AI_BRIDGE_HOME", Path.home() / ".csp_ai_bridge"))
CONFIG_PATH = CONFIG_DIR / "config.json"

DEFAULTS = {
    "openai_api_key": "",
    "gemini_api_key": "",
    "openai_base_url": "https://api.openai.com/v1",
    "gemini_base_url": "https://generativelanguage.googleapis.com/v1beta",
    "openai_model": "gpt-image-2",
    "gemini_model": "gemini-3-pro-image-preview",
    "provider": "gemini",
    "output_dir": str(Path.home() / "Pictures" / "CSP-AI-Bridge"),
    "max_upload_edge": 2048,
    "timeout": 300,
    "always_on_top": True,
    "auto_copy": True,
    "match_size": True,
}

ENV_KEYS = {
    "openai_api_key": ("OPENAI_API_KEY",),
    "gemini_api_key": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
}


def load(path: Path = CONFIG_PATH) -> dict:
    cfg = dict(DEFAULTS)
    if path.exists():
        try:
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    for key, env_names in ENV_KEYS.items():
        if not cfg.get(key):
            cfg[key] = next((os.environ[n] for n in env_names if os.environ.get(n)), "")
    return cfg


def save(cfg: dict, path: Path = CONFIG_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # API キーを含むため本人のみ読み書き可
    except OSError:
        pass
