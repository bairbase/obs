import type { App, TFile } from "obsidian";

/** Read a boolean frontmatter key, accepting common truthy/falsy strings. */
function readFmBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes" || v === "1") return true;
    if (v === "false" || v === "no" || v === "0") return false;
  }
  return null;
}

/**
 * Whether a note should open in Butter automatically.
 * Frontmatter `butter` or `butter-editor` overrides the global
 * `openNewFilesInButter` default when present.
 */
export function shouldOpenInButter(
  app: App,
  file: TFile,
  defaultOpen: boolean,
): boolean {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return defaultOpen;
  const butter = readFmBool(fm.butter);
  if (butter !== null) return butter;
  const butterEditor = readFmBool(fm["butter-editor"]);
  if (butterEditor !== null) return butterEditor;
  return defaultOpen;
}
