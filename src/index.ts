import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

interface Attachment {
  token: string;
  path: string;
  mimeType: string;
}

const CLIPBOARD_PATH_RE = /(?:[^\s"'`<>]+[\\/])?pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)/gi;
const TOKEN_RE = /\[image(\d+)\]/g;

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function imageChip(id: number): string {
  return `[image${id}]`;
}

function displayChip(token: string, theme: Theme): string {
  return theme.fg("toolDiffAdded", theme.inverse(token));
}

class BeautifyEditor extends CustomEditor {
  private nextId = 1;
  private scanTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly appKeybindings: KeybindingsManager,
    private readonly attachments: Map<string, Attachment>,
    private readonly getTheme: () => Theme,
  ) {
    super(tui, theme, appKeybindings);
  }

  handleInput(data: string): void {
    const isImagePaste = this.appKeybindings.matches(data, "app.clipboard.pasteImage");
    super.handleInput(data);
    if (isImagePaste) this.scheduleClipboardPathScan();
  }

  insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(this.replaceClipboardPathsInText(text));
  }

  render(width: number): string[] {
    let lines = super.render(width);
    const currentTheme = this.getTheme();
    for (const attachment of this.attachments.values()) {
      lines = lines.map((line) => line.replaceAll(attachment.token, displayChip(attachment.token, currentTheme)));
    }
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private scheduleClipboardPathScan(): void {
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers = [80, 250, 600].map((delay) =>
      setTimeout(() => {
        this.replaceClipboardPaths();
      }, delay),
    );
  }

  private replaceClipboardPaths(): void {
    const current = this.getText();
    let changed = false;
    const next = current.replace(CLIPBOARD_PATH_RE, (path) => {
      changed = true;
      return this.createImageToken(path);
    });
    if (changed) {
      this.setText(next);
      this.tui.requestRender();
    }
  }

  private replaceClipboardPathsInText(text: string): string {
    return text.replace(CLIPBOARD_PATH_RE, (path) => this.createImageToken(path));
  }

  private createImageToken(path: string): string {
    const token = imageChip(this.nextId++);
    this.attachments.set(token, { token, path, mimeType: mimeTypeForPath(path) });
    return `${token} `;
  }
}

function collectImageAttachments(text: string, attachments: Map<string, Attachment>): Attachment[] {
  const selected: Attachment[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = imageChip(Number(match[1]));
    if (seen.has(token)) continue;
    const attachment = attachments.get(token);
    if (!attachment) continue;
    seen.add(token);
    selected.push(attachment);
  }
  return selected;
}

function toImageContent(attachment: Attachment): ImageContent | undefined {
  if (!existsSync(attachment.path)) return undefined;
  return {
    type: "image",
    data: readFileSync(attachment.path).toString("base64"),
    mimeType: attachment.mimeType,
  };
}

export default function piBeautify(pi: ExtensionAPI) {
  const attachments = new Map<string, Attachment>();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    attachments.clear();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new BeautifyEditor(tui, theme, keybindings, attachments, () => ctx.ui.theme));
    ctx.ui.setStatus("pi-beautify", ctx.ui.theme.fg("dim", "beautify"));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    attachments.clear();
    if (ctx.hasUI) ctx.ui.setStatus("pi-beautify", undefined);
  });

  pi.on("input", async (event, ctx) => {
    const selected = collectImageAttachments(event.text, attachments);
    if (selected.length === 0) return { action: "continue" };

    const converted = selected.map(toImageContent).filter((image): image is ImageContent => image !== undefined);
    if (converted.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("pi-beautify: image file disappeared before submit", "warning");
      return { action: "continue" };
    }

    for (const attachment of selected) attachments.delete(attachment.token);

    const text = event.text.replace(TOKEN_RE, (_full, id) => `[attached image ${id}]`);
    return {
      action: "transform",
      text,
      images: [...(event.images ?? []), ...converted],
    };
  });
}
