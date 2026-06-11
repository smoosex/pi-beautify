# pi-beautify

A small pi extension for visual polish.

## Cleaner markdown code blocks

Pi's terminal markdown renderer shows fenced code block borders like ```text. This extension hides those fence lines; plain text fences render as normal prose, while real code remains highlighted and indented.

## Clipboard image chips

Pi currently pastes clipboard images as long temporary file paths. This extension replaces newly pasted `pi-clipboard-*` paths in the editor with compact chips like `[image1]` for display, then restores those chips to the original file paths before the prompt is sent so the request stays identical to native pi behavior.

On macOS, if Ctrl+V sees Finder file URLs on the clipboard, the extension inserts those original file paths first and skips pi's image-reader path. This avoids Finder-copied files being saved as PNG file icons.

## Installation

```bash
pi install npm:@smoose/pi-beautify
```
