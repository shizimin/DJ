// 非圧縮 tar (ustar) の最小限の読み込み。.sut の MaterialFile.FileData で使われている。

export function readTar(b: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const text = (o: number, n: number) => {
    let end = o;
    while (end < o + n && b[end]) end++;
    return new TextDecoder().decode(b.subarray(o, end));
  };
  let o = 0;
  while (o + 512 <= b.length) {
    const name = text(o, 100);
    if (!name) break;
    const size = parseInt(text(o + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(b[o + 156] || 48);
    const prefix = text(o + 257, 6).startsWith("ustar") ? text(o + 345, 155) : "";
    const full = prefix ? `${prefix}/${name}` : name;
    if (type === "0" || type === "\0") files.set(full, b.subarray(o + 512, o + 512 + size));
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
