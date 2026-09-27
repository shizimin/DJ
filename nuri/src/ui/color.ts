// HSV カラーピッカー (彩度・明度の四角 + 色相バー) と最近使った色。

import type { Editor } from "../core/editor";
import { h } from "./dom";

function hsvToHex(hh: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + hh / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return "#" + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return [hh, max ? d / max : 0, max];
}

export function colorPanel(editor: Editor) {
  const SV = 180;
  const sv = h("canvas", { width: SV, height: SV, class: "sv" });
  const hue = h("canvas", { width: 16, height: SV, class: "hue" });
  const swatch = h("input", { type: "color", class: "swatch", title: "色を直接指定" });
  const hexInput = h("input", { class: "hex", maxLength: 7, spellcheck: false });
  const recent = h("div", { class: "recent" });
  let [H, S, V] = hexToHsv(editor.color);
  let lastRendered = "";

  const drawSV = () => {
    const g = sv.getContext("2d")!;
    g.fillStyle = hsvToHex(H, 1, 1);
    g.fillRect(0, 0, SV, SV);
    const w = g.createLinearGradient(0, 0, SV, 0);
    w.addColorStop(0, "#fff");
    w.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = w;
    g.fillRect(0, 0, SV, SV);
    const b = g.createLinearGradient(0, 0, 0, SV);
    b.addColorStop(0, "rgba(0,0,0,0)");
    b.addColorStop(1, "#000");
    g.fillStyle = b;
    g.fillRect(0, 0, SV, SV);
    g.beginPath();
    g.arc(S * SV, (1 - V) * SV, 5, 0, Math.PI * 2);
    g.strokeStyle = V > 0.5 ? "#000" : "#fff";
    g.lineWidth = 2;
    g.stroke();
  };
  const drawHue = () => {
    const g = hue.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, SV);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, hsvToHex(i * 60, 1, 1));
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, SV);
    g.fillStyle = "#fff";
    g.fillRect(0, (H / 360) * SV - 1.5, 16, 3);
  };
  const apply = () => {
    const hex = hsvToHex(H, S, V);
    lastRendered = hex;
    editor.setColor(hex);
    drawSV();
    drawHue();
  };
  const drag = (el: HTMLCanvasElement, fn: (x: number, y: number) => void) => {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
      };
      move(e);
      el.onpointermove = move;
      el.onpointerup = () => {
        el.onpointermove = null;
        editor.setColor(editor.color, true);
      };
    });
  };
  drag(sv, (x, y) => {
    S = x;
    V = 1 - y;
    apply();
  });
  drag(hue, (_x, y) => {
    H = Math.min(359.9, y * 360);
    apply();
  });
  swatch.addEventListener("input", () => editor.setColor(swatch.value, true));
  hexInput.addEventListener("change", () => {
    const v = hexInput.value.startsWith("#") ? hexInput.value : "#" + hexInput.value;
    if (/^#[0-9a-f]{6}$/i.test(v)) editor.setColor(v.toLowerCase(), true);
  });

  const sync = () => {
    swatch.value = editor.color;
    if (document.activeElement !== hexInput) hexInput.value = editor.color;
    if (editor.color !== lastRendered) {
      [H, S, V] = hexToHsv(editor.color);
      lastRendered = editor.color;
      drawSV();
      drawHue();
    }
    const colors = ["#000000", "#ffffff", ...editor.recentColors.filter((c) => c !== "#000000" && c !== "#ffffff")].slice(0, 16);
    if (recent.dataset.key !== colors.join()) {
      recent.dataset.key = colors.join();
      recent.replaceChildren(...colors.map((c) => h("button", { class: "chip", style: `background:${c}`, title: c, onClick: () => editor.setColor(c) })));
    }
  };
  editor.onChange(sync);
  sync();
  drawSV();
  drawHue();
  return h("section", { class: "panel color-panel" }, h("div", { class: "picker" }, sv, hue), h("div", { class: "row" }, swatch, hexInput), recent);
}
