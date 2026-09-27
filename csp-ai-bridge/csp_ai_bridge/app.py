"""CSP AI Bridge の GUI (tkinter).

CLIP STUDIO PAINT の横に常に手前で置いておき、クリップボード経由で
画像をやり取りしながら Nano Banana Pro / GPT Image を呼び出す。
"""

import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageTk

from . import __version__, clipboard, config, imaging, providers

PROVIDERS = {"Nano Banana Pro (Gemini)": "gemini", "GPT Image (OpenAI)": "openai"}
GEMINI_MODELS = ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"]
OPENAI_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-1"]

PRESETS = {
    "(プリセットを選択)": "",
    "線画を着色": "この線画の線・構図・キャラクターの形を一切変えずに、丁寧に着色してください。"
                "アニメ塗り、柔らかい影、自然なハイライト。",
    "ラフを清書 (線画化)": "このラフスケッチを、構図・ポーズ・比率を保ったまま、"
                    "白背景に黒一色のクリーンな線画に清書してください。塗りは入れないでください。",
    "背景を描く": "キャラクターはそのままに、背景を描き加えてください。背景: ",
    "影とハイライトを追加": "今の色と線を保ったまま、光源を左上として影とハイライトを追加してください。",
    "マスク範囲を描き直す": "マスクで指定した範囲だけを次の内容で描き直してください: ",
    "ディテールアップ": "構図と配色を保ったまま、全体の描き込みと質感を高めて完成度を上げてください。",
    "参考画像のスタイルで": "1枚目の画像を、2枚目以降の参考画像の画風・色使いに合わせて描き直してください。",
}

