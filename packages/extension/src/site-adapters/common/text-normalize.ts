/**
 * FlyCode Note: Shared text normalization helpers
 * Pure string utilities used by all site adapters and protocol parsers.
 */

export function normalizeBlockText(text: string): string {
  return stripZeroWidth(text).replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}

export function stripZeroWidth(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function stripLineNumberPrefix(line: string): string {
  return line.replace(/^\s*\d+\s+/, "");
}

export function normalizeLines(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const normalized = normalizeBlockText(stripLineNumberPrefix(line));
    if (!normalized) {
      continue;
    }
    out.push(normalized);
  }
  return out.join("\n").trim();
}
