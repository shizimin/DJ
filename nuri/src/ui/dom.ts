// 小さな DOM 生成ヘルパー。

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (k in el && k !== "style" && k !== "list") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** ラベル付きスライダー */
export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  const fmt = opts.format ?? ((v: number) => String(v));
  const out = h("span", { class: "val" }, fmt(opts.value));
  const input = h("input", {
    type: "range",
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    value: opts.value,
    onInput: () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      opts.onInput(v);
    },
    onChange: () => opts.onCommit?.(Number(input.value)),
  });
  const row = h("label", { class: "slider" }, h("span", { class: "lbl" }, opts.label), input, out);
  return Object.assign(row, {
    set(v: number) {
      input.value = String(v);
      out.textContent = fmt(v);
    },
  });
}

export function select<T extends string>(value: T, options: Record<T, string> | [T, string][], onChange: (v: T) => void) {
  const entries = Array.isArray(options) ? options : (Object.entries(options) as [T, string][]);
  const el = h("select", { onChange: () => onChange(el.value as T) }, ...entries.map(([k, label]) => h("option", { value: k }, label)));
  el.value = value;
  return el;
}

export function modal(title: string, body: Node, actions: { label: string; primary?: boolean; onClick: () => boolean | void | Promise<boolean | void> }[]) {
  const close = () => backdrop.remove();
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onMousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h(
      "div",
      { class: "modal" },
      h("h2", {}, title),
      body,
      h(
        "div",
        { class: "actions" },
        ...actions.map((a) =>
          h(
            "button",
            {
              class: a.primary ? "primary" : "",
              onClick: async () => {
                if ((await a.onClick()) !== false) close();
              },
            },
            a.label,
          ),
        ),
      ),
    ),
  );
  document.body.appendChild(backdrop);
  const first = backdrop.querySelector<HTMLElement>("input, textarea, select");
  first?.focus();
  return close;
}

/** ファイル選択ダイアログ */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple });
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

export function download(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
