/**
 * FlyCode Note: Manual file picker injector
 * Adds floating upload buttons to select files or folders and inject summarized payload into chat input.
 */
import type { ExtensionSettings } from "../shared/types.js";

interface InstallUploadLauncherInput {
  getSettings: () => ExtensionSettings;
  onPayloadReady: (payload: string) => void;
  onStatus: (message: string, isError?: boolean) => void;
}

type PickerMode = "files" | "folder";

interface BuildUploadResult {
  payload: string;
  includedFiles: number;
  skippedFiles: number;
  truncatedFiles: number;
}

const KNOWN_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "csv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "php",
  "rb",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "xml",
  "html",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
  "log",
  "env",
  "gitignore"
]);

export function installUploadLauncher(input: InstallUploadLauncherInput): void {
  const existing = document.getElementById("flycode-upload-launcher");
  if (existing) {
    return;
  }

  const host = document.createElement("div");
  host.id = "flycode-upload-launcher";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "116px";
  host.style.zIndex = "2147483000";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.gap = "8px";

  const filesButton = createLauncherButton("FlyCode 文件", "选择一个或多个文件并注入输入框");
  const folderButton = createLauncherButton("FlyCode 目录", "选择目录并挑选要发送的文件");

  filesButton.addEventListener("click", () => {
    void handlePick("files", input);
  });

  folderButton.addEventListener("click", () => {
    void handlePick("folder", input);
  });

  host.append(filesButton, folderButton);
  document.body.appendChild(host);
}

function createLauncherButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.border = "1px solid #6a86ff";
  button.style.background = "#ffffff";
  button.style.color = "#2c4cff";
  button.style.fontSize = "12px";
  button.style.fontWeight = "600";
  button.style.padding = "8px 12px";
  button.style.borderRadius = "999px";
  button.style.cursor = "pointer";
  button.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.12)";
  return button;
}

async function handlePick(mode: PickerMode, input: InstallUploadLauncherInput): Promise<void> {
  try {
    const picked = await pickFiles(mode);
    if (!picked || picked.length === 0) {
      input.onStatus("未选择文件", false);
      return;
    }

    let selected = picked;
    if (mode === "folder") {
      const subset = chooseFilesFromFolder(selected);
      if (subset === null) {
        input.onStatus("已取消目录文件选择", false);
        return;
      }
      selected = subset;
      if (selected.length === 0) {
        input.onStatus("未选择要发送的目录文件", false);
        return;
      }
    }

    const settings = input.getSettings();
    const built = await buildUploadPayload(selected, mode, settings.maxInjectTokens);
    input.onPayloadReady(built.payload);
    input.onStatus(
      `已注入 ${built.includedFiles} 个文件${built.truncatedFiles > 0 ? `（截断 ${built.truncatedFiles} 个）` : ""}${built.skippedFiles > 0 ? `（跳过 ${built.skippedFiles} 个）` : ""}`,
      false
    );
  } catch (error) {
    input.onStatus(`文件注入失败: ${(error as Error).message}`, true);
  }
}

async function pickFiles(mode: PickerMode): Promise<File[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "-9999px";

  if (mode === "folder") {
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
  }

  return new Promise<File[]>((resolve) => {
    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        resolve(files);
      },
      { once: true }
    );

    document.body.appendChild(input);
    input.click();
  });
}

function chooseFilesFromFolder(files: File[]): File[] | null {
  if (files.length <= 1) {
    return files;
  }

  const sorted = [...files].sort((a, b) => getDisplayPath(a).localeCompare(getDisplayPath(b)));
  const previewLimit = Math.min(sorted.length, 80);
  const lines = sorted.slice(0, previewLimit).map((file, index) => `${index + 1}. ${getDisplayPath(file)}`);

  const answer = window.prompt(
    [
      `目录共 ${sorted.length} 个文件。`,
      "输入要发送的文件编号（逗号分隔），留空=发送全部，0=取消。",
      "",
      ...lines,
      sorted.length > previewLimit ? `... 仅展示前 ${previewLimit} 个` : ""
    ].join("\n")
  );

  if (answer === null || answer.trim() === "0") {
    return null;
  }

  const trimmed = answer.trim();
  if (!trimmed) {
    return sorted;
  }

  const indices = new Set(
    trimmed
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= sorted.length)
  );

  return sorted.filter((_, index) => indices.has(index + 1));
}

async function buildUploadPayload(files: File[], mode: PickerMode, maxTokens: number): Promise<BuildUploadResult> {
  const sorted = [...files].sort((a, b) => getDisplayPath(a).localeCompare(getDisplayPath(b)));

  const charBudget = Math.max(2000, maxTokens * 4);
  let remaining = charBudget;
  let includedFiles = 0;
  let skippedFiles = 0;
  let truncatedFiles = 0;

  const sections: string[] = [];

  for (const file of sorted) {
    if (remaining < 240) {
      skippedFiles += 1;
      continue;
    }

    const filePath = getDisplayPath(file);
    const header = `[file] ${filePath} (${file.size} bytes)`;

    if (!isLikelyTextFile(file)) {
      sections.push(`${header}\n[content]\n<binary or unsupported text format skipped>`);
      remaining -= header.length + 60;
      skippedFiles += 1;
      continue;
    }

    let content: string;
    try {
      content = normalizeText(await file.text());
    } catch {
      sections.push(`${header}\n[content]\n<failed to read file text>`);
      remaining -= header.length + 40;
      skippedFiles += 1;
      continue;
    }

    const perFileLimit = Math.max(600, Math.floor(charBudget / Math.max(1, sorted.length)));
    const maxAllowed = Math.min(perFileLimit, Math.max(200, remaining - 160));

    let snippet = content;
    let truncated = false;

    if (snippet.length > maxAllowed) {
      snippet = `${snippet.slice(0, maxAllowed)}\n...[TRUNCATED_BY_FLYCODE_UPLOAD_BUDGET]`;
      truncated = true;
    }

    sections.push(`${header}\n[content]\n${snippet}`);
    remaining -= header.length + snippet.length + 40;
    includedFiles += 1;
    if (truncated) {
      truncatedFiles += 1;
    }
  }

  const payloadLines = [
    "```flycode-upload",
    "[source] flycode-file-picker",
    `[mode] ${mode}`,
    `[selected] ${sorted.length}`,
    `[included] ${includedFiles}`,
    `[skipped] ${skippedFiles}`,
    `[truncated] ${truncatedFiles}`,
    `[generatedAt] ${new Date().toISOString()}`,
    "[content-begin]",
    ...sections,
    "[content-end]",
    "```"
  ];

  return {
    payload: payloadLines.join("\n\n"),
    includedFiles,
    skippedFiles,
    truncatedFiles
  };
}

function getDisplayPath(file: File): string {
  const withRelative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return withRelative && withRelative.trim() ? withRelative : file.name;
}

function normalizeText(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r\n/g, "\n");
}

function isLikelyTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) {
    return true;
  }

  if (file.type === "application/json" || file.type === "application/xml") {
    return true;
  }

  const name = file.name.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : name;
  return KNOWN_TEXT_EXTENSIONS.has(ext);
}