THUMB = 72


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.cfg = config.load()
        self.inputs = []  # PIL images (先頭が元画像)
        self.mask = None
        self.results = []  # (PIL image, saved path)
        self.selected = None
        self._thumb_refs = []
        self._result_refs = []
        self._preview_ref = None
        self.jobs = queue.Queue()
        self.busy = False

        root.title(f"CSP AI Bridge {__version__}")
        root.geometry("560x860")
        root.minsize(480, 640)
        self._build()
        self._apply_topmost()
        root.bind("<Control-Return>", lambda e: self.generate())
        root.bind("<Command-Return>", lambda e: self.generate())
        root.after(100, self._poll)

    # ------------------------------------------------------------------ UI

    def _build(self):
        pad = {"padx": 8, "pady": 4}
        top = ttk.Frame(self.root)
        top.pack(fill="x", **pad)
        ttk.Label(top, text="AI:").pack(side="left")
        self.provider_var = tk.StringVar(
            value=next(k for k, v in PROVIDERS.items() if v == self.cfg["provider"]))
        cb = ttk.Combobox(top, textvariable=self.provider_var, values=list(PROVIDERS),
                          state="readonly", width=24)
        cb.pack(side="left", padx=4)
        cb.bind("<<ComboboxSelected>>", lambda e: self._on_provider())
        self.model_var = tk.StringVar()
        self.model_cb = ttk.Combobox(top, textvariable=self.model_var, width=26)
        self.model_cb.pack(side="left", padx=4, fill="x", expand=True)
        ttk.Button(top, text="設定", width=5, command=self.open_settings).pack(side="right")

        # 入力画像
        inp = ttk.LabelFrame(self.root, text="入力画像 (1枚目が編集対象・2枚目以降は参考)")
        inp.pack(fill="x", **pad)
        btns = ttk.Frame(inp)
        btns.pack(fill="x", padx=4, pady=2)
        ttk.Button(btns, text="📋 クリップボードから追加", command=self.add_from_clipboard).pack(side="left")
        ttk.Button(btns, text="ファイル…", command=self.add_from_file).pack(side="left", padx=4)
        ttk.Button(btns, text="クリア", command=self.clear_inputs).pack(side="left")
        self.input_strip = ttk.Frame(inp, height=THUMB + 8)
        self.input_strip.pack(fill="x", padx=4, pady=4)

        mrow = ttk.Frame(inp)
        mrow.pack(fill="x", padx=4, pady=(0, 4))
        ttk.Button(mrow, text="📋 マスクを取り込み", command=self.set_mask_from_clipboard).pack(side="left")
        ttk.Button(mrow, text="マスク解除", command=self.clear_mask).pack(side="left", padx=4)
        self.mask_label = ttk.Label(mrow, text="マスク: なし (画像全体が対象)")
        self.mask_label.pack(side="left", padx=4)

        # プロンプト
        pf = ttk.LabelFrame(self.root, text="指示 (プロンプト)  Ctrl+Enter で生成")
        pf.pack(fill="both", **pad)
        self.preset_var = tk.StringVar(value=list(PRESETS)[0])
        pcb = ttk.Combobox(pf, textvariable=self.preset_var, values=list(PRESETS), state="readonly")
        pcb.pack(fill="x", padx=4, pady=2)
        pcb.bind("<<ComboboxSelected>>", lambda e: self._apply_preset())
        self.prompt = tk.Text(pf, height=5, wrap="word", undo=True)
        self.prompt.pack(fill="both", expand=True, padx=4, pady=4)

        # オプション
        opt = ttk.LabelFrame(self.root, text="オプション")
        opt.pack(fill="x", **pad)
        self.gemini_opts = ttk.Frame(opt)
        ttk.Label(self.gemini_opts, text="縦横比").pack(side="left")
        self.aspect_var = tk.StringVar(value="")
        ttk.Combobox(self.gemini_opts, textvariable=self.aspect_var, width=6, state="readonly",
                     values=["", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
                     ).pack(side="left", padx=4)
        ttk.Label(self.gemini_opts, text="解像度").pack(side="left")
        self.imgsize_var = tk.StringVar(value="2K")
        ttk.Combobox(self.gemini_opts, textvariable=self.imgsize_var, width=5, state="readonly",
                     values=["", "1K", "2K", "4K"]).pack(side="left", padx=4)
        ttk.Label(self.gemini_opts, text="(空欄=自動/入力に合わせる)").pack(side="left")

        self.openai_opts = ttk.Frame(opt)
        ttk.Label(self.openai_opts, text="サイズ").pack(side="left")
        self.size_var = tk.StringVar(value="auto")
        ttk.Combobox(self.openai_opts, textvariable=self.size_var, width=10,
                     values=["auto", "1024x1024", "1536x1024", "1024x1536"]).pack(side="left", padx=4)
        ttk.Label(self.openai_opts, text="品質").pack(side="left")
        self.quality_var = tk.StringVar(value="auto")
        ttk.Combobox(self.openai_opts, textvariable=self.quality_var, width=7, state="readonly",
                     values=["auto", "low", "medium", "high"]).pack(side="left", padx=4)
        ttk.Label(self.openai_opts, text="背景").pack(side="left")
        self.bg_var = tk.StringVar(value="auto")
        ttk.Combobox(self.openai_opts, textvariable=self.bg_var, width=11, state="readonly",
                     values=["auto", "transparent", "opaque"]).pack(side="left", padx=4)

        common = ttk.Frame(opt)
        common.pack(fill="x", padx=4, pady=2, side="bottom")
        ttk.Label(common, text="枚数").pack(side="left")
        self.n_var = tk.IntVar(value=1)
        ttk.Spinbox(common, from_=1, to=4, textvariable=self.n_var, width=3).pack(side="left", padx=4)
        self.match_var = tk.BooleanVar(value=self.cfg["match_size"])
        ttk.Checkbutton(common, text="元画像サイズに合わせる", variable=self.match_var).pack(side="left", padx=4)
        self.autocopy_var = tk.BooleanVar(value=self.cfg["auto_copy"])
        ttk.Checkbutton(common, text="結果を自動コピー", variable=self.autocopy_var).pack(side="left", padx=4)
        self.top_var = tk.BooleanVar(value=self.cfg["always_on_top"])
        ttk.Checkbutton(common, text="最前面", variable=self.top_var,
                        command=self._apply_topmost).pack(side="left", padx=4)

        # 生成ボタン
        gen = ttk.Frame(self.root)
        gen.pack(fill="x", **pad)
        self.gen_btn = ttk.Button(gen, text="✨ 生成", command=self.generate)
        self.gen_btn.pack(side="left", fill="x", expand=True)
        self.progress = ttk.Progressbar(gen, mode="indeterminate", length=120)
        self.progress.pack(side="left", padx=6)

        # 結果
        res = ttk.LabelFrame(self.root, text="結果")
        res.pack(fill="both", expand=True, **pad)
        self.preview = ttk.Label(res, anchor="center")
        self.preview.pack(fill="both", expand=True, padx=4, pady=4)
        self.preview.bind("<Configure>", lambda e: self._show_preview())
        self.result_strip = ttk.Frame(res, height=THUMB + 8)
        self.result_strip.pack(fill="x", padx=4)
        rb = ttk.Frame(res)
        rb.pack(fill="x", padx=4, pady=4)
        ttk.Button(rb, text="📋 コピー (CSP で Ctrl+V)", command=self.copy_selected).pack(side="left")
        ttk.Button(rb, text="入力に使う", command=self.use_as_input).pack(side="left", padx=4)
        ttk.Button(rb, text="保存…", command=self.save_selected).pack(side="left")
        ttk.Button(rb, text="フォルダ", command=self.open_output_dir).pack(side="left", padx=4)

        self.status = tk.StringVar(value="CSP で画像をコピー → 「クリップボードから追加」")
        ttk.Label(self.root, textvariable=self.status, relief="sunken", anchor="w",
                  wraplength=540).pack(fill="x", side="bottom")
        self._on_provider(initial=True)
        self._refresh_inputs()

    def _provider_key(self):
        return PROVIDERS[self.provider_var.get()]

    def _on_provider(self, initial=False):
        key = self._provider_key()
        if key == "gemini":
            self.model_cb["values"] = GEMINI_MODELS
            self.model_var.set(self.cfg["gemini_model"])
            self.openai_opts.pack_forget()
            self.gemini_opts.pack(fill="x", padx=4, pady=2)
        else:
            self.model_cb["values"] = OPENAI_MODELS
            self.model_var.set(self.cfg["openai_model"])
            self.gemini_opts.pack_forget()
            self.openai_opts.pack(fill="x", padx=4, pady=2)
        if not initial:
            self.cfg["provider"] = key
            self._save_cfg()

    def _apply_preset(self):
        text = PRESETS.get(self.preset_var.get(), "")
        if text:
            self.prompt.delete("1.0", "end")
            self.prompt.insert("1.0", text)
            self.prompt.focus_set()
            self.prompt.mark_set("insert", "end")

    def _apply_topmost(self):
        self.root.attributes("-topmost", bool(self.top_var.get()))

    def _save_cfg(self):
        self.cfg.update(match_size=self.match_var.get(), auto_copy=self.autocopy_var.get(),
                        always_on_top=self.top_var.get())
        model_key = "gemini_model" if self._provider_key() == "gemini" else "openai_model"
        if self.model_var.get().strip():
            self.cfg[model_key] = self.model_var.get().strip()
        try:
            config.save(self.cfg)
        except OSError as e:
            self.status.set(f"設定を保存できません: {e}")

    # ----------------------------------------------------------- サムネイル

    @staticmethod
    def _make_thumb(img, refs, size=THUMB):
        t = img.copy()
        t.thumbnail((size, size))
        photo = ImageTk.PhotoImage(t)
        refs.append(photo)  # tkinter は参照が消えると画像も消えるので保持する
        return photo

    def _refresh_inputs(self):
        for w in self.input_strip.winfo_children():
            w.destroy()
        self._thumb_refs = []
        for i, img in enumerate(self.inputs):
            cell = ttk.Frame(self.input_strip)
            cell.pack(side="left", padx=2)
            ttk.Label(cell, image=self._make_thumb(img, self._thumb_refs)).pack()
            caption = "元画像" if i == 0 else f"参考{i}"
            ttk.Button(cell, text=f"✕ {caption}", width=9,
                       command=lambda i=i: self.remove_input(i)).pack()
        if not self.inputs:
            ttk.Label(self.input_strip, text="(なし → テキストから新規生成)").pack(side="left")

    def _refresh_results_strip(self):
        for w in self.result_strip.winfo_children():
            w.destroy()
        self._result_refs = []
        for i, (img, _) in enumerate(self.results[-8:]):
            idx = len(self.results) - len(self.results[-8:]) + i
            b = tk.Button(self.result_strip, image=self._make_thumb(img, self._result_refs, 56), relief="flat",
                          bd=2 if idx == self.selected else 0, bg="#4a90e2",
                          command=lambda idx=idx: self.select_result(idx))
            b.pack(side="left", padx=2)

    def _show_preview(self):
        if self.selected is None:
            self.preview.configure(image="", text="")
            return
        img = self.results[self.selected][0]
        w = max(50, self.preview.winfo_width() - 8)
        h = max(50, self.preview.winfo_height() - 8)
        t = img.copy()
        t.thumbnail((w, h))
        self._preview_ref = ImageTk.PhotoImage(t)
        self.preview.configure(image=self._preview_ref)

    # -------------------------------------------------------------- 入力

    def _grab(self):
        try:
            img = clipboard.get_image()
        except clipboard.ClipboardError as e:
            messagebox.showerror("クリップボード", str(e))
            return None
        if img is None:
            messagebox.showinfo("クリップボード",
                                "クリップボードに画像がありません。\nCSP で範囲を選択して「編集 → コピー」してください。")
        return img

    def add_from_clipboard(self):
        img = self._grab()
        if img is not None:
            self.inputs.append(img)
            self._refresh_inputs()
            self.status.set(f"入力画像を追加しました ({img.width}×{img.height})")

    def add_from_file(self):
        paths = filedialog.askopenfilenames(
            filetypes=[("画像", "*.png *.jpg *.jpeg *.webp *.bmp"), ("すべて", "*.*")])
        for p in paths:
            try:
                img = Image.open(p)
                img.load()
                self.inputs.append(img)
            except OSError as e:
                messagebox.showerror("読み込みエラー", f"{p}\n{e}")
        self._refresh_inputs()

    def remove_input(self, i):
        del self.inputs[i]
        self._refresh_inputs()

    def clear_inputs(self):
        self.inputs.clear()
        self.clear_mask()
        self._refresh_inputs()

    def set_mask_from_clipboard(self):
        img = self._grab()
        if img is None:
            return
        region = imaging.edit_region(img)
        if region.getbbox() is None:
            messagebox.showwarning("マスク", "編集範囲が見つかりません。白以外の色で塗った画像をコピーしてください。")
            return
        self.mask = img
        area = sum(region.histogram()[255:]) / (region.width * region.height) * 100
        self.mask_label.configure(text=f"マスク: あり (編集範囲 {area:.0f}%)")

    def clear_mask(self):
        self.mask = None
        self.mask_label.configure(text="マスク: なし (画像全体が対象)")

    # -------------------------------------------------------------- 生成

    def generate(self):
        if self.busy:
            return
        prompt = self.prompt.get("1.0", "end").strip()
        if not prompt:
            messagebox.showinfo("生成", "指示 (プロンプト) を入力してください。")
            return
        if self.mask is not None and not self.inputs:
            messagebox.showinfo("生成", "マスクを使う場合は元画像を追加してください。")
            return
        self._save_cfg()
        key = self._provider_key()
        try:
            provider = providers.create(self.cfg, key)
        except providers.ProviderError as e:
            messagebox.showerror("設定", str(e))
            self.open_settings()
            return
        edge = int(self.cfg.get("max_upload_edge") or 0)
        req = providers.GenRequest(
            prompt=prompt,
            images=[imaging.downscale(i, edge) for i in self.inputs],
            mask=self.mask,
            n=max(1, min(4, int(self.n_var.get() or 1))),
            size=self.size_var.get(), quality=self.quality_var.get(), background=self.bg_var.get(),
            aspect_ratio=self.aspect_var.get(), image_size=self.imgsize_var.get(),
        )
        target = self.inputs[0].size if (self.inputs and self.match_var.get()) else None
        self.busy = True
        self.gen_btn.state(["disabled"])
        self.progress.start(12)
        started = time.time()
        self.status.set(f"{provider.label} ({provider.model}) で生成中…")

        def work():
            try:
                result = provider.run(req)
                self.jobs.put(("ok", result, target, started))
            except Exception as e:  # noqa: BLE001 - UI に表示する
                self.jobs.put(("err", e, None, started))

        threading.Thread(target=work, daemon=True).start()

    def _poll(self):
        try:
            while True:
                kind, payload, target, started = self.jobs.get_nowait()
                self._finish(kind, payload, target, started)
        except queue.Empty:
            pass
        self.root.after(100, self._poll)

    def _finish(self, kind, payload, target, started):
        self.busy = False
        self.gen_btn.state(["!disabled"])
        self.progress.stop()
        if kind == "err":
            self.status.set("エラー")
            messagebox.showerror("生成エラー", str(payload))
            return
        out_dir = Path(self.cfg["output_dir"]).expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for i, img in enumerate(payload.images):
            if target:
                img = imaging.fit_to_size(img, target)
            path = out_dir / f"{stamp}_{self._provider_key()}_{i + 1}.png"
            img.save(path)
            self.results.append((img, path))
        self.select_result(len(self.results) - len(payload.images))
        msg = f"{len(payload.images)} 枚生成 ({time.time() - started:.0f} 秒) → {out_dir}"
        if self.autocopy_var.get():
            if self.copy_selected(quiet=True):
                msg += "  ✔ コピー済み: CSP で Ctrl+V"
        self.status.set(msg)
        if payload.text:
            self.status.set(msg + "\n" + payload.text[:300])

    # -------------------------------------------------------------- 結果

    def select_result(self, idx):
        self.selected = idx
        self._refresh_results_strip()
        self._show_preview()

    def copy_selected(self, quiet=False):
        if self.selected is None:
            return False
        try:
            clipboard.set_image(self.results[self.selected][0])
        except (clipboard.ClipboardError, OSError, subprocess.CalledProcessError) as e:
            messagebox.showerror("クリップボード", str(e))
            return False
        if not quiet:
            self.status.set("コピーしました。CSP で「編集 → 貼り付け」(Ctrl+V) すると新規レイヤーになります")
        return True

    def use_as_input(self):
        if self.selected is not None:
            self.inputs = [self.results[self.selected][0]] + self.inputs[1:]
            self._refresh_inputs()
            self.status.set("結果を元画像に置き換えました。続けて指示を出せます")

    def save_selected(self):
        if self.selected is None:
            return
        img, path = self.results[self.selected]
        dest = filedialog.asksaveasfilename(defaultextension=".png", initialfile=path.name,
                                            filetypes=[("PNG", "*.png")])
        if dest:
            img.save(dest)

    def open_output_dir(self):
        path = Path(self.cfg["output_dir"]).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])

    # -------------------------------------------------------------- 設定

    def open_settings(self):
        win = tk.Toplevel(self.root)
        win.title("設定")
        win.transient(self.root)
        win.attributes("-topmost", bool(self.top_var.get()))
        fields = [
            ("Gemini API キー", "gemini_api_key", True),
            ("OpenAI API キー", "openai_api_key", True),
            ("保存先フォルダ", "output_dir", False),
            ("アップロード最大辺 (px)", "max_upload_edge", False),
            ("タイムアウト (秒)", "timeout", False),
            ("Gemini API URL", "gemini_base_url", False),
            ("OpenAI API URL", "openai_base_url", False),
        ]
        vars_ = {}
        for row, (label, key, secret) in enumerate(fields):
            ttk.Label(win, text=label).grid(row=row, column=0, sticky="w", padx=8, pady=4)
            var = tk.StringVar(value=str(self.cfg.get(key, "")))
            ttk.Entry(win, textvariable=var, width=48, show="•" if secret else "").grid(
                row=row, column=1, padx=8, pady=4)
            vars_[key] = var
        ttk.Label(win, foreground="gray",
                  text="キーは ~/.csp_ai_bridge/config.json に保存されます。\n"
                       "Gemini: https://aistudio.google.com/apikey  /  "
                       "OpenAI: https://platform.openai.com/api-keys").grid(
            row=len(fields), column=0, columnspan=2, padx=8, pady=4, sticky="w")

        def ok():
            for key, var in vars_.items():
                value = var.get().strip()
                if key in ("max_upload_edge", "timeout"):
                    try:
                        value = int(value)
                    except ValueError:
                        messagebox.showerror("設定", f"{key} は数値で入力してください", parent=win)
                        return
                self.cfg[key] = value
            self._save_cfg()
            win.destroy()

        ttk.Button(win, text="保存", command=ok).grid(row=len(fields) + 1, column=1, sticky="e",
                                                     padx=8, pady=8)


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista" if sys.platform == "win32" else "clam")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
