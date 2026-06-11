import { spawnSync } from "node:child_process";

import { CustomEditor, type AppKeybinding, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Markdown, matchesKey, truncateToWidth, type AutocompleteProvider, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

interface Attachment {
  token: string;
  path: string;
}

const CLIPBOARD_PATH_RE = /(?:[^\s"'`<>]+[\\/])?pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)/gi;
const TOKEN_RE = /\[image(\d+)\]/g;
const TOKEN_LINE_RE = /\[image\d+\]/g;
const IMAGE_FILE_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const MARKDOWN_PATCH_STATE = Symbol.for("smoose.pi-beautify.markdown.patch");
const PLAIN_CODE_LANGS = new Set(["", "text", "plain", "plaintext"]);
const MACOS_CLIPBOARD_FILE_PATHS_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const pb = $.NSPasteboard.generalPasteboard;
const classes = $.NSArray.arrayWithObject($.NSURL);
const options = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
const urls = pb.readObjectsForClassesOptions(classes, options);
const paths = [];
if (urls) {
  for (let i = 0; i < urls.count; i++) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
  }
}
JSON.stringify(paths);
`;

interface MarkdownCodeToken {
  type: "code";
  lang?: string;
  text?: string;
}

interface BeautifyMarkdownTheme {
  codeBlock: (text: string) => string;
  codeBlockIndent?: string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface MarkdownRuntime {
  theme: BeautifyMarkdownTheme;
  applyDefaultStyle?: (text: string) => string;
}

type MarkdownRenderToken = (this: MarkdownRuntime, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];

interface MarkdownPatchState {
  installed: true;
  original: MarkdownRenderToken;
  renderCodeToken: (instance: MarkdownRuntime, token: MarkdownCodeToken, nextTokenType?: string) => string[];
}

type PatchedMarkdownPrototype = {
  renderToken?: MarkdownRenderToken;
  [key: symbol]: unknown;
};

function isMarkdownCodeToken(token: unknown): token is MarkdownCodeToken {
  return typeof token === "object" && token !== null && (token as { type?: unknown }).type === "code";
}

function renderCodeTokenWithoutFences(instance: MarkdownRuntime, token: MarkdownCodeToken, nextTokenType?: string): string[] {
  const raw = typeof token.text === "string" ? token.text : "";
  const lang = typeof token.lang === "string" ? token.lang.trim().toLowerCase() : "";
  const lines: string[] = [];

  if (PLAIN_CODE_LANGS.has(lang)) {
    for (const line of raw.split("\n")) lines.push(instance.applyDefaultStyle?.(line) ?? line);
  } else if (instance.theme.highlightCode) {
    const indent = instance.theme.codeBlockIndent ?? "  ";
    for (const line of instance.theme.highlightCode(raw, token.lang)) lines.push(`${indent}${line}`);
  } else {
    const indent = instance.theme.codeBlockIndent ?? "  ";
    for (const line of raw.split("\n")) lines.push(`${indent}${instance.theme.codeBlock(line)}`);
  }

  if (nextTokenType && nextTokenType !== "space") lines.push("");
  return lines;
}

function installMarkdownFencePatch(): void {
  const proto = Markdown.prototype as unknown as PatchedMarkdownPrototype;
  const existing = proto[MARKDOWN_PATCH_STATE] as MarkdownPatchState | undefined;
  if (existing?.installed) {
    existing.renderCodeToken = renderCodeTokenWithoutFences;
    return;
  }

  const original = proto.renderToken;
  if (typeof original !== "function") return;

  const state: MarkdownPatchState = {
    installed: true,
    original,
    renderCodeToken: renderCodeTokenWithoutFences,
  };
  proto[MARKDOWN_PATCH_STATE] = state;

  proto.renderToken = function (this: MarkdownRuntime, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
    const current = proto[MARKDOWN_PATCH_STATE] as MarkdownPatchState | undefined;
    if (current && isMarkdownCodeToken(token)) return current.renderCodeToken(this, token, nextTokenType);
    return (current?.original ?? original).call(this, token, width, nextTokenType, styleContext);
  };
}

function imageChip(id: number): string {
  return `[image${id}]`;
}

function displayChip(token: string, theme: Theme): string {
  return theme.fg("toolDiffAdded", theme.inverse(token));
}

function readClipboardFilePaths(): string[] {
  if (process.platform !== "darwin") return [];

  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", MACOS_CLIPBOARD_FILE_PATHS_SCRIPT], {
    encoding: "utf8",
    timeout: 700,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];

  try {
    const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((path): path is string => {
      if (typeof path !== "string" || path.length === 0 || seen.has(path)) return false;
      seen.add(path);
      return true;
    });
  } catch {
    return [];
  }
}

function pasteClipboardFilePaths(editor: EditorComponent, imageTokens: ImageTokenController, tui: TUI): boolean {
  const paths = readClipboardFilePaths();
  if (paths.length === 0) return false;

  const text = imageTokens.formatClipboardFilePaths(paths, editor.getText());
  if (!text) return false;

  if (editor.insertTextAtCursor) {
    editor.insertTextAtCursor(text);
  } else {
    editor.setText(editor.getText() + text);
    editor.onChange?.(editor.getText());
  }
  tui.requestRender();
  return true;
}

interface EditorInternals {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  historyIndex: number;
  lastAction: string | null;
  pushUndoSnapshot: () => void;
  setCursorCol: (col: number) => void;
}

class ImageTokenController {
  constructor(private readonly attachments: Map<string, Attachment>) {}

  renderChips(lines: string[], theme: Theme, width: number): string[] {
    let rendered = lines;
    for (const attachment of this.attachments.values()) {
      rendered = rendered.map((line) => line.replaceAll(attachment.token, displayChip(attachment.token, theme)));
    }
    return rendered.map((line) => truncateToWidth(line, width, ""));
  }

  replaceClipboardPathsInText(text: string, existingText = ""): string {
    const usedIds = this.collectUsedIds(`${existingText}\n${text}`);
    return text.replace(CLIPBOARD_PATH_RE, (path) => this.createImageToken(path, usedIds));
  }

  formatClipboardFilePaths(paths: string[], existingText = ""): string {
    const usedIds = this.collectUsedIds(existingText);
    const pieces = paths.map((path) => (IMAGE_FILE_RE.test(path) ? this.createImageToken(path, usedIds).trimEnd() : path));
    return pieces.length > 0 ? `${pieces.join(paths.length > 1 ? "\n" : "")} ` : "";
  }

  replaceClipboardPathsInEditor(editor: EditorComponent, tui: TUI): void {
    const current = editor.getText();
    const usedIds = this.collectUsedIds(current);
    let changed = false;
    const next = current.replace(CLIPBOARD_PATH_RE, (path) => {
      changed = true;
      return this.createImageToken(path, usedIds);
    });
    if (!changed) return;
    editor.setText(next);
    tui.requestRender();
  }

  deleteImageTokenAtCursor(editor: EditorComponent, data: string, tui: TUI): boolean {
    const keybindings = getKeybindings();
    const backward = keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace");
    const forward = keybindings.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete");
    if (!backward && !forward) return false;

    const writableEditor = editor as unknown as Partial<EditorInternals>;
    if (!writableEditor.state || !writableEditor.pushUndoSnapshot || !writableEditor.setCursorCol) return false;

    const line = writableEditor.state.lines[writableEditor.state.cursorLine] || "";
    const range = this.findImageTokenDeleteRange(line, writableEditor.state.cursorCol, backward);
    if (!range) return false;

    writableEditor.historyIndex = -1;
    writableEditor.lastAction = null;
    writableEditor.pushUndoSnapshot();
    writableEditor.state.lines[writableEditor.state.cursorLine] = line.slice(0, range.start) + line.slice(range.end);
    writableEditor.setCursorCol(range.start);
    this.attachments.delete(range.token);
    editor.onChange?.(editor.getText());
    tui.requestRender();
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

  private collectUsedIds(text: string): Set<number> {
    const usedIds = new Set<number>();
    for (const match of text.matchAll(TOKEN_RE)) usedIds.add(Number(match[1]));
    return usedIds;
  }

  private createImageToken(path: string, usedIds: Set<number>): string {
    let id = 1;
    while (usedIds.has(id)) id++;
    usedIds.add(id);
    const token = imageChip(id);
    this.attachments.set(token, { token, path });
    return `${token} `;
  }
}

class BeautifyEditor extends CustomEditor {
  private scanTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly appKeybindings: KeybindingsManager,
    private readonly imageTokens: ImageTokenController,
    private readonly getTheme: () => Theme,
  ) {
    super(tui, theme, appKeybindings);
  }

  handleInput(data: string): void {
    const isImagePaste = this.appKeybindings.matches(data, "app.clipboard.pasteImage");
    if (isImagePaste) {
      if (this.onExtensionShortcut?.(data)) return;
      if (pasteClipboardFilePaths(this, this.imageTokens, this.tui)) return;
      this.onPasteImage?.();
      this.scheduleClipboardPathScan();
      return;
    }
    if (this.imageTokens.deleteImageTokenAtCursor(this, data, this.tui)) return;
    super.handleInput(data);
  }

  insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(this.imageTokens.replaceClipboardPathsInText(text, this.getText()));
  }

  render(width: number): string[] {
    return this.imageTokens.renderChips(super.render(width), this.getTheme(), width);
  }

  private scheduleClipboardPathScan(): void {
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers = [80, 250, 600].map((delay) =>
      setTimeout(() => {
        this.imageTokens.replaceClipboardPathsInEditor(this, this.tui);
      }, delay),
    );
  }
}

class BeautifyEditorWrapper implements EditorComponent {
  actionHandlers = new Map<AppKeybinding, () => void>();
  private scanTimers: Array<ReturnType<typeof setTimeout>> = [];
  private _onSubmit: ((text: string) => void) | undefined;
  private _onChange: ((text: string) => void) | undefined;
  onEscape: (() => void) | undefined;
  onCtrlD: (() => void) | undefined;
  onPasteImage: (() => void) | undefined;
  onExtensionShortcut: ((data: string) => boolean) | undefined;

  constructor(
    private readonly inner: EditorComponent,
    private readonly tui: TUI,
    private readonly appKeybindings: KeybindingsManager,
    private readonly imageTokens: ImageTokenController,
    private readonly getTheme: () => Theme,
  ) {}

  get focused(): boolean {
    return Boolean((this.inner as EditorComponent & { focused?: boolean }).focused);
  }

  set focused(value: boolean) {
    (this.inner as EditorComponent & { focused?: boolean }).focused = value;
  }

  get borderColor(): ((str: string) => string) | undefined {
    return this.inner.borderColor;
  }

  set borderColor(value: ((str: string) => string) | undefined) {
    this.inner.borderColor = value;
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this._onSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this._onSubmit = handler;
    this.inner.onSubmit = handler;
  }

  get onChange(): ((text: string) => void) | undefined {
    return this._onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this._onChange = handler;
    this.inner.onChange = handler;
  }

  getText(): string {
    return this.inner.getText();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  getExpandedText(): string {
    return this.inner.getExpandedText?.() ?? this.inner.getText();
  }

  addToHistory(text: string): void {
    this.inner.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    const next = this.imageTokens.replaceClipboardPathsInText(text, this.inner.getText());
    if (this.inner.insertTextAtCursor) {
      this.inner.insertTextAtCursor(next);
      return;
    }
    this.inner.setText(this.inner.getText() + next);
    this.inner.onChange?.(this.inner.getText());
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.inner.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.inner.setAutocompleteMaxVisible?.(maxVisible);
  }

  onAction(action: AppKeybinding, handler: () => void): void {
    this.actionHandlers.set(action, handler);
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }

  render(width: number): string[] {
    return this.imageTokens.renderChips(this.inner.render(width), this.getTheme(), width);
  }

  handleInput(data: string): void {
    const isImagePaste = this.appKeybindings.matches(data, "app.clipboard.pasteImage");
    if (this.onExtensionShortcut?.(data)) return;
    if (this.imageTokens.deleteImageTokenAtCursor(this.inner, data, this.tui)) return;
    if (isImagePaste) {
      if (pasteClipboardFilePaths(this, this.imageTokens, this.tui)) return;
      this.onPasteImage?.();
      this.scheduleClipboardPathScan();
      return;
    }
    if (this.handleAppAction(data)) return;
    this.inner.handleInput(data);
  }

  private handleAppAction(data: string): boolean {
    if (this.appKeybindings.matches(data, "app.interrupt")) {
      if (!this.isShowingAutocomplete()) {
        const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
        if (handler) {
          handler();
          return true;
        }
      }
      return false;
    }

    if (this.appKeybindings.matches(data, "app.exit")) {
      if (this.getText().length === 0) {
        const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
        if (handler) {
          handler();
          return true;
        }
      }
    }

    for (const [action, handler] of this.actionHandlers) {
      if (action !== "app.interrupt" && action !== "app.exit" && this.appKeybindings.matches(data, action)) {
        handler();
        return true;
      }
    }

    return false;
  }

  private isShowingAutocomplete(): boolean {
    const inner = this.inner as EditorComponent & { isShowingAutocomplete?: () => boolean };
    return inner.isShowingAutocomplete?.() ?? false;
  }

  private scheduleClipboardPathScan(): void {
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers = [80, 250, 600].map((delay) =>
      setTimeout(() => {
        this.imageTokens.replaceClipboardPathsInEditor(this.inner, this.tui);
      }, delay),
    );
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

export default function piBeautify(pi: ExtensionAPI) {
  installMarkdownFencePatch();

  const attachments = new Map<string, Attachment>();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    attachments.clear();
    const previousEditorFactory = ctx.ui.getEditorComponent();
    const imageTokens = new ImageTokenController(attachments);
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      if (!previousEditorFactory) {
        return new BeautifyEditor(tui, theme, keybindings, imageTokens, () => ctx.ui.theme);
      }
      return new BeautifyEditorWrapper(previousEditorFactory(tui, theme, keybindings), tui, keybindings, imageTokens, () => ctx.ui.theme);
    });
    ctx.ui.setStatus("pi-beautify", ctx.ui.theme.fg("dim", "beautify"));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    attachments.clear();
    if (ctx.hasUI) ctx.ui.setStatus("pi-beautify", undefined);
  });

  pi.on("input", async (event) => {
    const selected = collectImageAttachments(event.text, attachments);
    if (selected.length === 0) return { action: "continue" };

    const text = event.text.replace(TOKEN_RE, (full, id) => attachments.get(imageChip(Number(id)))?.path ?? full);
    for (const attachment of selected) attachments.delete(attachment.token);

    return {
      action: "transform",
      text,
      images: event.images,
    };
  });
}
