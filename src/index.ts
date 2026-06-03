import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getKeybindings, matchesKey, truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

interface Attachment {
  token: string;
  path: string;
  mimeType: string;
}

const CLIPBOARD_PATH_RE = /(?:[^\s"'`<>]+[\\/])?pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)/gi;
const TOKEN_RE = /\[image(\d+)\]/g;
const TOKEN_LINE_RE = /\[image\d+\]/g;

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
    if (this.deleteImageTokenAtCursor(data)) return;
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

  private deleteImageTokenAtCursor(data: string): boolean {
    const keybindings = getKeybindings();
    const backward = keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace");
    const forward = keybindings.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete");
    if (!backward && !forward) return false;

    const editor = this as unknown as {
      state: { lines: string[]; cursorLine: number; cursorCol: number };
      historyIndex: number;
      lastAction: string | null;
      pushUndoSnapshot: () => void;
      setCursorCol: (col: number) => void;
    };
    const line = editor.state.lines[editor.state.cursorLine] || "";
    const range = this.findImageTokenDeleteRange(line, editor.state.cursorCol, backward);
    if (!range) return false;

    editor.historyIndex = -1;
    editor.lastAction = null;
    editor.pushUndoSnapshot();
    editor.state.lines[editor.state.cursorLine] = line.slice(0, range.start) + line.slice(range.end);
    editor.setCursorCol(range.start);
    this.attachments.delete(range.token);
    if (this.onChange) this.onChange(this.getText());
    this.tui.requestRender();
    return true;
  }

  private findImageTokenDeleteRange(line: string, cursorCol: number, backward: boolean): { start: number; end: number; token: string } | undefined {
    for (const match of line.matchAll(TOKEN_LINE_RE)) {
      const token = match[0];
      const start = match.index;
      let end = start + token.length;
      if (backward) {
        if (start < cursorCol && cursorCol <= end) return { start, end, token };
        if (cursorCol === end + 1 && line[end] === " ") return { start, end: end + 1, token };
      } else if (start <= cursorCol && cursorCol < end) {
        if (line[end] === " ") end += 1;
        return { start, end, token };
      }
    }
    return undefined;
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
