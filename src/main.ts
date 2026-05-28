import {
  Plugin,
  App,
  TextFileView,
  ItemView,
  MarkdownView,
  Component,
  setIcon,
  addIcon,
  Menu,
  MenuItem,
  Modal,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  ViewStateResult,
} from "obsidian";
import { EditorState, Plugin as PMPlugin, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";

// Extensions MUST be registered before schema.ts or obsidian-md-bridge
// evaluate their module bodies - those are where the registry is
// read to build the live schema / token handlers / serializers.
// The internal Extension API exists, but no example extensions are
// activated in shipped builds. The dogfooded `:::spoiler` block +
// `@username` inline atom previously imported from
// `./integration/extensions-examples` are now developer reference
// only (see that file's header). To turn them back on for local
// dev / testing, re-add the side-effect import here ABOVE the
// schema/parser/serializer imports below.

import { schema } from "./core/schema";
import { parser } from "./core/parser";
import { serializer } from "./core/serializer";
import { normalize as normalizeSource } from "./core/normalize";
import { debug, setVerbose, recordError, getErrorLog, clearErrorLog } from "./integration/debug";
import {
  buildKeymap,
  buildInputRules,
  contextMenuPlugin,
  trimDblClickSelectionPlugin,
} from "./editor/editor-ux";
import { autocompletePlugin } from "./editor/autocomplete";
import { createToolbar } from "./ui/toolbar";
import {
  type LayoutItem as ToolbarLayoutItem,
  defaultMainLayout,
  defaultTableLayout,
  migrateFromHiddenList,
  migrateLegacyHeadingButton,
  mobileLayoutDefault,
  mobileTableLayoutDefault,
} from "./ui/toolbar-layout";
export type { ToolbarLayoutItem };
import { slashMenuPlugin } from "./ui/slash-menu";
import { pasteDropPlugin } from "./editor/paste-drop";
import { overlapResolverPlugin } from "./core/overlap-resolver";
import { suggestBridgePlugin } from "./util/suggest-bridge";
import { cm6BridgePlugins } from "./integration/cm6-bridge";
import { tableEditingPlugins } from "./editor/table-editing";
import { tableToolbarPlugin } from "./editor/table-toolbar";
import { toggleMark } from "prosemirror-commands";
import type { MarkType, Node as PMNode } from "prosemirror-model";
import { checkboxPlugin } from "./editor/checkbox-plugin";
import { listNumberingPlugin } from "./editor/list-numbering";
import { selectionOverlayPlugin } from "./editor/selection-overlay";
import { multiBlockSelectPlugin } from "./editor/multi-block-select";
import { listOperationsPlugin } from "./editor/list-operations";
import { searchPlugin, openFind, openReplace } from "./editor/search-plugin";
import { codeHighlightPlugin } from "./editor/code-highlight";
import { imageView } from "./editor/image-view";
import { PMEditorShim } from "./util/editor-shim";
import { installWordCount } from "./ui/word-count";
import {
  installSaveStatus,
  type SaveStatusController,
  type SaveState,
} from "./ui/save-status";
import { SaveDiffModal } from "./ui/save-diff-modal";
import { ShortcutHelpModal } from "./ui/shortcut-help";
import { dragHandlePlugin } from "./editor/drag-handles";
import { clickToSpawnPlugin } from "./editor/click-to-spawn";
import { inlineAtomEditPlugin } from "./editor/inline-atom-edit";
import { autoSplitImagesPlugin } from "./editor/auto-split-images";
import { tableRowColDragPlugin } from "./editor/table-row-col-drag";
import { tableCellDragPlugin } from "./editor/table-cell-drag";
import { normalizeTablesInDoc } from "./editor/table-normalize";
import {
  rawBlockSafetyPlugin,
  RAW_BLOCK_SYNC_META,
} from "./core/raw-block-safety";
import { SaveScheduler } from "./ui/save-scheduler";
import { ButterOutlineView, VIEW_TYPE_BUTTER_OUTLINE } from "./ui/outline-view";
import { scrollHost, scrollHostTop } from "./util/dom-utils";
import { ButterSettingTab } from "./ui/settings-tab";
import { WelcomeModal } from "./ui/welcome-modal";
import { LicenseClient, LicenseClientError } from "./integration/license/client";
import { mountLicenseBanner, type LicenseBanner } from "./ui/license-banner";
import {
  NodeViewManager,
  codeBlockView,
  embedView,
  embedInlineView,
  calloutView,
  mathBlockView,
  inlineMathView,
  wikilinkView,
  tagView,
  blockCommentView,
  inlineFootnoteView,
  footnoteRefView,
  footnoteDefView,
  blockIdView,
  rawBlockView,
  BUTTER_HOVER_SOURCE,
} from "./editor/nodeviews";

export const VIEW_TYPE_BUTTER = "butter-editor";
export const VIEW_TYPE_BUTTER_LOCKED = "butter-locked-file";

/**
 * Replacement view for a leaf whose file failed to load with a
 * file-system permission error (EPERM / EBUSY / EACCES) - typically
 * because another process (VS Code, antivirus, another Obsidian
 * window) is holding the file open exclusively. Instead of leaving
 * the user with a silent failure + cryptic console error, this view
 * takes over the leaf and explains what's happening with native-
 * styled action buttons. The leaf can flip back to a normal markdown/
 * Butter view at any time via the "Try again" button.
 */
class ButterLockedFileView extends ItemView {
  private lockedPath = "";
  private lockedName = "";

  constructor(leaf: WorkspaceLeaf, private plugin: ButterEditorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BUTTER_LOCKED;
  }

  getDisplayText(): string {
    return this.lockedName || "Locked file";
  }

  getIcon(): string {
    return "lock";
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as { lockedPath?: string; lockedName?: string } | null;
    this.lockedPath = s?.lockedPath ?? "";
    this.lockedName =
      s?.lockedName ??
      (this.lockedPath.split(/[\\/]/).pop() || this.lockedPath);
    this.render();
    await super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      lockedPath: this.lockedPath,
      lockedName: this.lockedName,
    };
  }

  async onOpen() {
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    // Use native `.empty-state` so the layout, title styling, and
    // action-button treatment (pill on mobile, plain link on
    // desktop) match Obsidian's new-tab page exactly. A Butter-
    // specific wrapper class is added too for our message + footer
    // styling, scoped so we don't bleed into other empty states.
    c.addClass("empty-state");
    c.addClass("butter-locked-state");

    const container = c.createDiv({ cls: "empty-state-container" });

    const iconEl = container.createDiv({ cls: "butter-locked-icon" });
    setIcon(iconEl, "file-lock-2");

    container.createEl("h1", {
      text: "Another app is using this file",
      cls: "empty-state-title",
    });

    const desc = container.createDiv({ cls: "butter-locked-message" });
    desc.createEl("code", {
      text: this.lockedName,
      cls: "butter-locked-filename",
    });
    desc.appendText(
      " can't be opened right now because another process on your device is locking it. Most likely: VS Code with the file open · antivirus mid-scan · another Obsidian window.",
    );

    const actions = container.createDiv({ cls: "empty-state-action-list" });

    const retryBtn = actions.createDiv({
      cls: "empty-state-action",
      text: "Try again",
    });
    retryBtn.addEventListener("click", () => {
      void (async () => {
        const file = this.app.vault.getAbstractFileByPath(this.lockedPath);
        if (file instanceof TFile) {
          await this.leaf.openFile(file);
        } else {
          new Notice("File no longer exists in vault.");
        }
      })();
    });

    const switcherBtn = actions.createDiv({
      cls: "empty-state-action",
      text: "Open another note",
    });
    switcherBtn.addEventListener("click", () => {
      this.app.commands?.executeCommandById("switcher:open");
    });

    const newBtn = actions.createDiv({
      cls: "empty-state-action",
      text: "New note",
    });
    newBtn.addEventListener("click", () => {
      this.app.commands?.executeCommandById("file-explorer:new-file");
    });
  }
}

// ═══════════════════════════════════════════
//  View-swap helpers - preserve caret across mode changes
// ═══════════════════════════════════════════

/**
 * Swap a Butter view's leaf to MarkdownView while preserving the
 * user's sense of place - which is dominated by the heading they
 * were currently reading under, not a precise caret position. We
 * capture the topmost above-the-fold heading's source-markdown line
 * and pass it as `eState.line`; MarkdownView's built-in handler
 * scrolls to that line.
 */
function swapButterToMarkdown(view: ButterEditorView) {
  if (!view.file) return;
  const line = view.visibleHeadingLine();
  void view.leaf.setViewState(
    {
      type: "markdown",
      state: { file: view.file.path, mode: "source" },
    },
    { line },
  );
}

/**
 * Mode identifier used by the cycle / view-as wiring. Maps to:
 *   source  → MarkdownView in Source mode (raw markdown text)
 *   live    → MarkdownView in Live Preview
 *   reading → MarkdownView in Reading view
 *   butter  → ButterEditorView (our PMX view type)
 */
export type ButterViewMode = "source" | "live" | "reading" | "butter";

/** Inspect a leaf and return which mode (if any) it's currently in. */
function getCurrentMode(leaf: WorkspaceLeaf): ButterViewMode | null {
  const view = leaf.view;
  if (view instanceof ButterEditorView) return "butter";
  if (view instanceof MarkdownView) {
    const mode = view.getMode();
    if (mode === "preview") return "reading";
    // editor mode - distinguish Source from Live Preview by the
    // `source` flag on view state.
    const state = view.getState() as { source?: boolean };
    return state.source ? "source" : "live";
  }
  return null;
}

/** Capture current visible heading line for scroll preservation. */
function captureLine(leaf: WorkspaceLeaf): number {
  const view = leaf.view;
  if (view instanceof ButterEditorView) return view.visibleHeadingLine();
  if (view instanceof MarkdownView) return visibleHeadingLineMD(view);
  return 0;
}

/** Switch a leaf to the requested mode. No-op if already there. */
async function switchToMode(
  leaf: WorkspaceLeaf,
  mode: ButterViewMode,
): Promise<void> {
  const view = leaf.view;
  const file: TFile | null =
    view instanceof MarkdownView || view instanceof ButterEditorView
      ? view.file

      : null;
  if (!file) return;
  if (getCurrentMode(leaf) === mode) return;
  const line = captureLine(leaf);

  if (mode === "butter") {
    await leaf.setViewState(
      {
        type: VIEW_TYPE_BUTTER,
        state: { file: file.path },
      },
      { line },
    );
    return;
  }

  await leaf.setViewState(
    {
      type: "markdown",
      state: {
        file: file.path,
        mode: mode === "reading" ? "preview" : "source",
        source: mode === "source",
      },
    },
    { line },
  );
}

/** Cycle the leaf to the next mode in the user's configured list. */
function cycleView(leaf: WorkspaceLeaf, modes: ButterViewMode[]): void {
  if (!modes.length) return;
  const current = getCurrentMode(leaf);
  let nextIdx = 0;
  if (current) {
    const idx = modes.indexOf(current);
    if (idx >= 0) nextIdx = (idx + 1) % modes.length;
  }
  void switchToMode(leaf, modes[nextIdx]);
}

/** Human-readable label for a mode - used in tooltips / menu items. */
function modeLabel(mode: ButterViewMode): string {
  switch (mode) {
    case "source": return "Source";
    case "live": return "Live Preview";
    case "reading": return "Reading";
    case "butter": return "Butter";
  }
}

/** Lucide icon name for each mode - surfaced in the View-as menu.
 *  `butter-editor` is the Butter brand mark registered via `addIcon()`
 *  in `onload()`; the others are stock Lucide names. */
function modeIcon(mode: ButterViewMode): string {
  switch (mode) {
    case "source": return "code-2";
    case "live": return "edit-3";
    case "reading": return "book-open";
    case "butter": return "butter-editor";
  }
}

/**
 * Swap a MarkdownView's leaf to Butter while preserving the visible
 * heading. For CM6 (Live Preview / Source) we read the scroll
 * position from CM6 and find the last heading at-or-above the top
 * of the viewport. For Reading mode, we scan heading DOM rects.
 */
function swapMarkdownToButter(view: MarkdownView) {
  if (!view.file) return;
  const line = visibleHeadingLineMD(view);
  void view.leaf.setViewState(
    {
      type: VIEW_TYPE_BUTTER,
      state: { file: view.file.path },
    },
    { line },
  );
}

/**
 * Source-markdown line of the heading currently at the top of the
 * viewport in a MarkdownView, regardless of view mode (Live Preview,
 * Source, or Reading). Zero when no heading is above the fold.
 */
function visibleHeadingLineMD(view: MarkdownView): number {
  const mode = view.getMode?.() ?? "source";
  const cache = view.file ? view.app.metadataCache.getFileCache(view.file) : null;
  const cached = cache?.headings ?? [];
  if (cached.length === 0) return 0;

  if (mode === "preview") {
    const previewEl: HTMLElement | null =
      view.containerEl.querySelector(".markdown-preview-view") ??
      view.previewMode?.containerEl ??
      null;
    if (!previewEl) return 0;
    const domHs = Array.from(
      previewEl.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    );
    const host = scrollHost(previewEl) ?? previewEl;
    const threshold = host.getBoundingClientRect().top + 40;
    let bestTop = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < domHs.length; i++) {
      const top = domHs[i].getBoundingClientRect().top;
      if (top <= threshold && top > bestTop) {
        bestTop = top;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && cached[bestIdx]) {
      return cached[bestIdx].position.start.line;
    }
    return 0;
  }

  // CM6 (source / live preview): measure each heading's rendered
  // viewport top via coordsAtPos, which reflects actual DOM layout
  // even under live-preview's dynamic decorations. Pick the one
  // closest-to-but-at-or-above the 40px threshold.
  const cm = view.editor?.cm;
  if (!cm) return 0;
  try {
    const scrollDOM = cm.scrollDOM;
    const scrollRect = scrollDOM.getBoundingClientRect();
    const threshold = scrollRect.top + 40;
    let best = -Infinity;
    let bestLine = 0;
    for (const h of cached) {
      const ln = h.position.start.line;
      try {
        const pos = cm.state.doc.line(ln + 1).from;
        const coords = cm.coordsAtPos(pos);
        let top: number;
        if (coords) {
          top = coords.top;
        } else {
          const block = cm.lineBlockAt(pos);
          const estInViewport = block.top - scrollDOM.scrollTop;
          if (estInViewport > 0) continue;
          top = scrollRect.top + estInViewport;
        }
        if (top <= threshold && top > best) {
          best = top;
          bestLine = ln;
        }
      } catch {
        /* skip */
      }
    }
    return bestLine;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════
//  Settings
// ═══════════════════════════════════════════

export interface ButterSettings {
  /**
   * Allow HTML-only formatting in the toolbar. When ON (default),
   * Butter exposes the marks that have no markdown shorthand and can
   * only be written as inline HTML in source: `<font color>` (text
   * color), `<mark style="background-color: ...">` (custom highlight
   * color), `<u>` (underline), `<sup>` / `<sub>`, `<kbd>`.
   *
   * When OFF, those toolbar buttons hide so the user can't author
   * HTML inline. The plain `==highlight==` toggle stays available
   * because it's markdown-native. The parser still recognises HTML
   * inline marks in source files so existing notes round-trip; the
   * setting is purely a toolbar gate, not a source-level restriction.
   */
  enableHtmlFormatting: boolean;
  /** Enable EditorSuggest bridge for other Obsidian plugins. */
  enableSuggestBridge: boolean;
  /** Enable rich paste + file drop. */
  enablePasteDrop: boolean;
  /** Open .md files in Butter automatically. When ON, any markdown
   *  file opened (via Open Quickly, file explorer click, internal
   *  link, new-note creation, etc.) is switched to the Butter view
   *  unless it's already a Butter leaf. */
  openNewFilesInButter: boolean;
  /** Master kill-switch for Butter's CSS animations + transitions.
   *  When ON, applies `body.butter-no-anim` which a CSS rule in
   *  styles.css uses to nuke `animation` and `transition` on every
   *  Butter-prefixed element + the editor's ProseMirror tree. Also
   *  short-circuits the JS-driven entrance animation in setViewData. */
  disableAnimations: boolean;
  /** Active-style for toolbar (filled/soft/outlined/underline). */
  toolbarActiveStyle: "filled" | "soft" | "outlined" | "underline";
  /** Where the formatting toolbar pins relative to the editor view.
   *  Top: sticks to the top of the view's scroll area (under the
   *  workspace tab chrome). Bottom: sticks to the bottom. Both modes
   *  align to the body's content width so the toolbar's left/right
   *  edges match the prose margins. */
  toolbarPosition: "top" | "bottom";
  /**
   * Visual style of the formatting toolbar:
   *   • attached: flush full-pane chrome row between tab title bar
   *     and editor content, with a hairline border separating it
   *     from the document. Most native-feeling.
   *   • detached: body-width floating card with backdrop blur, sits
   *     inside the editor content with sticky positioning. Visually
   *     "above" the document like a HUD.
   *   • integrated: TBD - merge toolbar controls into the view-header
   *     row itself for the densest chrome (design pending).
   */
  toolbarStyle: "attached" | "detached" | "integrated";
  /**
   * In integrated toolbar mode, show the inline title as a pill to
   * the right of the nav buttons (uses Obsidian's view-header title).
   * When off, the title is hidden in the view header - useful for
   * users who already have the filename in their tab strip and don't
   * want the redundancy.
   */
  integratedShowTitle: boolean;
  /**
   * Which view modes the cycle action button rotates through, in
   * order. Default includes all four. User can pare down (e.g. just
   * "source" + "butter") so the cycle button only flips between
   * those two modes. The "View as…" submenu always shows all four
   * regardless of this setting.
   */
  viewCycleModes: Array<"source" | "live" | "reading" | "butter">;
  /**
   * Experimental: run Obsidian-registered CM6 extensions against a
   * hidden mirror view and surface their decorations inside Butter.
   * Enables inline widget rendering for Dataview inline, Tasks inline,
   * Templater live, etc. - at the cost of more memory + CPU per edit.
   */
  enableCM6Bridge: boolean;
  /**
   * When on, use Butter's own outline sidebar and disable the core
   * Obsidian Outline plugin (avoids two outlines competing). When
   * off, Butter's outline is hidden and the core Outline plugin is
   * restored to whatever state it had.
   */
  useButterOutline: boolean;
  /** Motion curve applied to drag animations (indicator, handle). */
  dragMotion: "springy" | "snappy" | "smooth";
  /** Whether the gutter handle only appears on block hover or
   *  persists on the nearest block at all times. */
  dragHandleVisibility: "hover" | "always";
  /**
   * Advanced - Canonical form preferences.
   *
   * Markers used by the serializer when emitting canonical markdown.
   * All default to the most common Obsidian / GitHub convention. Only
   * applied when serializing (preserved blocks emit original bytes
   * regardless of these settings).
   */
  canonicalBullet: "-" | "*" | "+";
  canonicalItalic: "*" | "_";
  canonicalBold: "**" | "__";
  canonicalCodeFence: "```" | "~~~";
  canonicalHorizontalRule: "---" | "***" | "___";
  /**
   * Advanced - Source preservation.
   *
   * When ON, Butter preserves the original bytes of any block you
   * didn't edit. Whitespace, marker style, indentation, blank-line
   * counts - all retained byte-for-byte for unedited blocks. Tight/
   * loose neighbor formatting is preserved only where the original
   * pair stays adjacent; reorders/inserts/deletes break the pair
   * and use a default 1-blank-line gap.
   *
   * When OFF (default), Butter writes canonical markdown - clean,
   * consistent output matching the convention every other WYSIWYG
   * editor uses (Typora, Milkdown, Live Preview's Source Mode). One
   * canonical form: `**bold**`, `-` bullets, single blanks, LF
   * endings. The "first save" of a legacy file may produce a one-
   * time formatting diff as Butter normalizes it; subsequent saves
   * are stable.
   *
   * Off-by-default reflects the dominant ecosystem convention. Turn
   * on if you specifically need byte-for-byte source fidelity for
   * git-tracked vaults, hand-formatted source, or workflows
   * involving non-WYSIWYG tools editing the same files.
   */
  preserveOriginalSource: boolean;
  /**
   * Advanced: ensure at least 1 blank line separates an ATX heading
   * from the following block on save. Off by default (canonical
   * serializer already produces ≥1 blank in most cases; toggle this
   * if you want a stricter guarantee). With source preservation ON,
   * normalizes tight heading-paragraph layouts to the community
   * convention.
   */
  normalizeHeadingGap: boolean;
  /**
   * Advanced: cap runs of 2+ blank lines at 1 on save. Off by default
   * (source is truth - Butter respects multi-blanks authored in LP).
   * On produces clean source matching Prettier / markdownlint style.
   */
  condenseBlankLines: boolean;
  /**
   * Advanced: append a closing ``` (or ~~~) when the file ends mid-
   * fence. Prevents the "user types a new block below what looks like
   * a contained code block in Butter, saves, and reloads to find the
   * new block swallowed into the fence" scenario - CommonMark treats
   * unclosed fences as extending to EOF, so any content authored
   * after them becomes fence body on parse. Idempotent; fence-aware;
   * only top-level fences handled.
   */
  closeUnclosedFences: boolean;
  /**
   * Set to true the first time the user enables any normalizer, after
   * they acknowledge the "this modifies files on save" warning. Used
   * to skip the warning on subsequent enables.
   */
  normalizeWarningAcknowledged: boolean;
  /**
   * Auto-split full-width inline images into their own paragraph.
   * When ON (default), an image / wikilink-embed without a `|W` size
   * hint sitting inside a paragraph with other inline content will
   * be moved into its own block - so a full-column-wide image isn't
   * awkwardly mixed with text that's technically inline but
   * visually attached to a block-level rendering. When OFF, source
   * preservation wins and the image sits inline regardless of
   * visual weirdness.
   */
  splitFullWidthImages: boolean;
  /**
   * Experimental: claim Obsidian's `.markdown-rendered` class on
   * Butter's ProseMirror element so theme CSS scoped to that class
   * cascades into Butter. Expands theme coverage to include rules
   * that override properties directly (bypassing CSS variables),
   * at the cost of potential editing-interaction quirks - some
   * Reading-mode CSS assumes non-contenteditable content and sets
   * `user-select: none` or similar on interactive-looking elements.
   * OFF by default. Flip on if a specific theme's Reading-mode look
   * isn't cascading through; flip off if editing feels broken.
   */
  experimentalThemeCompatMode: boolean;
  /**
   * Verbose debug logging. When on, internal events - parser
   * fallbacks, drag lifecycle, save scheduler ticks, serializer
   * paths, etc. - log to the dev-tools console with a
   * `[butter:<category>]` prefix. Useful for reporting bugs or
   * investigating unusual behavior. Off by default (console stays
   * clean for normal use).
   */
  verboseLogging: boolean;
  /**
   * Legacy. Ids of main-toolbar buttons the user hid via the
   * pre-layout settings UI. Migrated into `toolbarLayout` on first
   * load with the new code; left in place so older versions can
   * still read it if a user downgrades.
   */
  toolbarHiddenButtons: string[];
  /** Legacy. Same as above for the table toolbar. */
  tableToolbarHiddenButtons: string[];
  /**
   * Ordered tree describing the user's main formatting toolbar:
   * each entry is a button (referenced by id), a separator, or a
   * submenu (parent button that opens a popup of its own children).
   * `null` means "use the default layout"; once the user touches
   * the customizer, this becomes a concrete tree.
   */
  toolbarLayout: ToolbarLayoutItem[] | null;
  /**
   * Mobile-specific main-toolbar layout. Same shape as
   * `toolbarLayout` but rendered when `Platform.isMobile` so users
   * can curate a thumb-friendly subset (no submenus - mobile
   * flattens them). `null` means "use the default mobile preset"
   * (`mobileLayoutDefault()`); once the user touches the mobile
   * segment of the customizer, this becomes a concrete tree.
   */
  mobileToolbarLayout: ToolbarLayoutItem[] | null;
  /** Same shape as `toolbarLayout`, for the table toolbar. */
  tableToolbarLayout: ToolbarLayoutItem[] | null;
  /** Mobile-only table-toolbar layout. `null` means "use the
   *  default mobile preset" (`mobileTableLayoutDefault()`). Lets
   *  the user curate a thumb-friendly set of cell actions
   *  separate from the desktop layout. */
  mobileTableToolbarLayout: ToolbarLayoutItem[] | null;
  /** Visual style for the mobile toolbars (main + table).
   *   • `"attached"` (default) - Butter's own thumb-optimized look:
   *     44×44 buttons, backdrop blur, accent-tinted swap buttons.
   *   • `"detached"` - matches Obsidian's built-in mobile toolbar:
   *     `--input-height`-sized buttons, no backdrop blur, standard
   *     chrome. Reads as part of the host app.
   *
   * (Legacy key names "native" / "butter" are migrated on
   * `loadSettings()`.) */
  mobileToolbarStyle: "detached" | "attached";
  /**
   * When ON (default), hovering a bottom-attached toolbar fades
   * Obsidian's status bar out of the way for the duration of the
   * hover - but only if the cursor's X is within (or just left of)
   * the status bar's X range. Lets users reach toolbar buttons that
   * would otherwise be obscured in pane configurations where the
   * leaf's bottom edge sits behind the status bar. Turn off if the
   * fade feels distracting in your layout.
   */
  statusBarHoverFade: boolean;
  /**
   * Source purity preset. The headline question Butter asks new
   * users on first launch:
   *   • "strict"  - markdown is canonical; HTML escape hatches
   *     (font color, raw spans, etc.) are disabled to keep source
   *     clean and tool-portable.
   *   • "rich"    - markdown plus HTML extras are allowed; users
   *     prioritize visual formatting freedom over source purity.
   * Future HTML-only features check this flag directly. Default
   * "strict" matches Obsidian community convention.
   */
  sourcePurity: "strict" | "rich";
  /**
   * Onboarding gate. False on first install → triggers the welcome
   * modal in onload(). Set to true once the user has either picked
   * a source-purity preset or dismissed the modal (silent default
   * = strict). Subsequent launches skip the modal.
   */
  hasCompletedOnboarding: boolean;

  // ── License ──────────────────────────────────────────────────────
  // The Cloudflare Worker at https://api.buttereditor.com is the
  // source of truth. The plugin caches a signed session token here
  // (7-day TTL) so it doesn't need to hit the network on every load,
  // and reads it back on `loadSettings()` to compute `licenseStatus`.
  // Architecture reference lives in the private planning notes.

  /** Per-install random UUID v4. Generated on first load if missing.
   *  Used as the device identifier for trial dedupe + session tokens.
   *  Surviving across vault re-creates is intentional (a vault is one
   *  "device" from the licensing perspective). */
  deviceId: string;

  /** The license key the user pasted (or the trial-issued key). Empty
   *  string when no license is active. */
  licenseKey: string;

  /** Polar customer ID associated with the license. Set when the
   *  Worker's /session call returns. Used for the "Account" UI. */
  customerId: string;

  /** HMAC-signed session payload returned by /session. Cached so
   *  subsequent plugin loads don't need to re-validate online. */
  sessionToken: string;

  /** ms-epoch when sessionToken expires. ~7 days from issue. When
   *  within 1 day of expiry, plugin re-validates online on next load. */
  sessionExpiresAt: number;

  /** ms-epoch of the last successful /session call. Drives the
   *  "Last verified: X ago" UI label and the daily background re-check. */
  lastValidatedAt: number;

  /** Sticky flag set the first time /session ever succeeded. Enables
   *  indefinite offline grace: a customer who was once licensed never
   *  gets locked out by Worker / Polar outages. */
  everValidated: boolean;

  /** ms-epoch when the active license expires. Captured from
   *  `/trial/poll`'s `expiresAt` on activation; refreshed on every
   *  successful `/session` validation if the response carries it. 0
   *  means unknown - UI falls back to `sessionExpiresAt`. Drives the
   *  trial countdown ("Trial · 6 days left") + the day-progress bar. */
  licenseExpiresAt: number;

  /** In-flight trial activation. Set when `/trial` returns; cleared
   *  when `/trial/poll` returns ready (or invalid_token / 30-min
   *  staleness). Persisting the pollToken means closing Settings or
   *  Obsidian mid-activation doesn't lose the trial - the plugin's
   *  `onload()` resumes the poll, and re-opening Settings re-renders
   *  the polling UI in place. */
  pendingTrialActivation: {
    pollToken: string;
    startedAt: number;
    /** Browser-fallback URL captured from `/trial`'s response.
     *  Surfaced by the polling state's "Open in browser" escalation
     *  row when polling exceeds 25s. Optional for back-compat with
     *  records persisted before this field existed. */
    checkoutUrl?: string;
  } | null;

  /** ms-epoch when the active license first activated on this device
   *  (trial poll resolved or first /session succeeded). Drives the
   *  Lifetime "activated {date}" line. 0 for legacy installs with no
   *  recorded activation; the License tab falls back to
   *  `lastValidatedAt` when this is 0. */
  activatedAt: number;

  /** Customer's email on the Polar account. Returned by /session
   *  (Worker 1.8.0+) and cached for display on the Lifetime state's
   *  "Holder" line. Empty when unknown / not yet fetched. */
  customerEmail: string;

  /** License tier - `"v1"` for current Butter, `"v2"` once v2
   *  ships and the customer has a v2 benefit grant on Polar.
   *  Returned by /session; cached for offline display. Defaults
   *  to `"v1"`. */
  tier: "v1" | "v2";

  /** Sticky flag set when /session returns `device_deactivated`.
   *  Preserves the deactivation signal across the state-clear in
   *  refreshLicenseStatus so the License tab can surface a
   *  "this device was deactivated from elsewhere" message instead
   *  of dropping to a generic unlicensed flow. Cleared on the next
   *  successful activation (or by Reset license state). */
  wasDeactivated: boolean;

  /** Sticky flag set when /session returns `license_invalid` AND
   *  the customer had previously been validated (`everValidated`).
   *  Distinguishes refund/chargeback/revoked from a normal trial
   *  expiry. Cleared on next successful activation or Reset. */
  wasInvalidated: boolean;

  /** The last error.kind from a /session failure, stored alongside
   *  wasInvalidated so the License tab can surface why ("Reason:
   *  key not recognized by server"). Empty when no recent
   *  failure. */
  lastReason: string;
}

/** Module-level timer shared by all Butter views' toolbar hover
 *  handlers. When the cursor moves between two views' toolbars, the
 *  outgoing view's mouseleave schedules a hide-removal; the incoming
 *  view's mouseenter cancels it before it fires. A per-view timer
 *  would race here - view-A's leave-timer would fire while the
 *  cursor is on view-B and incorrectly remove the body class. */
let statusBarHideTimer: number | null = null;

/** Toggle `body.butter-mobile-active` based on whether any Butter
 *  view's editor currently holds focus. The body class drives the
 *  CSS rule that suppresses Obsidian's native mobile toolbar inside
 *  Butter views (see styles.css). Polled-on-event (focusin/focusout)
 *  rather than refcounted because there's only ever one focused
 *  element at a time and `closest()` is O(depth). */
function refreshButterMobileBodyClass(): void {
  const active = activeDocument.activeElement;
  const inButter =
    active instanceof Element &&
    active.closest(".butter-editor-view") !== null;
  activeDocument.body.classList.toggle("butter-mobile-active", inButter);
}

const DEFAULT_SETTINGS: ButterSettings = {
  enableHtmlFormatting: true,
  enableSuggestBridge: true,
  enablePasteDrop: true,
  openNewFilesInButter: true,
  disableAnimations: false,
  toolbarActiveStyle: "soft",
  toolbarPosition: "top",
  toolbarStyle: "attached",
  integratedShowTitle: true,
  viewCycleModes: ["source", "live", "reading", "butter"],
  enableCM6Bridge: false,
  useButterOutline: true,
  dragMotion: "springy",
  dragHandleVisibility: "hover",
  canonicalBullet: "-",
  canonicalItalic: "*",
  canonicalBold: "**",
  canonicalCodeFence: "```",
  canonicalHorizontalRule: "---",
  preserveOriginalSource: false,
  normalizeHeadingGap: false,
  condenseBlankLines: false,
  closeUnclosedFences: false,
  normalizeWarningAcknowledged: false,
  splitFullWidthImages: true,
  experimentalThemeCompatMode: false,
  verboseLogging: false,
  toolbarHiddenButtons: [],
  tableToolbarHiddenButtons: [],
  toolbarLayout: null,
  mobileToolbarLayout: null,
  tableToolbarLayout: null,
  mobileTableToolbarLayout: null,
  mobileToolbarStyle: "attached",
  statusBarHoverFade: true,
  sourcePurity: "strict",
  hasCompletedOnboarding: false,
  // License defaults - empty / zero. `deviceId` is generated on first
  // `loadSettings()` if still empty. `everValidated` stays false until
  // /session succeeds at least once.
  deviceId: "",
  licenseKey: "",
  customerId: "",
  sessionToken: "",
  sessionExpiresAt: 0,
  lastValidatedAt: 0,
  everValidated: false,
  licenseExpiresAt: 0,
  pendingTrialActivation: null,
  activatedAt: 0,
  customerEmail: "",
  tier: "v1",
  wasDeactivated: false,
  wasInvalidated: false,
  lastReason: "",
};

// ═══════════════════════════════════════════
//  View
// ═══════════════════════════════════════════

class ButterEditorView extends TextFileView {
  private pmView: EditorView | null = null;
  private nodeViewManager: NodeViewManager | null = null;
  private propertiesEl: HTMLElement | null = null;
  private inlineTitleEl: HTMLElement | null = null;
  private toolbarDom: HTMLElement | null = null;
  /** Re-renders the main toolbar from the current layout settings.
   *  Invoked from the settings tab after a customizer edit. */
  private rebuildMainToolbar: (() => void) | null = null;
  private frontmatter: string = "";
  /** Line-ending style of the file as it was on disk. Preserved so
   *  a CRLF source (typical on Windows-authored / git-autocrlf vaults)
   *  is saved back as CRLF - without this, every save rewrites every
   *  line and shows up as a whole-file diff in git. */
  private lineEnding: "\n" | "\r\n" = "\n";
  /** Count of trailing newlines in the original file body (after
   *  frontmatter). Preserved verbatim on save so a file with 0, 1,
   *  2, or N trailing newlines round-trips exactly. */
  private originalTrailingNewlines: number = 1;
  /** Whether the original file began with a UTF-8 BOM. Preserved
   *  on save so files that Obsidian-foreign tooling produced with
   *  a BOM keep their BOM. */
  private originalHasBOM: boolean = false;
  /** Source-preservation state. Captured at load time. On save, for
   *  each top-level block in the current PM doc we check whether it
   *  still equals the corresponding original block - if so, we emit
   *  the original markdown bytes for that block verbatim instead of
   *  re-serializing in Butter's canonical style. This is what gives
   *  us effective parity with Obsidian Live Preview's "the source is
   *  the source" behavior: untouched blocks in a file keep their
   *  hand-formatted table alignment, tight-style spacing, exact
   *  whitespace, etc. Only blocks the user actually edited come out
   *  in Butter canonical form. */
  private originalBody: string = "";
  private originalDoc: PMNode | null = null;
  private preserveSource = false;
  private suppressChange = false;
  private destroyed = false;
  /** Mobile keyboard-down lock. When false, PM's `editable` prop
   *  returns false so the contenteditable is non-editable - Android's
   *  native long-press text-selection has no editable host to latch
   *  onto. Flipped to true on focus intent (tap when blurred) and
   *  back to false on `keyboardWillHide`. Always true on desktop. */
  private mobileEditable = true;
  /** Set by `installMobileToolbarBehavior` to a callback that
   *  re-applies the editable state to PM. Drag-handles' tap-to-
   *  focus path calls this to flip the lock open. */
  public mobileSetEditable: ((editable: boolean) => void) | null = null;
  /** If setEphemeralState fires before PM finishes mounting (common
   *  on view-type swaps), we stash the state and replay it right
   *  after the PM view is live. */
  private pendingEphemeralState: unknown = null;
  /** License-required banner mounted at the top of the editor when
   *  status is anything other than valid/trial. Lazily attached on
   *  view open, refreshed by the `butter:license-changed` workspace
   *  event, destroyed on view close. */
  private licenseBanner: LicenseBanner | null = null;
  /** Cached full-doc markdown, keyed by PM doc reference. Invalidated
   *  whenever the doc changes (new reference). Saves re-serializing
   *  when multiple code paths ask for the same view data in one frame
   *  (save + echo-check, etc.). */
  private markdownCache: { doc: unknown; text: string } | null = null;
  /** Timestamp (Date.now()) of the last doc mutation - kept for
   *  diagnostics / status-bar readouts. Save-scheduling proper is
   *  owned by {@link saveScheduler}. */
  private lastEditTime = 0;
  /** Debouncer that coordinates save-to-disk timing across typing
   *  bursts, continuous editing, blur, tab-hide, and unload. See
   *  src/save-scheduler.ts for the full model. Bound to
   *  {@link requestSave} so any trigger path goes through the
   *  single save entry point. Initialized lazily on first PM
   *  mount because requestSave needs the view to exist. */
  private saveScheduler: SaveScheduler | null = null;
  /** DOM-event handlers we installed for the scheduler's flush
   *  triggers. Tracked so onClose() can tear them down. */
  private schedulerListeners: Array<() => void> = [];
  /** Obsidian-`Editor`-shaped shim over the PM view. Plugins that
   *  read `activeLeaf.view.editor` (e.g., Templater commands,
   *  plugins using `editor.replaceRange` / `editor.getCursor`) will
   *  find a working editor here. */
  public editor: PMEditorShim | null = null;

  /** Accessor for the underlying PM EditorView. Intentionally a
   *  method (not a public field) so external call sites go through
   *  one guarded entry point. Returns null if the view isn't mounted. */
  public pmViewRef(): EditorView | null {
    return this.pmView;
  }

  /** Apply the experimental "max theme compatibility" mode: toggles
   *  Obsidian's Reading-mode scope classes on the PM element. When
   *  on, theme CSS scoped to any of those classes cascades in.
   *  Both classes are claimed because different themes target
   *  different scopes - `.markdown-rendered` is common, but some
   *  (Things, Minimal variants) target `.markdown-preview-view`
   *  which is the view-container class in Obsidian's own DOM.
   *  Claiming both gives the broadest coverage without requiring
   *  per-theme case-by-case bridges. Called on PM view creation
   *  AND whenever the setting toggles so the classes appear /
   *  disappear without needing a view reload. */
  public applyThemeCompatMode() {
    const el = this.pmView?.dom;
    if (!el) return;
    const compatClasses = ["markdown-rendered", "markdown-preview-view"];
    if (this.settings.experimentalThemeCompatMode) {
      for (const c of compatClasses) el.classList.add(c);
    } else {
      for (const c of compatClasses) el.classList.remove(c);
    }
  }

  /** Apply the toolbar-position preference to this view: update the
   *  data-toolbar-pos attribute on the container (CSS hook) and move
   *  the toolbar DOM node to the appropriate placement. Sticky-bottom
   *  needs the element AFTER the editor; sticky-top wants it before. */
  /** Read the view-content's computed padding values and expose them
   *  as CSS custom properties on the same element. CSS rules that
   *  need to escape the padding box (e.g. the top fade-gradient
   *  pseudo-element) reference these to compute their offsets - we
   *  can't extract individual edges from `--file-margins` (a CSS
   *  shorthand) at runtime, so JS-reads are the cleanest path. */
  public refreshContentPaddingVar() {
    if (!this.contentEl) return;
    const cs = getComputedStyle(this.contentEl);
    this.contentEl.style.setProperty(
      "--butter-content-pad-top",
      cs.paddingTop || "0px",
    );
    this.contentEl.style.setProperty(
      "--butter-content-pad-x",
      cs.paddingLeft || "0px",
    );
  }

  /** Re-render both toolbars from the current layout settings.
   *  Called from the settings tab when the user changes the layout
   *  (reorder, add/remove, create/edit submenu). The table toolbar
   *  dom exposes its own rebuild via `__butterRebuild` (stashed by
   *  `tableToolbarPlugin`); the main toolbar uses the closure stored
   *  on this view at construction time. */
  public applyToolbarButtonVisibility() {
    if (this.rebuildMainToolbar) this.rebuildMainToolbar();
    const parent = this.toolbarDom?.parentElement;
    const tableToolbar = parent?.querySelector(
      ":scope > .butter-table-toolbar",
    ) as HTMLElement | null;
    const rebuild = (tableToolbar as unknown as { __butterRebuild?: () => void } | null)
      ?.__butterRebuild;
    if (rebuild) rebuild();
  }

  /** True when the cursor is on this view's toolbar AND its X
   *  position falls inside (or just left of) the status bar's
   *  X range - i.e. moving any further right would bring it onto
   *  toolbar pixels that are physically behind the status bar.
   *
   *  Why X-only: the obscured pixels can't be reached directly by
   *  the cursor (the status bar is above them in z-order, so
   *  mousemove fires on the status bar, not the toolbar). We have
   *  to trigger the fade BEFORE the cursor crosses the threshold
   *  the `PRELOAD_X` buffer makes that happen 24px early so by the
   *  time the cursor would hit the boundary, the status bar has
   *  already faded out (with `pointer-events: none`) and the cursor
   *  passes through to the toolbar pixels underneath.
   *
   *  Multi-pane: the left pane's toolbar lives in a different X
   *  range than the status bar, so the cursor on it can never be
   *  inside the status-bar X range. Only the pane whose toolbar
   *  shares X with the status bar drives the fade.
   *
   *  Single pane: hovering toolbar buttons in clear airspace
   *  (left of `sbRect.left - 24`) doesn't fade anything. Only
   *  approaching the right side - where the status bar actually
   *  sits - triggers it. */
  public cursorInToolbarStatusBarOverlap(ev: MouseEvent): boolean {
    const dom = this.toolbarDom;
    if (!dom) return false;
    if (dom.getAttribute("data-toolbar-pos") !== "bottom") return false;
    if (dom.getAttribute("data-toolbar-style") !== "attached") return false;
    const statusBar = activeDocument.body.querySelector<HTMLElement>(
      ".status-bar",
    );
    if (!statusBar) return false;
    if (statusBar.offsetParent === null) return false; // hidden by user
    const tbRect = dom.getBoundingClientRect();
    const sbRect = statusBar.getBoundingClientRect();
    if (sbRect.height === 0 || sbRect.width === 0) return false;
    // No vertical overlap - toolbar is well above the status bar
    // (e.g. very tall pane). Nothing to fade.
    if (sbRect.top >= tbRect.bottom) return false;
    // Cursor's X is in the buffered status-bar X range.
    const PRELOAD_X = 24;
    return (
      ev.clientX >= sbRect.left - PRELOAD_X && ev.clientX <= sbRect.right
    );
  }

  /**
   * Mobile-only: wire the keyboard-accessory-bar behavior, mirror-
   * matching how Obsidian's own native mobile toolbar works. Two
   * pieces, both light:
   *
   * 1. **Position** - handled in CSS via `bottom: var(--keyboard-
   *    height, 0px)`. Obsidian itself writes `--keyboard-height`
   *    to `document.documentElement` whenever the soft keyboard
   *    changes height (it owns the Capacitor keyboard listeners
   *    and is the right place to centralize this). By referencing
   *    the same variable, our toolbar tracks the keyboard exactly
   *    as Obsidian's does - across all platforms, hardware
   *    keyboards, mid-session resizes (suggestion bars, emoji
   *    swap, Samsung toolbar expand) - without us reimplementing
   *    any of that.
   *
   * 2. **Visibility** - mirrors Obsidian's `J6.update()` logic:
   *    show when the editor has focus; on Android additionally
   *    require `hasKeyboardVisible` (a flag we flip on
   *    `keyboardWillShow` / `keyboardWillHide`, mirroring
   *    Obsidian's own listener). On iOS the focus-only check is
   *    enough because tapping the editor reliably brings up the
   *    soft keyboard there; on Android the keyboard can be
   *    suppressed by hardware keyboard, voice-input mode, or
   *    multi-window splits, so we wait for the actual signal.
   *
   * Body class `body.butter-mobile-active` is still toggled by
   * `refreshButterMobileBodyClass()` on focus changes - it drives
   * the CSS rule that suppresses Obsidian's own mobile toolbar
   * inside Butter views, so the two don't compete.
   */
  private installMobileToolbarBehavior(
    toolbarDom: HTMLElement,
    editorDom: HTMLElement,
  ): void {
    const VISIBLE_CLASS = "butter-mobile-toolbar-visible";

    // Mirrors Obsidian's `hasKeyboardVisible` flag in `J6` (the
    // native mobile-toolbar class). Flipped to true on
    // keyboardWillShow, false on keyboardWillHide - except when
    // `e.hasPhysicalKeyboard` is set (hardware keyboard:
    // Obsidian's native toolbar stays visible in that case, so we
    // do too by leaving the flag at its prior state).
    let hasKeyboardVisible = false;

    const focusIsInEditorOrToolbar = (): boolean => {
      const active = activeDocument.activeElement;
      if (!(active instanceof Element)) return false;
      // Toolbar-button taps briefly steal focus from the editor;
      // treat focus-on-toolbar as "still editing" so the bar
      // doesn't self-hide on tap.
      return editorDom.contains(active) || toolbarDom.contains(active);
    };

    const updateState = () => {
      const focused = focusIsInEditorOrToolbar();
      // Mirror Obsidian's update logic. iOS: focus is enough;
      // Android: also require the keyboard to be visible.
      const shouldShow =
        focused &&
        (!(Platform as { isAndroidApp?: boolean }).isAndroidApp ||
          hasKeyboardVisible);
      toolbarDom.classList.toggle(VISIBLE_CLASS, shouldShow);
      refreshButterMobileBodyClass();
    };

    let pendingRaf = 0;
    const schedule = () => {
      if (pendingRaf !== 0) return;
      pendingRaf = window.requestAnimationFrame(() => {
        pendingRaf = 0;
        updateState();
      });
    };

    // Capacitor keyboard events - used ONLY for the
    // hasKeyboardVisible flag (Android visibility gate). Position
    // tracking is the responsibility of CSS via `--keyboard-
    // height`, which Obsidian writes for us. Match Obsidian's
    // native behavior of NOT clearing the flag when a hardware
    // keyboard hides (`e.hasPhysicalKeyboard`).
    this.registerDomEvent(
      window as unknown as HTMLElement,
      "keyboardWillShow" as keyof HTMLElementEventMap,
      () => {
        hasKeyboardVisible = true;
        setEditable(true);
        schedule();
      },
    );
    // Re-apply PM's `editable` prop. Setting `editable` directly on
    // the EditorView via `setProps` triggers PM's own update pipeline,
    // which sets the `contenteditable` attribute through the same path
    // it uses on construction - so PM doesn't fight us. Manual
    // `editorDom.contentEditable = "false"` gets reverted on the next
    // PM update; this doesn't.
    const setEditable = (editable: boolean) => {
      if (this.mobileEditable === editable) return;
      this.mobileEditable = editable;
      if (this.pmView) {
        this.pmView.setProps({ editable: () => this.isEditable() });
      }
    };
    this.mobileSetEditable = setEditable;
    // Start locked when mobile (assume kb-down at view-open). The
    // first tap will flip it open (see drag-handles' mobile pointerup).
    setEditable(false);

    this.registerDomEvent(
      window as unknown as HTMLElement,
      "keyboardWillHide" as keyof HTMLElementEventMap,
      (ev: Event) => {
        const anyEv = ev as unknown as { hasPhysicalKeyboard?: boolean };
        if (!anyEv.hasPhysicalKeyboard) hasKeyboardVisible = false;
        // Skip the post-keyboard cleanup when the insert drawer
        // dismissed the keyboard. The drawer blurs the editor on
        // open so its 2-col picker can occupy the keyboard's space;
        // when the user taps a tile we re-focus the editor to bring
        // the keyboard back. Without this guard, `setEditable(false)`
        // here would lock the editor non-editable, the focus call
        // wouldn't fire `keyboardWillShow`, and the user would have
        // to tap a second time to start typing.
        const drawerOpen = activeDocument.body.classList.contains(
          "butter-mobile-drawer-open",
        );
        // Blur the editor so we exit "typing" state - keeps the
        // long-press-to-drag gate consistent (gate proxies on focus)
        // and avoids stranded contenteditable focus when the user
        // dismissed the keyboard intentionally.
        if (
          !anyEv.hasPhysicalKeyboard &&
          !drawerOpen &&
          editorDom.contains(activeDocument.activeElement)
        ) {
          (activeDocument.activeElement as HTMLElement).blur();
        }
        // Lock the editor non-editable so Android's native long-
        // press text-selection has no editable host to grab. Restored
        // on tap (see drag-handles' mobile pointerup).
        if (!anyEv.hasPhysicalKeyboard && !drawerOpen) setEditable(false);
        schedule();
      },
    );


    this.registerDomEvent(editorDom, "focusin", schedule);
    this.registerDomEvent(editorDom, "focusout", schedule);
    this.registerDomEvent(toolbarDom, "focusin", schedule);
    this.registerDomEvent(toolbarDom, "focusout", schedule);
    this.registerDomEvent(window, "focusin", schedule);
    this.registerDomEvent(window, "focusout", schedule);

    updateState();


  }

  public applyToolbarPosition() {
    if (Platform.isMobile) return; // mobile keeps body-attached behavior
    const leaf = this.containerEl; // .workspace-leaf-content (header + content)
    const content = this.contentEl; // .view-content
    if (!leaf || !content || !this.toolbarDom) return;

    const style = this.settings.toolbarStyle;
    const pos = this.settings.toolbarPosition;
    this.toolbarDom.setAttribute("data-toolbar-style", style);
    this.toolbarDom.setAttribute("data-toolbar-pos", pos);
    content.setAttribute("data-toolbar-pos", pos);
    content.setAttribute("data-toolbar-style", style);
    // Also tag the leaf (containerEl, which has .butter-view-root)
    // so CSS rules on .view-header / leaf-bottom pseudo can branch
    // on toolbar style + position. Both attributes are needed for
    // the fade-height rules to size correctly per toolbar side.
    leaf.setAttribute("data-toolbar-style", style);
    leaf.setAttribute("data-toolbar-pos", pos);

    // Tear down integrated state from a previous style switch - the
    // marker class on view-header and any inline-title display
    // override need to come off before re-applying anything else.
    const viewHeader = leaf.querySelector<HTMLElement>(".view-header");
    const inlineTitle = content.querySelector<HTMLElement>(".inline-title");
    if (viewHeader && style !== "integrated") {
      viewHeader.classList.remove("butter-integrated-header");
    }
    if (inlineTitle && style !== "integrated") {
      inlineTitle.style.removeProperty("display");
    }

    // The .butter-toolbar-stack wrapper is the shared parent that
    // holds both the main and table toolbars. It serves two purposes:
    //   • Detached: the stack is a sticky parent inside view-content
    //     so both toolbars scroll together as one card.
    //   • Attached: the stack is a relatively-positioned flow child
    //     inside the leaf that gives the table toolbar a positioned
    //     anchor - the table toolbar absolute-positions over content
    //     instead of pushing it down when it appears.
    // Integrated has no stack (toolbar lives directly in view-header).
    // On every re-apply, prune any stack from a parent that doesn't
    // match the current style so a leftover wrapper from a prior
    // mode doesn't strand the toolbars.
    const stackInLeaf = leaf.querySelector(
      ":scope > .butter-toolbar-stack",
    );
    const stackInContent = content.querySelector(
      ":scope > .butter-toolbar-stack",
    );
    if (style === "integrated") {
      if (stackInLeaf) stackInLeaf.remove();
      if (stackInContent) stackInContent.remove();
    } else if (style === "attached") {
      if (stackInContent) stackInContent.remove();
    } else if (style === "detached") {
      if (stackInLeaf) stackInLeaf.remove();
    }

    // Integrated: mount the toolbar INSIDE the view-header itself,
    // between the title-container and view-actions. The view-header
    // becomes a single chrome row containing nav buttons, title pill,
    // toolbar (centered), and view-actions. Position setting (top/
    // bottom) is irrelevant in this style - the view-header is
    // always at the top of the leaf.
    if (style === "integrated") {
      if (!viewHeader) return; // safety: bail if Obsidian DOM shape changed
      viewHeader.classList.add("butter-integrated-header");
      const viewActions = viewHeader.querySelector(".view-actions");
      if (this.toolbarDom.parentElement !== viewHeader) {
        if (viewActions) {
          viewHeader.insertBefore(this.toolbarDom, viewActions);
        } else {
          viewHeader.appendChild(this.toolbarDom);
        }
      }
      // Inline-title visibility tracks the integrated-show-title
      // setting. Hidden state survives toolbar re-applies because we
      // set inline display:none (CSS doesn't compete).
      if (inlineTitle) {
        inlineTitle.style.display = this.settings.integratedShowTitle
          ? ""
          : "none";
      }
      // View-header's own title-container also tracks the setting
      // it's the "pill" the user sees. CSS handles visibility via
      // an attr we set on view-header.
      viewHeader.dataset.butterShowTitle = this.settings.integratedShowTitle
        ? "1"
        : "0";
      return;
    }

    // Detached mounts INSIDE view-content for sticky positioning to
    // work - the scrolling parent has to be the same element the
    // toolbar is sticky against.
    //
    // We wrap both toolbars (main + table) in a `.butter-toolbar-stack`
    // element. The stack is the sticky parent; the toolbars themselves
    // become normal flow children. This keeps the table toolbar glued
    // to the main toolbar during scroll instead of letting it scroll
    // away while the main stays pinned. The table-toolbar plugin docks
    // adjacent to the main toolbar in main.parentElement, so it lands
    // inside the stack automatically.
    if (style === "detached") {
      const editorRoot = content.querySelector(
        ".butter-editor-root",
      );
      if (!editorRoot) return;

      let stack = content.querySelector(
        ":scope > .butter-toolbar-stack",
      );
      if (!stack) {
        stack = activeDocument.createElement("div");
        stack.className = "butter-toolbar-stack";
        content.insertBefore(stack, editorRoot);
      }
      stack.setAttribute("data-toolbar-style", style);
      stack.setAttribute("data-toolbar-pos", pos);

      // Position the stack at the correct end of the content.
      if (pos === "bottom") {
        if (stack.nextElementSibling !== null) {
          content.appendChild(stack);
        }
      } else {
        if (stack.nextElementSibling !== editorRoot) {
          content.insertBefore(stack, editorRoot);
        }
      }

      // Mount main toolbar inside the stack. Skip the move when
      // already inside the stack so we don't disturb the table
      // toolbar's sibling order on idempotent re-applies.
      if (this.toolbarDom.parentElement !== stack) {
        stack.appendChild(this.toolbarDom);
      }
      return;
    }

    // Attached: stack wrapper hosts main + table toolbars in the leaf
    // chrome row. Stack is `position: relative` so the table toolbar
    // can `position: absolute` over content without pushing it down
    // when it appears.
    let stack = leaf.querySelector(
      ":scope > .butter-toolbar-stack",
    );
    if (!stack) {
      stack = activeDocument.createElement("div");
      stack.className = "butter-toolbar-stack";
      leaf.insertBefore(stack, content);
    }
    stack.setAttribute("data-toolbar-style", style);
    stack.setAttribute("data-toolbar-pos", pos);

    if (pos === "bottom") {
      if (stack.parentElement !== leaf || stack.previousElementSibling !== content) {
        leaf.insertBefore(stack, content.nextSibling);
      }
    } else {
      if (stack.parentElement !== leaf || stack.nextElementSibling !== content) {
        leaf.insertBefore(stack, content);
      }
    }

    if (this.toolbarDom.parentElement !== stack) {
      stack.appendChild(this.toolbarDom);
    }
    // Re-anchor the license banner into the (possibly new) stack so
    // it stays glued to the toolbar across style + position changes.
    this.licenseBanner?.refresh();
  }

  /**
   * Source-markdown line number of the heading currently at the top
   * of the editor viewport. Used both for outline tracking and for
   * preserving the user's sense of place across a view-type swap.
   *
   * Viewport-based (not caret-based), because "where you are in a
   * long doc" is a property of what you're reading, not where your
   * cursor happened to be parked.
   */
  public visibleHeadingLine(): number {
    if (!this.pmView) return 0;
    const doc = this.pmView.state.doc;
    const threshold = scrollHostTop(this.pmView.dom) + 40;

    const fmLines = this.frontmatter
      ? Math.max(0, this.frontmatter.split("\n").length - 1)
      : 0;

    let bestTop = -Infinity;
    let bestLine = 0;
    let line = fmLines;
    doc.forEach((child, offset) => {
      if (child.type.name === "heading") {
        const dom = this.pmView!.nodeDOM(offset) as HTMLElement | null;
        if (dom) {
          const top = dom.getBoundingClientRect().top;
          if (top <= threshold && top > bestTop) {
            bestTop = top;
            bestLine = line;
          }
        }
      }
      const text = child.textContent;
      const nlines = text ? text.split("\n").length : 1;
      line += nlines + 1;
    });
    return bestLine;
  }


  constructor(
    leaf: WorkspaceLeaf,
    private settings: ButterSettings,
    private plugin: ButterEditorPlugin,
    private reportSaveResult?: (result: SaveState) => void,
  ) {
    super(leaf);
  }

  /** True when the editor should accept user input. Read on every PM
   *  transaction dispatch (PM's `editable` prop is a callback) so the
   *  existing mobile keyboard-down lock can take effect without
   *  re-mounting the editor. */
  isEditable(): boolean {
    return this.mobileEditable;
  }

  getViewType(): string {
    return VIEW_TYPE_BUTTER;
  }
  getDisplayText(): string {
    return this.file?.basename ?? "Butter Editor";
  }
  // No tab icon. TextFileView's default `getIcon()` returns "document"
  // so a Butter tab would otherwise show that. Returning an empty
  // string tells Obsidian's tab UI to render no icon, giving the tab
  // a clean text-only label that matches what's wanted here.
  getIcon(): string {
    return "";
  }

  // ── Frontmatter ──

  private stripFrontmatter(data: string): string {
    // Capture byte-level file metadata for round-trip preservation.
    //   - BOM: rare but legitimate (some foreign tooling produces it);
    //     preserve rather than silently strip.
    //   - Line endings: CRLF vs LF. Recaptured on save per-file.
    //   - Trailing newlines: 0, 1, 2+ - preserve verbatim.
    this.originalHasBOM = data.charCodeAt(0) === 0xfeff;
    if (this.originalHasBOM) data = data.slice(1);
    this.lineEnding = data.includes("\r\n") ? "\r\n" : "\n";

    // Eat ALL trailing newlines after the closing `---`, not just
    // one. Many vaults store a blank line between frontmatter and
    // the first heading. If we capture only one newline, the blank
    // line gets parsed as part of the body, serialized away, and
    // the reassembled save is missing it - which looks like a
    // whole-file diff in git / Obsidian Sync on every save. By
    // folding the separator newlines into the preserved frontmatter
    // string, they're re-emitted byte-identically on save.
    let body: string;
    const match = data.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*/);
    if (match) {
      this.frontmatter = match[0];
      body = data.slice(match[0].length);
    } else {
      this.frontmatter = "";
      body = data;
    }

    // Count trailing newlines in the body (normalized LF). Used on
    // save to emit exactly the same trailing-byte state.
    const bodyNormalized = body.replace(/\r\n/g, "\n");
    const m = bodyNormalized.match(/\n*$/);
    this.originalTrailingNewlines = m ? m[0].length : 0;

    return body;
  }

  /**
   * Capture source-preservation state after a successful parse.
   *
   * Source ranges live on the PM nodes themselves (the `sourceRange`
   * attribute, populated by the bridge during the parse walk). We
   * also keep a reference to the parsed doc so the serializer can
   * reference-compare the live doc's nodes against the originals
   * ProseMirror's immutable-tree model means a node's JS reference
   * survives if-and-only-if no step has mutated it. That's the
   * cleanest "this node is still original" signal available.
   *
   * Structural edits (insert, delete, reorder) don't break
   * preservation: each surviving node carries its own range and
   * identity, and the serializer walks the current order.
   */
  private captureSourceState(
    body: string,
    doc: PMNode | null,
  ) {
    this.originalBody = body;
    this.originalDoc = doc;
    this.preserveSource = doc !== null;
  }

  /**
   * True if `doc` contains any top-level `raw_block` child. Used by
   * the save-path guard to detect the "parse failed, source is in a
   * raw_block" state and protect it from being serialized out of
   * existence.
   */
  private hasRawBlock(doc: PMNode): boolean {
    for (let i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name === "raw_block") return true;
    }
    return false;
  }

  // ── Properties (unchanged from original) ──

  private propertiesComponent: Component | null = null;

  private static TYPE_ICONS: Record<string, string> = {
    text: "lucide-text",
    number: "lucide-binary",
    checkbox: "lucide-check-square",
    date: "lucide-calendar",
    datetime: "lucide-clock",
    tags: "lucide-tags",
    aliases: "lucide-forward",
    multitext: "lucide-list",
    unknown: "lucide-file-question",
  };

  private getPropertyType(
    key: string,
    value: unknown,
  ): { type: string; icon: string } {
    const mgr = this.app.metadataTypeManager;
    if (mgr?.assignedWidgets) {
      const assigned = mgr.assignedWidgets[key.toLowerCase()];
      if (assigned) {
        const typeName = assigned.widget ?? assigned.type ?? "text";
        const registered = mgr.registeredTypeWidgets?.[typeName];
        const icon =
          registered?.icon ||
          ButterEditorView.TYPE_ICONS[typeName] ||
          "lucide-text";
        return { type: typeName, icon };
      }
    }
    if (Array.isArray(value)) return { type: "multitext", icon: "lucide-list" };
    if (typeof value === "boolean")
      return { type: "checkbox", icon: "lucide-check-square" };
    if (typeof value === "number") return { type: "number", icon: "lucide-binary" };
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))
      return { type: "datetime", icon: "lucide-clock" };
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
      return { type: "date", icon: "lucide-calendar" };
    return { type: "text", icon: "lucide-text" };
  }

  private renderProperties() {
    if (!this.propertiesEl) return;
    this.propertiesEl.empty();
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (!this.frontmatter || !this.file) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    const cache = this.app.metadataCache.getFileCache(this.file);
    const fmRaw: unknown = cache?.frontmatter;
    const fm = (fmRaw && typeof fmRaw === "object" ? fmRaw : null) as
      | Record<string, unknown>
      | null;
    if (!fm) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    this.propertiesEl.removeClass("butter-hidden");
    this.propertiesComponent = new Component();
    this.propertiesComponent.load();

    const propCount = Object.keys(fm).filter((k) => k !== "position").length;
    const metaContainer = this.propertiesEl.createDiv({
      cls: "metadata-container",
      attr: { "data-property-count": String(propCount) },
    });
    const heading = metaContainer.createDiv({
      cls: "metadata-properties-heading",
      attr: { tabIndex: 0 },
    });
    const foldEl = heading.createDiv({ cls: "collapse-indicator collapse-icon" });
    setIcon(foldEl, "right-triangle");
    heading.createDiv({ cls: "metadata-properties-title", text: "Properties" });
    heading.addEventListener("click", (e) => {
      e.preventDefault();
      metaContainer.toggleClass(
        "is-collapsed",
        !metaContainer.hasClass("is-collapsed"),
      );
    });

    const content = metaContainer.createDiv({ cls: "metadata-content" });
    const properties = content.createDiv({ cls: "metadata-properties" });
    const file = this.file;
    const app = this.app;

    /** Render any frontmatter value to a flat string for input fields.
     *  Skips deep stringification of plain objects (which would yield
     *  the useless `[object Object]`) by returning empty for those. */
    const fmValueToString = (v: unknown): string => {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      return ""; // arrays / plain objects shouldn't be flattened here
    };
    for (const [key, value] of Object.entries(fm)) {
      if (key === "position") continue;
      const { type, icon } = this.getPropertyType(key, value);
      const prop = properties.createDiv({
        cls: "metadata-property",
        attr: {
          "data-property-key": key.toLowerCase(),
          "data-property-type": type,
          tabIndex: 0,
        },
      });

      const showPropertyMenu = (e: MouseEvent) => {
        e.preventDefault();
        const menu = new Menu();
        const mgr = this.app.metadataTypeManager;
        const widgets = mgr?.registeredTypeWidgets;
        menu.addSections?.([
          "title",
          "action",
          "action.changeType",
          "clipboard",
          "",
          "danger",
        ]);
        menu.setSectionSubmenu?.("action.changeType", {
          title: "Property type",
          icon: "lucide-info",
        });
        if (widgets) {
          for (const w of Object.values(widgets)) {
            if (!w) continue;
            if (w.reservedKeys && !w.reservedKeys.includes(key.toLowerCase()))
              continue;
            menu.addItem((item: MenuItem) => {
              const label = typeof w.name === "function" ? w.name() : w.type;
              item
                .setTitle(label)
                .setIcon(w.icon ?? null)
                .setChecked(w.type === type)
                .onClick(() => {
                  mgr?.setType?.(key.toLowerCase(), w.type);
                  window.setTimeout(() => this.renderProperties(), 100);
                });
              item.setSection?.("action.changeType");
            });
          }
        }
        menu.addItem((item: MenuItem) => {
          item.setTitle("Cut").setIcon("lucide-scissors").onClick(() =>
            // execCommand is deprecated, but it's the only programmatic
            // path that respects the currently-focused input's selection.
            // navigator.clipboard.writeText can't read the input's
            // selection-bounded text without a separate DOM round-trip.
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            activeDocument.execCommand("cut"),
          );
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item.setTitle("Copy").setIcon("lucide-copy").onClick(() =>
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            activeDocument.execCommand("copy"),
          );
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item.setTitle("Paste").setIcon("lucide-clipboard-check").onClick(
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            () => activeDocument.execCommand("paste"),
          );
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item
            .setTitle("Remove")
            .setIcon("lucide-trash-2")
            .onClick(() => {
              void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                delete fm[key];
              });
              window.setTimeout(() => this.renderProperties(), 100);
            });
          item.setWarning?.(true);
          item.setSection?.("danger");
        });
        menu.setParentElement?.(prop);
        menu.showAtMouseEvent(e);
      };
      prop.addEventListener("contextmenu", showPropertyMenu);

      const iconEl = prop.createDiv({ cls: "metadata-property-icon" });
      setIcon(iconEl, icon);
      iconEl.addEventListener("click", (e) => {
        e.preventDefault();
        if (!prop.hasClass("has-active-menu")) showPropertyMenu(e);
      });

      const keyEl = prop.createDiv({ cls: "metadata-property-key" });
      const keyInput = keyEl.createEl("input", {
        cls: "metadata-property-key-input",
        value: key,
        type: "text",
        attr: { autocapitalize: "none", enterkeyhint: "next" },
      });
      keyInput.addEventListener("blur", () => {
        const newKey = keyInput.value.trim();
        if (!newKey) {
          keyInput.value = key;
          return;
        }
        if (newKey !== key) {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[newKey] = fm[key];
            delete fm[key];
          });
          window.setTimeout(() => this.renderProperties(), 100);
        }
      });
      keyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          keyInput.blur();
        } else if (e.key === "Escape") {
          keyInput.value = key;
          prop.focus();
        }
      });

      const valContainer = prop.createDiv({
        cls: "metadata-property-value",
        attr: { "data-property-type": type },
      });
      valContainer.addEventListener("mousedown", () => {
        window.setTimeout(() => {
          const active = valContainer.querySelector(":focus") as HTMLElement;
          if (!active) {
            const focusable = valContainer.querySelector(
              "input, [contenteditable='true']",
            ) as HTMLElement;
            focusable?.focus();
          }
        }, 0);
      });
      valContainer.addClass("butter-prop-val-text");

      const isMulti =
        type === "tags" || type === "aliases" || type === "multitext";
      const arrValue: unknown[] | null = Array.isArray(value)
        ? value
        : isMulti && value
          ? fmValueToString(value)
              .split(",")
              .map((s) => s.trim())
          : null;

      if (isMulti) {
        const wrapper = valContainer.createDiv({ cls: "multi-select-container" });
        if (arrValue && arrValue.length > 0) {
          for (const item of arrValue) {
            const pill = wrapper.createDiv({
              cls: "multi-select-pill",
              attr: { tabIndex: 0 },
            });
            const pillContent = pill.createDiv({ cls: "multi-select-pill-content" });
            pillContent.textContent = String(item);
            const removeBtn = pill.createDiv({ cls: "multi-select-pill-remove-button" });
            setIcon(removeBtn, "lucide-x");
            removeBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                const arr = fm[key];
                if (Array.isArray(arr)) {
                  fm[key] = arr.filter((v: unknown) => String(v) !== String(item));
                }
              });
              window.setTimeout(() => this.renderProperties(), 100);
            });
            if (type === "tags") {
              pillContent.addEventListener("click", () => {
                const search = app.internalPlugins?.getPluginById?.("global-search");
                const inst = search?.instance as
                  | { openGlobalSearch?: (q: string) => void }
                  | undefined;
                inst?.openGlobalSearch?.(`tag:${String(item)}`);
              });
            }
          }
        }
        const addInput = wrapper.createDiv({
          cls: "multi-select-input",
          attr: { contentEditable: "true", tabIndex: 0 },
        });
        if (!arrValue || arrValue.length === 0) {
          addInput.setAttribute("data-placeholder", "Empty");
        }
        addInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && addInput.textContent?.trim()) {
            e.preventDefault();
            const newVal = addInput.textContent.trim();
            void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
              let arr = fm[key];
              if (!Array.isArray(arr)) {
                arr = [];
                fm[key] = arr;
              }
              (arr as unknown[]).push(newVal);
            });
            addInput.textContent = "";
            window.setTimeout(() => this.renderProperties(), 100);
          }
        });
      } else if (type === "checkbox") {
        const cb = valContainer.createEl("input", {
          cls: "metadata-input-checkbox",
          type: "checkbox",
          attr: { tabIndex: 0 },
        });
        if (value) cb.checked = true;
        cb.addEventListener("change", () => {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = cb.checked;
          });
        });
      } else if (type === "date" || type === "datetime") {
        const dateInput = valContainer.createEl("input", {
          cls: `metadata-input metadata-input-text mod-${type}`,
          type: type === "datetime" ? "datetime-local" : "date",
          value: fmValueToString(value).slice(0, type === "datetime" ? 16 : 10),
          attr: { tabIndex: 0 },
        });
        dateInput.addEventListener("change", () => {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = dateInput.value;
          });
        });
      } else if (type === "number") {
        const numInput = valContainer.createEl("input", {
          cls: "metadata-input metadata-input-number",
          type: "number",
          value: fmValueToString(value),
          attr: { tabIndex: 0 },
        });
        numInput.addEventListener("change", () => {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = Number(numInput.value);
          });
        });
      } else {
        const textInput = valContainer.createEl("input", {
          cls: "metadata-input metadata-input-text",
          type: "text",
          value: fmValueToString(value),
          placeholder: "Empty",
          attr: { tabIndex: 0 },
        });
        textInput.addEventListener("change", () => {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = textInput.value;
          });
        });
      }
    }

    const addBtn = content.createDiv({
      cls: "metadata-add-button text-icon-button",
      attr: { tabIndex: 0 },
    });
    const addBtnIcon = addBtn.createSpan({ cls: "text-button-icon" });
    setIcon(addBtnIcon, "lucide-plus");
    addBtn.createSpan({ cls: "text-button-label", text: "Add property" });
    addBtn.addEventListener("click", () => {
      void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        let k = "property";
        let i = 1;
        while (fm[k] !== undefined) k = `property${i++}`;
        fm[k] = "";
      });
      window.setTimeout(() => this.renderProperties(), 100);
    });
  }

  // ── Lifecycle ──

  async onOpen() {
    this.destroyed = false;

    const container = this.contentEl;
    container.empty();
    container.addClass("butter-editor-view");

    // View-type indicator on the tab/header
    this.containerEl.addClass("butter-view-root");

    // License-required banner. Mounts at the top of the view; hides
    // automatically when license is valid/trial. Listens for
    // `butter:license-changed` to re-render after the user enters a
    // key, completes a trial, or signs out.
    // Banner mounts as a row in the toolbar's stack (adjacent to the
    // main toolbar). At onOpen time the toolbar's stack doesn't exist
    // yet - applyToolbarPosition (called below) is what creates it.
    // We pass both `this.containerEl` (used to find the toolbar by
    // querySelector once it's mounted) and `container` (fallback
    // for the brief window before the toolbar exists). View calls
    // refresh() after applyToolbarPosition to re-locate the banner
    // into the freshly-created stack.
    this.licenseBanner = mountLicenseBanner(this.containerEl, container, this.plugin);
    this.registerEvent(
      this.app.workspace.on("butter:license-changed" as never, () => {
        this.licenseBanner?.refresh();
        // Force PM to re-evaluate its `editable` callback by
        // dispatching a no-op transaction. PM reads `editable` on
        // every dispatch, so a status flip mid-session takes effect
        // immediately without re-mounting.
        if (this.pmView) {
          this.pmView.dispatch(this.pmView.state.tr);
        }
      }),
    );

    // Header action: cycle to next view mode in the user's
    // configured cycle list. Icon reflects the CURRENT mode so users
    // can identify which mode they're in at a glance - "butter-editor"
    // for Butter, "code-2" for Source, "edit-3" for Live Preview,
    // "book-open" for Reading.
    const cycleAction = this.addAction(
      modeIcon("butter"),
      "Switch view mode",
      () => {
        cycleView(this.leaf, this.settings.viewCycleModes);
      },
    );
    cycleAction.setAttr("data-butter-action", "cycle");

    // Inline title
    const inlineTitle = container.createDiv({ cls: "inline-title" });
    inlineTitle.contentEditable = "true";
    inlineTitle.spellcheck =
      (this.app.vault.getConfig?.("spellcheck") as boolean | undefined) ?? true;
    inlineTitle.tabIndex = -1;
    inlineTitle.addEventListener("blur", () => {
      const newName = inlineTitle.textContent?.trim();
      if (newName && this.file && newName !== this.file.basename) {
        this.app.fileManager.renameFile(
          this.file,
          this.file.parent?.path + "/" + newName + "." + this.file.extension,
        ).catch((err: unknown) => {
          recordError("inline-title-rename", String((err as Error)?.message ?? err));
          new Notice("Rename failed");
        });
      }
    });
    inlineTitle.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        inlineTitle.blur();
      }
    });
    this.inlineTitleEl = inlineTitle;

    // Properties
    this.propertiesEl = container.createDiv({
      cls: "butter-properties-wrapper markdown-source-view cm-s-obsidian is-live-preview show-properties",
    });

    // Toolbar
    const plugin = this.app.plugins?.plugins?.["butter-editor"] as
      | ButterEditorPlugin
      | undefined;
    const {
      dom: toolbarDom,
      plugin: toolbarPlugin,
      rebuild: rebuildToolbar,
    } = createToolbar(
      this.app,
      schema,
      () =>
        plugin
          ? plugin.getActiveToolbarLayout()
          : Platform.isMobile
            ? this.settings.mobileToolbarLayout ?? mobileLayoutDefault()
            : this.settings.toolbarLayout ?? defaultMainLayout(),
      () => this.settings.mobileToolbarStyle,
      // Single-block markdown serializer - used by the mobile
      // drawer's Block-actions Copy tile (and any other future
      // mobile context-button paths). Same one the desktop drag-
      // handle context menu uses.
      (node) => serializer.serialize(schema.node("doc", null, [node])),
    );
    toolbarDom.setAttribute("data-active-style", this.settings.toolbarActiveStyle);
    this.toolbarDom = toolbarDom;
    this.rebuildMainToolbar = rebuildToolbar;

    // Status-bar hover-fade - cursor-position-aware. Only fades when
    // the cursor is on toolbar pixels that actually share screen
    // space with the status bar. Multi-pane configs: only the pane
    // whose toolbar overlaps the status-bar's X range drives the
    // fade. Single pane with a centered toolbar: the left half of
    // the toolbar (clear of the status bar) doesn't trigger; only
    // the rightmost portion behind the status bar does.
    //
    // Mousemove sets/clears the class continuously as the cursor
    // moves across the obscured boundary inside the toolbar.
    // Mouseleave schedules a 150ms grace delay before clearing so
    // briefly brushing past the toolbar edge doesn't pulse the
    // status bar in and out.
    this.registerDomEvent(toolbarDom, "mouseenter", () => {
      if (!this.settings.statusBarHoverFade) return;
      if (statusBarHideTimer !== null) {
        window.clearTimeout(statusBarHideTimer);
        statusBarHideTimer = null;
      }
    });
    this.registerDomEvent(toolbarDom, "mousemove", (ev) => {
      if (!this.settings.statusBarHoverFade) {
        activeDocument.body.classList.remove("butter-status-bar-hide");
        return;
      }
      if (statusBarHideTimer !== null) {
        window.clearTimeout(statusBarHideTimer);
        statusBarHideTimer = null;
      }
      activeDocument.body.classList.toggle(
        "butter-status-bar-hide",
        this.cursorInToolbarStatusBarOverlap(ev),
      );
    });
    this.registerDomEvent(toolbarDom, "mouseleave", () => {
      if (!this.settings.statusBarHoverFade) return;
      if (statusBarHideTimer !== null) window.clearTimeout(statusBarHideTimer);
      statusBarHideTimer = window.setTimeout(() => {
        activeDocument.body.classList.remove("butter-status-bar-hide");
        statusBarHideTimer = null;
      }, 150);
    });

    // Right-click on the toolbar's empty area opens a quick-access
    // menu for changing position / style without going to settings.
    // Skipped when the click is on a button, separator, popover, or
    // any other interactive descendant.
    toolbarDom.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(".butter-btn") ||
        target.closest(".butter-toolbar-popover") ||
        target.closest("button") ||
        target.closest("input")
      ) {
        return;
      }
      e.preventDefault();
      // settings + saveSettings + applyToolbarPositionToAllViews live
      // on the plugin, not the view. Look it up via Obsidian's
      // plugin registry. Cast to any since the plugins map isn't in
      // the public types.
      const plugin = (this.app.plugins?.plugins?.[
        "butter-editor"
      ] ?? null) as ButterEditorPlugin | null;
      if (!plugin) return;
      const menu = new Menu();
      // Mobile toolbar is body-attached above the keyboard - Position
      // and Style settings don't apply there, so just expose Settings.
      if (!Platform.isMobile) {
        const setPos = async (p: "top" | "bottom") => {
          plugin.settings.toolbarPosition = p;
          await plugin.saveSettings();
          plugin.applyToolbarPositionToAllViews();
        };
        const setStyle = async (s: "attached" | "detached") => {
          plugin.settings.toolbarStyle = s;
          await plugin.saveSettings();
          plugin.applyToolbarPositionToAllViews();
        };
        menu.addItem((item) => {
          item.setTitle("Position");
          item.setIcon("move-vertical");
          const sub = item.setSubmenu();
          sub.addItem((s) => {
            s.setTitle("Top");
            s.setIcon("arrow-up-to-line");
            if (plugin.settings.toolbarPosition === "top") s.setChecked(true);
            s.onClick(() => void setPos("top"));
          });
          sub.addItem((s) => {
            s.setTitle("Bottom");
            s.setIcon("arrow-down-to-line");
            if (plugin.settings.toolbarPosition === "bottom") s.setChecked(true);
            s.onClick(() => void setPos("bottom"));
          });
        });
        menu.addItem((item) => {
          item.setTitle("Style");
          item.setIcon("layers");
          const sub = item.setSubmenu();
          sub.addItem((s) => {
            s.setTitle("Attached");
            s.setIcon("rectangle-horizontal");
            if (plugin.settings.toolbarStyle === "attached") s.setChecked(true);
            s.onClick(() => void setStyle("attached"));
          });
          sub.addItem((s) => {
            s.setTitle("Detached");
            s.setIcon("square-dashed");
            if (plugin.settings.toolbarStyle === "detached") s.setChecked(true);
            s.onClick(() => void setStyle("detached"));
          });
        });
        menu.addSeparator();
      }
      menu.addItem((item) => {
        item
          .setTitle("Settings")
          .setIcon("settings")
          .onClick(() => plugin.openSettings("toolbar"));
      });
      menu.showAtMouseEvent(e);
    });

    // Mark the view container with the user's toolbar-position
    // preference so CSS can swap sticky-top vs sticky-bottom rules.
    // Updated live by applyToolbarPosition() when the setting changes.
    container.setAttribute(
      "data-toolbar-pos",
      this.settings.toolbarPosition,
    );

    // NOTE: do not add `markdown-rendered` here. That class is Obsidian's
    // Reading-mode wrapper and its CSS can mask the live PM editor's
    // rendering (e.g., stripping font-weight on <strong>). Our NodeViews
    // apply `markdown-rendered` to the MarkdownRenderer output *inside*
    // callouts / embeds / math / code blocks, which is where it belongs.
    const editorRoot = container.createDiv({
      cls: "butter-editor-root",
    });

    // Mobile keeps its body-attached behavior; desktop hands off to
    // applyToolbarPosition (called below) which mounts the toolbar
    // in the leaf chrome between view-header and view-content. The
    // mobile keyboard-accessory behavior (visualViewport tracking,
    // focus-tied show/hide, native-toolbar suppression body class)
    // is installed AFTER the PM view is created - see the call to
    // `installMobileToolbarBehavior` below.
    if (Platform.isMobile) {
      activeDocument.body.appendChild(toolbarDom);
    } else {
      this.applyToolbarPosition();
    }
    this.refreshContentPaddingVar();

    const getSourcePath = () => this.file?.path ?? "";
    const getFile = () => this.file ?? null;

    const body = this.stripFrontmatter(this.data ?? "");
    this.renderProperties();

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.file) this.renderProperties();
      }),
    );

    // parseWithSourceMap delegates to PM's createAndFill which can
    // recurse into fillBefore on certain doc shapes. Node's stack
    // accommodates our schema graph; Electron's smaller stack can
    // blow on specific input combinations. Catch + fall back rather
    // than crash the entire view (and through it, the plugin).
    let result: ReturnType<typeof parser.parseWithSourceMap> | null = null;
    try {
      result = parser.parseWithSourceMap(body);
    } catch (err) {
      console.error(
        "[butter-editor] parser.parseWithSourceMap threw on this file. Falling back to empty doc; source is preserved on disk.",
        err,
      );
    }
    const doc = result?.doc || schema.node("doc", null, [schema.node("paragraph")]);
    this.captureSourceState(body, result?.doc ?? null);

    this.nodeViewManager = new NodeViewManager();
    const mgr = this.nodeViewManager;

    const plugins: PMPlugin[] = [
      toolbarPlugin,
      autocompletePlugin(this.app, schema),
      slashMenuPlugin(this.app, schema),
      buildInputRules(schema),
      buildKeymap(schema),
      checkboxPlugin(),
      listNumberingPlugin(),
      multiBlockSelectPlugin({
        app: this.app,
        serializeNode: (node) =>
          serializer.serialize(schema.node("doc", null, [node])),
      }),
      selectionOverlayPlugin(),
      listOperationsPlugin(),
      codeHighlightPlugin(this.app),
      searchPlugin(),
      dragHandlePlugin(
        this.app,
        () => ({
          motion: this.settings.dragMotion,
          handleVisibility: this.settings.dragHandleVisibility,
        }),
        // Mobile: tap-to-focus restores editing (PM was locked non-
        // editable on keyboardWillHide to suppress native long-press
        // text-selection; tap is the user's signal to start typing).
        // The callback is owned by the view so drag-handles doesn't
        // need a direct EditorView reference.
        () => this.mobileSetEditable?.(true),
        // Serialize a single block by wrapping it in a one-child doc
        // and handing that to the MarkdownSerializer. Used by the drag-
        // handle context menu's "Copy" action to stamp the block's
        // markdown source onto the clipboard.
        (node) => serializer.serialize(schema.node("doc", null, [node])),
      ),
      // Cell-range drag MUST register BEFORE tableEditing() so its
      // mousedown handler fires first. When the user grabs an active
      // CellSelection, it returns true and pm-tables' mousedown (which
      // would otherwise start a fresh drag-select and clobber the
      // selection we're about to drag) never runs.
      tableCellDragPlugin(),
      ...tableEditingPlugins(),
      tableToolbarPlugin(
        this.app,
        schema,
        () => this.toolbarDom,
        () =>
          plugin
            ? plugin.getActiveTableToolbarLayout()
            : Platform.isMobile
              ? this.settings.mobileTableToolbarLayout ?? mobileTableLayoutDefault()
              : this.settings.tableToolbarLayout ?? defaultTableLayout(),
        () => this.settings.mobileToolbarStyle,
      ),
      tableRowColDragPlugin(),
      clickToSpawnPlugin(() => this.mobileSetEditable?.(true)),
      inlineAtomEditPlugin(this.app),
      autoSplitImagesPlugin(schema, () => this.settings.splitFullWidthImages),
      // Safety net: once a raw_block enters the doc (parse failure
      // fallback), block any transaction that would remove it
      // unless the transaction is flagged as a trusted sync. User
      // gets a Notice explaining why the edit didn't stick.
      rawBlockSafetyPlugin((msg) => new Notice(msg, 6000)),
      keymap({ "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo }),
      history(),
      dropCursor(),
      gapCursor(),
      contextMenuPlugin(schema),
      trimDblClickSelectionPlugin(),
      // Resolves em/strong overlap at transaction-end so the saved
      // file stays pure markdown (no `<em>`/`<strong>` HTML fallback).
      // Word-aligned overlap → smart-split via whitespace-eject (no
      // formatting loss). Mid-word overlap → older mark yields in
      // the overlap region (some pre-existing formatting trimmed).
      overlapResolverPlugin(schema),
    ];

    if (this.settings.enablePasteDrop) {
      plugins.push(pasteDropPlugin(this.app, schema, parser, getSourcePath));
    }

    if (this.settings.enableSuggestBridge) {
      plugins.push(
        suggestBridgePlugin(
          this.app,
          (d) => serializer.serialize(d),
          getFile,
        ),
      );
    }

    if (this.settings.enableCM6Bridge) {
      plugins.push(
        ...cm6BridgePlugins(this.app, {
          serialize: (d) => serializer.serialize(d),
          parse: (md) => parser.parse(md),
          schema,
        }),
      );
    }

    plugins.push(
      new PMPlugin({
        view: () => ({
          update: (view, prevState) => {
            if (this.suppressChange) return;
            if (!view.state.doc.eq(prevState.doc)) {
              this.lastEditTime = Date.now();
              // Route every edit through the scheduler; it manages
              // idle + ceiling + event-driven flush triggers.
              this.saveScheduler?.onEdit();
            }
          },
        }),
      }),
    );

    // EditorState.create runs PM's content validation which recursively
    // walks fillBefore / createAndFill. On our schema's content graph
    // that recursion sits near Electron's stack limit (Node's is much
    // larger - tests don't trip it). Certain doc shapes can blow past
    // it. Wrap in try/catch + fall back to an empty paragraph doc so
    // a single bad parse doesn't take the entire plugin offline. The
    // file's source remains on disk untouched; user can reload after
    // we ship the underlying schema-graph fix.
    let state: EditorState;
    try {
      state = EditorState.create({ doc, schema, plugins });
    } catch (err) {
      console.error(
        "[butter-editor] EditorState.create threw (likely PM fillBefore stack overflow on this doc). Falling back to empty paragraph doc.",
        err,
      );
      const fallback = schema.node("doc", null, [schema.node("paragraph")]);
      state = EditorState.create({ doc: fallback, schema, plugins });
    }

    const pmView = new EditorView(editorRoot, {
      state,
      editable: () => this.isEditable(),
      // Identify the contenteditable region to assistive tech.
      // role=textbox + aria-multiline distinguishes it from a one-
      // line input. No `aria-label` because Obsidian's tooltip
      // system renders aria-label as a hover tooltip - on a giant
      // editing surface that becomes constant visual noise. SR users
      // still get sensible behavior via role + context.
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
      nodeViews: {
        code_block: codeBlockView(this.app, getSourcePath, mgr),
        obsidian_embed: embedView(this.app, getSourcePath, mgr),
        obsidian_embed_inline: embedInlineView(this.app, getSourcePath, mgr),
        obsidian_callout: calloutView(this.app, getSourcePath, mgr),
        math_block: mathBlockView(this.app, getSourcePath, mgr),
        inline_math: inlineMathView(this.app, getSourcePath, mgr),
        wikilink: wikilinkView(this.app, getSourcePath),
        obsidian_tag: tagView(this.app),
        block_comment: blockCommentView(),
        inline_footnote: inlineFootnoteView(),
        footnote_ref: footnoteRefView(),
        footnote_def: footnoteDefView(this.app, getSourcePath, mgr),
        block_id: blockIdView(),
        image: imageView(this.app, getSourcePath),
        raw_block: rawBlockView(),
      },
    });
    this.pmView = pmView;

    if (this.destroyed) {
      this.pmView.destroy();
      this.pmView = null;
      return;
    }

    // Apply experimental theme-compat mode (may add `.markdown-
    // rendered` to the PM element so theme CSS scoped to that class
    // cascades into Butter). No-op when the setting is off.
    this.applyThemeCompatMode();

    // Mobile keyboard-accessory behavior - needs the PM view to
    // exist so we can attach focus listeners to its DOM. No-op on
    // desktop. See `installMobileToolbarBehavior` for the full
    // contract (visualViewport tracking, focus-tied visibility,
    // native-toolbar suppression body class).
    if (Platform.isMobile && this.toolbarDom) {
      this.installMobileToolbarBehavior(this.toolbarDom, this.pmView.dom);
    }

    // Expose an Obsidian-Editor-shaped shim. Plugins that read
    // `activeLeaf.view.editor` can now operate against our view.
    this.editor = new PMEditorShim(this.pmView, (d) =>
      serializer.serialize(d),
    );

    // Initialize the save scheduler. Every edit lands here; blur,
    // tab-hide, and beforeunload trigger an instant flush so sync
    // plugins + file watchers see the newest bytes without paying
    // the full idle-window cost.
    //
    // We call `save()` directly rather than `requestSave()` because
    // the latter is documented as "Debounced save in 2 seconds from
    // now" - our scheduler already handles idle/ceiling/event
    // triggering, so layering Obsidian's 2s debounce on top would
    // mean event flushes (blur, window-blur, etc.) don't actually
    // hit disk for 2 seconds. `save()` writes immediately.
    this.saveScheduler = new SaveScheduler(() => {
      // Wrap the scheduler-driven save in async error capture. Without
      // this, an async vault.modify rejection (disk full, file locked
      // by sync clients, network drive drop, EACCES) silently escapes
      // to the event loop as an unhandled promise rejection - the user
      // sees nothing while their typing piles up unsaved.
      void (async () => {
        try {
          await this.save();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recordError("save", `vault.modify failed: ${msg}`);
          new Notice("Butter: save failed - " + msg);
        }
      })();
    });
    this.installSchedulerTriggers();

    // Replay any ephemeral state that arrived while the PM view was
    // still mounting (typical on a Markdown → Butter view swap).
    if (this.pendingEphemeralState) {
      const pending = this.pendingEphemeralState;
      this.pendingEphemeralState = null;
      this.applyEphemeralState(pending);
    }
  }

  async onClose() {
    this.destroyed = true;
    // Tear down the license banner. registerEvent handles the
    // workspace listener cleanup automatically.
    if (this.licenseBanner) {
      this.licenseBanner.destroy();
      this.licenseBanner = null;
    }
    // Flush pending save NOW so we don't lose the user's most
    // recent typing when the view closes (common on file switch).
    if (this.saveScheduler) {
      this.saveScheduler.flush();
      this.saveScheduler = null;
    }
    // Detach DOM-event triggers installed by installSchedulerTriggers.
    for (const teardown of this.schedulerListeners) {
      try { teardown(); } catch { /* already gone */ }
    }
    this.schedulerListeners = [];
    this.editor = null;
    this.propertiesEl = null;
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (this.toolbarDom?.parentNode) {
      this.toolbarDom.remove();
      this.toolbarDom = null;
    }
    // Re-check body class - if THIS view's editor was the focused
    // Butter view, removing its DOM moves activeElement off our
    // .butter-editor-view subtree, and the body class should follow.
    // (The window focusin/focusout listeners are torn down by
    // registerDomEvent at this point, so we refresh manually.)
    if (Platform.isMobile) refreshButterMobileBodyClass();
    if (this.nodeViewManager) {
      this.nodeViewManager.destroy();
      this.nodeViewManager = null;
    }
    if (this.pmView) {
      this.pmView.destroy();
      this.pmView = null;
    }
  }

  getViewData(): string {
    if (!this.pmView) return this.data;
    return this.serializeCurrent();
  }

  /**
   * Memoized serialization. On large docs a full serialize is the
   * main cost of save, so we cache by PM doc reference and reuse the
   * string on any subsequent call that sees the same doc - avoids
   * repeat work when Obsidian + our own code both ask for viewData
   * in the same frame (save + echo-check, etc).
   */
  private serializeCurrent(): string {
    if (!this.pmView) return this.data;
    const rawDoc = this.pmView.state.doc;
    if (this.markdownCache && this.markdownCache.doc === rawDoc) {
      return this.markdownCache.text;
    }
    // Defensive table normalization: re-tag `table_header` /
    // `table_cell` cell types based on each cell's row position,
    // so historical reorder bugs (header row dragged to body or
    // vice versa) recover on the next save instead of locking the
    // file behind a permanent round-trip-guard rejection. The
    // round-trip guard further down compares this same `doc`
    // against the re-parse of the serialized output, so both sides
    // of the comparison see the normalized table.
    const doc = normalizeTablesInDoc(rawDoc, this.pmView.state.schema);
    // Paranoid save-path guard: if the loaded doc had a raw_block
    // (parse failed, source is being preserved verbatim) but the
    // current PM doc doesn't, refuse to save and return the original
    // file bytes. Normally the rawBlockSafetyPlugin's
    // filterTransaction blocks any such transition, but this guard
    // catches anything that somehow slips through (PM bug, direct
    // state mutation, us accidentally dispatching a sync-tagged
    // transaction that drops the raw_block). Zero tolerance for
    // data loss on an already-bad parse-failure day.
    if (this.originalDoc && this.hasRawBlock(this.originalDoc)) {
      if (!this.hasRawBlock(doc)) {
        console.error(
          "[butter-pmx] raw_block disappeared from PM doc but was " +
            "in loaded doc - refusing to save, returning original " +
            "bytes to prevent source loss.",
        );
        return this.data;
      }
    }
    try {
      // Source-preserving save: for each top-level block that's
      // still structurally identical to its loaded state (user
      // didn't touch it), emit the original source bytes verbatim
      // rather than re-serialize in Butter's canonical style. This
      // gives us Live-Preview-like source fidelity - untouched
      // blocks keep their exact whitespace, table alignment,
      // conservative-escape-free prose, etc. Only edited blocks
      // come out in the serializer's canonical form.
      //
      // Source-preserving save.
      //
      // Every top-level block in `doc` carries a `sourceRange` attr
      // placed there at parse time by the bridge. A companion
      // PM plugin (sourcePreservationPlugin) invalidates that attr
      // to null whenever the node's content or meaningful attrs
      // change - so at save time, a non-null range means "this node
      // is still byte-for-byte what the user had in source."
      //
      // The serializer walks the doc's children: valid range → emit
      // `originalBody.slice(range.start, range.end)` unchanged;
      // null range → re-serialize that block only. Everything else
      // stays byte-identical.
      //
      // No `childCount` check, no parallel range array, no per-save
      // positional index matching. The source-preservation invariant
      // lives on the nodes themselves and survives structural edits
      // (insert, delete, reorder) because each node carries its own
      // range regardless of where it sits in the doc.
      // Save mode is gated by user setting + runtime context:
      //   - `preserveOriginalSource` setting: user opted into byte
      //     preservation. Off by default (canonical mode).
      //   - `this.preserveSource`: runtime flag that's true only if
      //     parse succeeded and we have an originalDoc to compare
      //     against. False when parse failed (raw_block fallback) or
      //     the file is newly created.
      // Both must hold for preservation to engage. If either is
      // false, fall through to canonical serialize - what every
      // other WYSIWYG markdown editor does.
      // Canonical-form preferences are passed to whichever path runs.
      // Preserved blocks emit original bytes regardless; only synthesized
      // blocks honor these.
      const canonicalOptions = {
        bullet: this.settings.canonicalBullet,
        italic: this.settings.canonicalItalic,
        bold: this.settings.canonicalBold,
        codeFence: this.settings.canonicalCodeFence,
        horizontalRule: this.settings.canonicalHorizontalRule,
      };
      // Choose the primary serialize path (canonical vs preservation)
      // by user setting + runtime context. The OTHER path is held in
      // `tryFallback` for the round-trip-guard recovery below - if
      // the primary fails to round-trip, we attempt the alternate
      // before refusing the save outright.
      const useCanonical = !(
        this.settings.preserveOriginalSource &&
        this.preserveSource &&
        this.originalDoc
      );
      let body: string;
      const tryFallback = () => {
        if (useCanonical && this.preserveSource && this.originalDoc) {
          // Canonical was primary; preservation is the fallback.
          return serializer.serializeWithSourcePreservation(
            doc,
            this.originalBody,
            this.originalDoc,
            canonicalOptions,
          );
        }
        if (!useCanonical) {
          // Preservation was primary; canonical is the fallback.
          return serializer.serialize(doc, canonicalOptions);
        }
        return null;
      };
      if (useCanonical) {
        body = serializer.serialize(doc, canonicalOptions);
      } else {
        body = serializer.serializeWithSourcePreservation(
          doc,
          this.originalBody,
          this.originalDoc!,
          canonicalOptions,
        );
      }
      // Trailing-newline handling follows the same gating: when the
      // user has opted into source preservation AND we have parse
      // context, emit the original's exact trailing-newline count.
      // Otherwise fall back to the canonical convention of exactly 1.
      const targetTrailing =
        this.settings.preserveOriginalSource &&
        this.preserveSource &&
        this.originalDoc
          ? this.originalTrailingNewlines
          : 1;
      body = body.replace(/\n*$/, "") + "\n".repeat(targetTrailing);

      // Optional source normalization (opt-in advanced setting).
      // Applied AFTER trailing-newline preservation so the normalizer
      // can cap long trailing blank runs if `condenseBlankLines` is
      // on. The normalizer functions are idempotent and no-op when
      // all toggles are false.
      const preNormalizeBody = body;
      if (
        this.settings.normalizeHeadingGap ||
        this.settings.condenseBlankLines ||
        this.settings.closeUnclosedFences
      ) {
        body = normalizeSource(body, {
          headingGap: this.settings.normalizeHeadingGap,
          condenseBlanks: this.settings.condenseBlankLines,
          closeUnclosedFences: this.settings.closeUnclosedFences,
        });
      }

      // If a normalizer changed the body bytes, update the
      // source-preservation baseline so subsequent saves diff against
      // the normalized form rather than the pre-normalized one.
      //
      // Subtlety: we update originalBody but NOT originalDoc. Re-
      // parsing to refresh sourceRanges would invalidate the PM
      // node-identity matching preservation depends on (every live
      // node would differ from a freshly-parsed baseline, collapsing
      // preservation to canonical-serialize for all nodes). Instead
      // we rely on the fact that `closeUnclosedFences` only appends
      // at EOF - existing sourceRanges stay valid pointing into the
      // new (longer) originalBody. For `normalizeHeadingGap` and
      // `condenseBlankLines`, which can shift mid-doc byte offsets,
      // sourceRanges drift slightly; acceptable because those
      // normalizers only touch inter-block whitespace that source-
      // preservation treats as a computed gap anyway (see the
      // content+gap preservation refactor in history).
      if (body !== preNormalizeBody) {
        this.originalBody = body;
        const trailingMatch = body.match(/\n*$/);
        this.originalTrailingNewlines = trailingMatch
          ? trailingMatch[0].length
          : 0;
      }

      // Save-path round-trip sanity check. Re-parse the serialized
      // body and compare a structural fingerprint against the current
      // PM doc. If the fingerprints diverge, the serializer produced
      // output that doesn't round-trip cleanly - a corruption bug
      // somewhere (ours, a theme interaction, an odd paste, whatever).
      // Refuse to save; return the original file bytes. The check
      // runs on every save as defense-in-depth against unknown
      // corruption paths - zero tolerance for silent data loss.
      //
      // Cost: one parse pass per save, ~10-50ms on typical docs.
      // Cheap relative to the risk of writing corrupted bytes.
      // Round-trip guard with fallback. Try the chosen serializer
      // path first; if its output doesn't reparse to the same
      // structure, attempt the OTHER path before refusing the save
      // entirely. This lets the user keep saving even when one path
      // has a latent bug on a specific file shape.
      const checkRoundTrip = (
        candidate: string,
      ): { ok: true } | { ok: false; reason: string } => {
        try {
          const reparsed = parser.parseWithSourceMap(candidate);
          if (!reparsed?.doc) return { ok: false, reason: "reparse returned null" };
          const origFp = this.docAtomFingerprint(doc);
          const reFp = this.docAtomFingerprint(reparsed.doc);
          if (origFp === reFp) return { ok: true };
          // Find the first divergent top-level block so the error is
          // actionable. Without this we just see "fingerprints differ"
          // and can't repro.
          const diff = this.firstFingerprintDivergence(origFp, reFp);
          return {
            ok: false,
            reason: `fingerprint mismatch at ${diff.path}: orig=${diff.orig} re=${diff.re}`,
          };
        } catch (err) {
          const e = err as { stack?: string; message?: string };
          const msg = String(e?.stack ?? e?.message ?? err);
          return { ok: false, reason: `reparse threw: ${msg.slice(0, 200)}` };
        }
      };

      // Capture the previous on-disk bytes so the diff modal can show
      // before/after if normalization fires. `this.originalBody` may
      // be updated mid-flight by the normalizers above; snapshot here.
      const preSaveOriginal = this.originalBody;

      const primary = checkRoundTrip(body);
      let saveResult: SaveState = { kind: "clean" };

      if (!primary.ok) {
        const fbBody = tryFallback();
        if (fbBody !== null) {
          const fb = checkRoundTrip(fbBody);
          if (fb.ok) {
            // Fallback path round-trips cleanly - silent recovery.
            recordError(
              "save",
              `Primary path (${useCanonical ? "canonical" : "preservation"}) did not round-trip; ` +
                `saved via fallback (${useCanonical ? "preservation" : "canonical"}) instead. ` +
                `Reason: ${primary.reason}. ` +
                `Body excerpt: ${JSON.stringify(body.slice(0, 200))}`,
            );
            body = fbBody;
            // saveResult stays { kind: "clean" } - round-trip is fine.
          } else {
            // Both paths failed round-trip. Save the CANONICAL output
            // (the safer of the two - it's our serializer's output
            // rather than potentially-stale source bytes carrying
            // forward whatever shape the in-memory doc disagrees with),
            // surface a warning to the user, and write the diagnostic
            // dump for our debugging. The user's work is NOT lost: the
            // bytes on disk are valid CommonMark/GFM/Obsidian markdown,
            // just normalized to a structure the parser accepts cleanly.
            // Obsidian's core File Recovery plugin handles version
            // restore if the user wants to roll back.
            const canonicalBody = useCanonical ? body : fbBody;
            const guardReason =
              `${useCanonical ? "canonical" : "preservation"}: ${primary.reason} | ` +
              `${useCanonical ? "preservation" : "canonical"}: ${fb.reason}`;

            // Auto-dump for diagnostics. Visible to the user but
            // intentional - they need a way to send us the failing
            // input if it ever reproduces. Path retained as
            // `.butter-save-failure.md` for backward compatibility
            // with users who already have it gitignored.
            const dumpPath = ".butter-save-failure.md";
            const fileName = this.file?.path ?? "(unknown file)";
            const docDump = JSON.stringify(doc.toJSON(), null, 2);
            const dump =
              `<!-- Butter save-normalization auto-dump\n` +
              `   timestamp: ${new Date().toISOString()}\n` +
              `   file:      ${fileName}\n` +
              `   primary:   ${primary.reason}\n` +
              `   fallback:  ${fb.reason}\n` +
              `   doc.textContent.length: ${doc.textContent.length}\n` +
              `   File WAS written (canonical body); this dump captures\n` +
              `   the round-trip mismatch for diagnostics. Overwritten on\n` +
              `   every normalized save.\n` +
              `-->\n\n` +
              `<!-- ===== IN-MEMORY PM DOC (JSON) ===== -->\n` +
              "```json\n" + docDump + "\n```\n\n" +
              `<!-- ===== ORIGINAL ON-DISK BODY ===== -->\n` +
              preSaveOriginal +
              `\n\n<!-- ===== CANONICAL SERIALIZER OUTPUT (saved) ===== -->\n` +
              canonicalBody +
              `\n\n<!-- ===== PRESERVATION SERIALIZER OUTPUT (alternative) ===== -->\n` +
              fbBody;
            void this.app.vault.adapter
              .write(dumpPath, dump)
              .catch((err) =>
                console.warn(
                  "[butter:save] failed to write auto-dump:",
                  err,
                ),
              );
            recordError(
              "save",
              `Both serialize paths failed round-trip; saved canonical anyway. ` +
                `${guardReason} | auto-dump written to ${dumpPath} at vault root`,
            );

            body = canonicalBody;
            saveResult = {
              kind: "normalized",
              original: preSaveOriginal,
              saved: canonicalBody,
              reason: guardReason,
            };
          }
        } else {
          // Primary failed and no fallback available. Save the primary
          // output anyway - the user's work survives, and the warning
          // status indicator + diff modal lets them see what changed.
          // (The "no fallback" case typically means they only have one
          // serializer path enabled by setting; respecting that choice
          // and saving its output is the right behavior.)
          recordError(
            "save",
            `Round-trip ${primary.reason}. No fallback available; saved primary anyway.`,
          );
          saveResult = {
            kind: "normalized",
            original: preSaveOriginal,
            saved: body,
            reason:
              `${useCanonical ? "canonical" : "preservation"}: ${primary.reason}`,
          };
        }
      }

      // Report the final save outcome to the plugin's status bar.
      // Fires even on the clean path so the indicator clears any prior
      // warning state when a subsequent save round-trips cleanly.
      if (this.reportSaveResult) {
        try { this.reportSaveResult(saveResult); }
        catch (err) {
          console.warn("[butter:save] reportSaveResult threw:", err);
        }
      }

      let text = this.frontmatter + body;
      // Preserve the input file's line-ending style. Matters for
      // git-tracked vaults on Windows with autocrlf=false: converting
      // CRLF→LF on every save produces a whole-file diff that drowns
      // real changes. First normalize everything to LF (frontmatter
      // may still carry the original CRLF from disk), then re-apply
      // the target style uniformly.
      text = text.replace(/\r\n/g, "\n");
      if (this.lineEnding === "\r\n") text = text.replace(/\n/g, "\r\n");
      // Re-apply BOM if the original had one.
      if (this.originalHasBOM) text = "\ufeff" + text;
      // Cache keyed by the PM doc identity (rawDoc) since the next
      // call's identity check uses `this.pmView.state.doc`. The
      // table-normalized `doc` may be a fresh instance - caching by
      // it would always miss.
      this.markdownCache = { doc: rawDoc, text };
      return text;
    } catch {
      return this.data;
    }
  }

  /**
   * Structural fingerprint for the save-path round-trip check.
   * Walks the full tree capturing every node's type and its
   * non-text child structure. Plus total text-content length.
   *
   * Catches the class of bug where corruption introduces stray text
   * nodes around an atom (e.g. backspacing an image-containing
   * paragraph into another and producing `![` + image + `\n)` where
   * there was just `image` before): atom count stays the same, but
   * total text length changes and child counts per block change.
   *
   * Tolerant of normal edit drift:
   *   - Text content values are not compared (user typing is fine)
   *   - Marks are not compared (formatting toggles are fine)
   *   - Attribute values are not compared (resize, rename, etc)
   *
   * Intolerant of structural changes that round-trip would never
   * produce legitimately:
   *   - Adding/removing atoms
   *   - Adding/removing text around atoms
   *   - Block-type conversions (paragraph ↔ heading, etc)
   *   - Split or merged blocks (except standard text-merge cases
   *     text length check catches the material ones)
   */
  /** Walk two fingerprint JSON strings and find the first place
   *  they diverge. Returns a path like "top[3].bullet_list[1]" plus
   *  short snippets of the orig and re values at that point. Used by
   *  the round-trip-guard error reporter so the user can see WHICH
   *  block broke instead of just "fingerprints differ." */
  private firstFingerprintDivergence(
    origFp: string,
    reFp: string,
  ): { path: string; orig: string; re: string } {
    type Shape = { t: string; c?: number; children?: Shape[] };
    let origObj: { shape: Shape[]; textLen: number };
    let reObj: { shape: Shape[]; textLen: number };
    try {
      origObj = JSON.parse(origFp) as { shape: Shape[]; textLen: number };
      reObj = JSON.parse(reFp) as { shape: Shape[]; textLen: number };
    } catch {
      return { path: "<parse-fp-failed>", orig: origFp.slice(0, 100), re: reFp.slice(0, 100) };
    }
    if (origObj.textLen !== reObj.textLen) {
      return {
        path: "textLen",
        orig: String(origObj.textLen),
        re: String(reObj.textLen),
      };
    }
    const walk = (
      a: Shape,
      b: Shape,
      path: string,
    ): { path: string; orig: string; re: string } | null => {
      if (a.t !== b.t) {
        return { path, orig: a.t, re: b.t };
      }
      if (a.c !== b.c) {
        return {
          path: `${path}.text-marker`,
          orig: String(a.c ?? "none"),
          re: String(b.c ?? "none"),
        };
      }
      const ac = a.children || [];
      const bc = b.children || [];
      if (ac.length !== bc.length) {
        return {
          path: `${path}.${a.t}.childCount`,
          orig: `${ac.length} (${ac.map((s) => s.t).join(",")})`,
          re: `${bc.length} (${bc.map((s) => s.t).join(",")})`,
        };
      }
      for (let i = 0; i < ac.length; i++) {
        const sub = walk(ac[i], bc[i], `${path}.${a.t}[${i}]`);
        if (sub) return sub;
      }
      return null;
    };
    const aTop = origObj.shape;
    const bTop = reObj.shape;
    if (aTop.length !== bTop.length) {
      return {
        path: "top.length",
        orig: `${aTop.length} (${aTop.map((s) => s.t).join(",")})`,
        re: `${bTop.length} (${bTop.map((s) => s.t).join(",")})`,
      };
    }
    for (let i = 0; i < aTop.length; i++) {
      const sub = walk(aTop[i], bTop[i], `top[${i}]`);
      if (sub) return sub;
    }
    return { path: "<no-diff-found>", orig: "?", re: "?" };
  }

  private docAtomFingerprint(doc: PMNode): string {
    type Shape = { t: string; c?: number; children?: Shape[] };
    // Adjacent same-type list blocks (`bullet_list, bullet_list` or
    // `ordered_list, ordered_list`) are a doc-state anomaly: the
    // serializer can only emit them as ONE merged list (CommonMark
    // merges adjacent same-type lists by spec), so re-parse yields a
    // single list. The fingerprint comparison treats them as
    // equivalent - collapses adjacent same-type lists into one
    // before comparing - so the round-trip guard accepts these saves
    // instead of false-positiving on a layout artifact.
    const mergeAdjacentLists = (children: Shape[]): Shape[] => {
      const result: Shape[] = [];
      for (const child of children) {
        const last = result[result.length - 1];
        const isList =
          child.t === "bullet_list" || child.t === "ordered_list";
        if (last && isList && last.t === child.t) {
          // Merge: combine non-text children, OR text-marker.
          last.children = [
            ...(last.children ?? []),
            ...(child.children ?? []),
          ];
          if (child.c) last.c = 1;
        } else {
          result.push(child);
        }
      }
      return result;
    };
    // Empty paragraph detection - click-to-spawn's ephemeral
    // paragraphs (and any other transient empty textblocks) have no
    // content, don't serialize to anything in markdown, and thus
    // don't round-trip. Excluding them from both the pre- and
    // post-serialize fingerprints keeps the round-trip check from
    // false-positiving on save-during-ephemeral-paragraph states.
    const isEmptyTransient = (node: PMNode): boolean => {
      // Excluded from the structural fingerprint because they have
      // no visible effect on the doc's meaning AND don't survive
      // markdown round-trip:
      //   - block_comments - invisible meta-nodes used as list-
      //     separators between adjacent same-type lists. The
      //     serializer auto-injects them; only the reparsed doc
      //     has them, so they'd cause spurious mismatches.
      //   - Paragraphs with no children (click-to-spawn
      //     ephemerals).
      //   - Paragraphs with no text content AND children that are
      //     ONLY break atoms (softbreak / hard_break). User can
      //     create these by mashing Enter/Shift-Enter at end of a
      //     callout body or list item. Markdown-it strips trailing
      //     blank lines, so reparse drops the paragraph entirely.
      if (node.type.name === "block_comment") return true;
      if (node.type.name !== "paragraph") return false;
      if (node.textContent.length !== 0) return false;
      if (node.childCount === 0) return true;
      // No text + at least one child = check if all children are breaks.
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type.name !== "softbreak" && c.type.name !== "hard_break") {
          return false;
        }
      }
      return true;
    };
    // Children of a textblock that are softbreak/hardbreak atoms
    // sitting at the LEADING or TRAILING edge don't round-trip
    // through markdown - markdown-it strips trailing whitespace at
    // paragraph parse and treats leading whitespace inside text-
    // blocks as no-op. So a paragraph that ends with [text, softbreak]
    // re-parses as [text] only. Strip leading/trailing breaks from
    // each textblock's children before fingerprinting so this
    // unavoidable parser behavior doesn't false-positive the guard.
    const isBreakNode = (n: PMNode) =>
      n.type.name === "softbreak" || n.type.name === "hard_break";
    const trimEdgeBreaks = (children: PMNode[]): PMNode[] => {
      let start = 0;
      let end = children.length;
      while (start < end && isBreakNode(children[start])) start++;
      while (end > start && isBreakNode(children[end - 1])) end--;
      return start === 0 && end === children.length
        ? children
        : children.slice(start, end);
    };
    // Headings collapse internal soft/hard breaks to spaces during
    // serialization (see heading handler in obsidian-md-bridge), so a
    // multi-line setext-style heading like
    //   Frequently Asked Questions
    //   Can I use these random paragraphs for my project?
    // round-trips back as a SINGLE-line heading. Fingerprint would
    // false-positive on the dropped softbreak. Strip ALL break atoms
    // from heading inline content (not just edges) so the round-trip
    // guard accepts these saves.
    const stripAllBreaks = (children: PMNode[]): PMNode[] =>
      children.filter((c) => !isBreakNode(c));
    const walk = (node: PMNode): Shape => {
      const shape: Shape = { t: node.type.name };
      if (!node.isText && node.childCount > 0) {
        // Count non-text structural children, and recurse into
        // non-text nodes. Text nodes are aggregated by text-length
        // comparison below, not counted here, because PM merges
        // adjacent same-mark text nodes non-deterministically on
        // re-parse.
        const all: PMNode[] = [];
        for (let i = 0; i < node.childCount; i++) all.push(node.child(i));
        // For textblocks (paragraph, heading, list_item content
        // paragraphs), drop leading/trailing breaks before walking.
        // Headings additionally drop INTERIOR breaks because the
        // heading serializer collapses them to spaces (single-line).
        const filtered = node.type.name === "heading"
          ? stripAllBreaks(all)
          : node.isTextblock
          ? trimEdgeBreaks(all)
          : all;
        let textCount = 0;
        const nonTextChildren: Shape[] = [];
        for (const child of filtered) {
          if (child.isText) {
            textCount++;
          } else if (!isEmptyTransient(child)) {
            nonTextChildren.push(walk(child));
          }
        }
        if (textCount > 0) shape.c = 1; // any-text marker, not count
        if (nonTextChildren.length > 0) {
          shape.children = mergeAdjacentLists(nonTextChildren);
        }
      }
      return shape;
    };
    const topShapeRaw: Shape[] = [];
    for (let i = 0; i < doc.childCount; i++) {
      const child = doc.child(i);
      if (!isEmptyTransient(child)) {
        topShapeRaw.push(walk(child));
      }
    }
    const topShape = mergeAdjacentLists(topShapeRaw);
    // textLen tolerance: the serialize-merge of adjacent same-type
    // lists can shift a couple of boundary characters (whitespace
    // tightening, list-item joiners). Tolerate small deltas - the
    // strict-equality check was over-zealous for a layout-only
    // anomaly. Anything larger than 8 chars is still material.
    //
    // Trim trailing whitespace per TOP-LEVEL BLOCK before counting:
    //   - markdown-it strips trailing whitespace from paragraph text
    //     on reparse, so any block whose last text content ends in
    //     " " or "\t" loses those chars on round-trip.
    //   - per-TEXT-NODE trim was wrong: when a mark boundary lands
    //     mid-block (e.g. "sit voluptatem" + bold(" accusantium")),
    //     the serializer's whitespace-expel can move the space from
    //     the marked node to the unmarked one, so reparse has
    //     "sit voluptatem " + bold("accusantium") instead. Per-node
    //     trim hits "sit voluptatem " (-1) but doesn't hit the leading
    //     space on " accusantium" - asymmetric, false-positive.
    //   - block.textContent joins all text nodes inside the block
    //     (atoms contribute 0), so it's the same string in both doc
    //     and reparse. Trimming THAT is symmetric.
    let textLenRaw = 0;
    for (let i = 0; i < doc.childCount; i++) {
      textLenRaw += doc.child(i).textContent.replace(/[ \t]+$/, "").length;
    }
    const textLen = Math.round(textLenRaw / 8) * 8;
    return JSON.stringify({ shape: topShape, textLen });
  }

  /**
   * Install the DOM-event triggers that ask the save scheduler to
   * flush immediately rather than waiting out the idle window.
   * Tracks handlers in `schedulerListeners` so onClose() can
   * remove them cleanly.
   *
   * Triggers wired:
   *   - Document `mousedown` (capture) - user clicked anywhere
   *     OUTSIDE this editor's DOM (file tree, tab bar, ribbon,
   *     status bar, another note's editor). Flushes immediately
   *     so sync / collab / backup systems see the latest bytes
   *     the moment the user's attention has moved on.
   *   - Window `blur` - the whole Obsidian window lost focus
   *     (user switched to another app). On desktop Electron this
   *     is DISTINCT from visibilitychange (which doesn't always
   *     fire when Obsidian stays visible in the background).
   *   - `visibilitychange → hidden` - tab/window fully hidden.
   *     Still useful for minimized windows + mobile browsers.
   *   - `beforeunload` - window is about to close. Best-effort
   *     synchronous flush.
   *
   * Removed: editor-scoped blur listener. The document-level
   * mousedown covers "focus left the editor" more reliably than
   * relying on focusable-descendant blur events firing.
   */
  private installSchedulerTriggers() {
    if (!this.pmView || !this.saveScheduler) return;
    const scheduler = this.saveScheduler;

    const onDocMouseDown = (event: MouseEvent) => {
      if (this.destroyed || !this.pmView) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Click landed inside this editor's own DOM → user is still
      // editing here, don't flush.
      if (this.pmView.dom.contains(target)) return;
      // Click landed elsewhere in Obsidian (file tree, tab bar,
      // sidebar, another note, etc.) - flush whatever's pending
      // so the bytes on disk match what the user was just writing.
      if (scheduler.hasPending()) scheduler.flush();
    };
    activeDocument.addEventListener("mousedown", onDocMouseDown, true);
    this.schedulerListeners.push(() =>
      activeDocument.removeEventListener("mousedown", onDocMouseDown, true),
    );

    const onWindowBlur = () => {
      if (scheduler.hasPending()) scheduler.flush();
    };
    window.addEventListener("blur", onWindowBlur);
    this.schedulerListeners.push(() =>
      window.removeEventListener("blur", onWindowBlur),
    );

    const onVisibility = () => {
      if (activeDocument.visibilityState === "hidden" && scheduler.hasPending()) {
        scheduler.flush();
      }
    };
    activeDocument.addEventListener("visibilitychange", onVisibility);
    this.schedulerListeners.push(() =>
      activeDocument.removeEventListener("visibilitychange", onVisibility),
    );

    const onBeforeUnload = () => {
      if (scheduler.hasPending()) scheduler.flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    this.schedulerListeners.push(() =>
      window.removeEventListener("beforeunload", onBeforeUnload),
    );
  }

  setViewData(data: string, _clear: boolean) {
    this.data = data;
    const body = this.stripFrontmatter(data);
    this.renderProperties();
    if (this.inlineTitleEl && this.file) {
      this.inlineTitleEl.textContent = this.file.basename;
    }
    if (!this.pmView) return;

    // Fast path: same-content echo from our own save.
    const currentMarkdown = this.serializeCurrent();
    if (data === currentMarkdown) return;

    // External change (vault sync, git pull, another plugin edited
    // the file). Apply as a content replace transaction instead of
    // tearing down the whole EditorState - that keeps PM's undo
    // history and plugin state intact across the sync.
    const syncResult = parser.parseWithSourceMap(body);
    const newDoc = syncResult?.doc || schema.node("doc", null, [schema.node("paragraph")]);
    this.captureSourceState(body, syncResult?.doc ?? null);

    // Pre-stage the entrance animation BEFORE the PM dispatch so
    // the first paint already has the first 15 children at the
    // animation's `from` visuals (opacity:0 + 8px translate). Without
    // this, content paints at full opacity for ~2 frames before the
    // double-rAF below adds `.butter-just-loaded` and snaps it to
    // hidden - a visible flash on every note open. Skipped entirely
    // when the user has disabled animations.
    const animsOff = this.plugin.settings.disableAnimations;
    const animEl = animsOff ? null : this.contentEl;
    if (animEl) {
      animEl.classList.remove("butter-just-loaded");
      animEl.classList.add("butter-anim-prepped");
    }

    this.suppressChange = true;
    try {
      const tr = this.pmView.state.tr.replaceWith(
        0,
        this.pmView.state.doc.content.size,
        newDoc.content,
      );
      tr.setMeta("addToHistory", false);
      // Trusted-sync marker - raw-block safety plugin allows this
      // transaction through even if it removes a raw_block, because
      // setViewData's newDoc came from a fresh parse of the latest
      // file bytes (either parse succeeded and the raw_block's
      // replacement is the correct post-fix content, or parse failed
      // again and newDoc contains a new raw_block that still
      // protects the updated source).
      tr.setMeta(RAW_BLOCK_SYNC_META, true);
      this.pmView.dispatch(tr);
    } catch {
      // Replace failed (e.g. schema mismatch). Fall back to hard reset.
      this.pmView.updateState(
        EditorState.create({
          doc: newDoc,
          schema,
          plugins: this.pmView.state.plugins,
        }),
      );
    } finally {
      this.suppressChange = false;
    }

    // Run the entrance animation after PM has dispatched. The prep
    // class set above is holding the first 15 children at opacity:0
    // through this rAF window; on the second frame we swap to the
    // animation class, which shares the same `from` visuals so the
    // transition is seamless. Double-rAF rather than single because
    // class removal needs a paint cycle before the re-add to count
    // as a fresh animation start (a single-rAF swap collapses to a
    // no-op in the browser's animation diffing).
    if (animEl) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          animEl.classList.remove("butter-anim-prepped");
          animEl.classList.add("butter-just-loaded");
          window.setTimeout(() => animEl.classList.remove("butter-just-loaded"), 1100);
        });
      });
    }
  }

  /**
   * Handle navigation requests from the rest of Obsidian - including
   * clicks on headings in the native Outline core plugin, Graph
   * back-links, Search results, Command-palette line jumps, and any
   * third-party plugin that uses `leaf.openFile(file, { eState })`.
   *
   * `eState.line` (and optionally `eState.col`) is Obsidian's standard
   * shape. We translate the line number to a PM position by walking
   * the serialized markdown, then place the caret there.
   */
  setEphemeralState(state: unknown): void {
    (super.setEphemeralState as ((state: unknown) => void) | undefined)?.(state);
    if (!state) return;
    if (!this.pmView) {
      this.pendingEphemeralState = state;
      return;
    }
    this.applyEphemeralState(state);
  }

  private applyEphemeralState(state: unknown) {
    if (!this.pmView || !state) return;
    const lineRaw = (state as { line?: unknown }).line;
    const line = typeof lineRaw === "number" ? lineRaw : undefined;
    if (line == null) return;

    const md = this.frontmatter + serializer.serialize(this.pmView.state.doc);
    const lines = md.split("\n");
    // Walk outward from the requested line to find a nearby non-empty
    // probe: the target line might be empty (blank line), a fence
    // marker, or inside frontmatter, in which case the block we want
    // is usually on an adjacent line.
    const nearbyLineText = (idx: number): string | null => {
      for (let delta = 0; delta <= 3; delta++) {
        for (const sign of delta === 0 ? [0] : [-1, 1]) {
          const i = idx + sign * delta;
          if (i < 0 || i >= lines.length) continue;
          const t = lines[i] ?? "";
          if (t.trim()) return t;
        }
      }
      return null;
    };
    const lineText = nearbyLineText(line) ?? "";
    const probe = lineText
      .replace(/^#+\s*/, "")
      .replace(/^-\s*(\[[ x]\]\s*)?/, "")
      .slice(0, 40)
      .trim();
    if (!probe) return;

    let hitPos: number | null = null;
    this.pmView.state.doc.descendants((node, pos) => {
      if (hitPos !== null) return false;
      if (!node.isTextblock) return true;
      if (node.textContent.includes(probe)) {
        hitPos = pos + 1;
        return false;
      }
      return false;
    });
    if (hitPos !== null) {
      const size = this.pmView.state.doc.content.size;
      const clamped = Math.min(hitPos, size);
      const sel = Selection.near(this.pmView.state.doc.resolve(clamped));
      this.pmView.dispatch(this.pmView.state.tr.setSelection(sel).scrollIntoView());
      this.pmView.focus();
    }
  }

  clear() {
    this.data = "";
    this.frontmatter = "";
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (this.propertiesEl) {
      this.propertiesEl.empty();
      this.propertiesEl.addClass("butter-hidden");
    }
    if (this.pmView) {
      this.suppressChange = true;
      const doc = schema.node("doc", null, [schema.node("paragraph")]);
      this.pmView.updateState(
        EditorState.create({
          doc,
          schema,
          plugins: this.pmView.state.plugins,
        }),
      );
      this.suppressChange = false;
    }
  }
}

// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

/** Every body-level class Butter toggles. Listed here so onunload
 *  can strip them all in one pass and the next DOM inspection
 *  doesn't show residue after disable/uninstall. */
const BUTTER_BODY_CLASSES = [
  "butter-no-anim",
  "butter-status-bar-hide",
  "butter-scroll-hide",
  "butter-mobile-active",
  "butter-mobile-table-active",
  "butter-mobile-prefer-main",
  "butter-mobile-drawer-open",
  "butter-is-dragging",
  "butter-cell-drag-active",
  "butter-cell-drag-copy",
  "butter-table-drag-active",
];

export default class ButterEditorPlugin extends Plugin {
  settings!: ButterSettings;
  /** Remembered when we've flipped the core Outline plugin off so
   *  onunload can restore it - without this we'd leave the user
   *  without an outline if they disable Butter Editor. */
  private disabledNativeOutline = false;
  /** Ribbon icon for our outline, kept to flip visibility when the
   *  setting changes without reloading the plugin. */
  private outlineRibbonEl: HTMLElement | null = null;
  /** Status-bar save-state indicator. Reflects the active view's last
   *  save outcome: clean (round-tripped) or normalized (structure was
   *  altered to satisfy the parser). */
  private saveStatus: SaveStatusController | null = null;
  /** Reference to our settings tab so callers (e.g. the toolbar's
   *  right-click "Settings" item) can pre-select a sub-tab before
   *  opening the modal. */
  private settingTab: ButterSettingTab | null = null;

  /** Worker client for licensing. Initialized in onload(). */
  licenseClient!: LicenseClient;

  /** Computed on every load + on demand; NOT persisted (the underlying
   *  state is in `settings.sessionToken` etc.). Drives read-only
   *  gating in ButterEditorView and the Account settings tab UI.
   *
   *   - `valid`: live session token, plugin is licensed
   *   - `trial`: same as valid but the key is from the trial product
   *     (used by the UI to show "Trial - expires X" instead of just
   *     "Active license")
   *   - `expired`: /session returned license_invalid (revoked or
   *     trial ran out)
   *   - `unlicensed`: never validated; user has not started a trial
   *     or pasted a key
   *   - `unknown`: still resolving (the brief window during onload
   *     before refreshLicenseStatus() returns) */
  licenseStatus: "valid" | "trial" | "expired" | "unlicensed" | "unknown" = "unknown";

  /** When the cached sessionToken expires, in ms epoch. Distinct from
   *  the underlying setting so consumers can read this off the plugin
   *  instance directly. Mirror of `settings.sessionExpiresAt`. */
  get sessionExpiresAt(): number {
    return this.settings?.sessionExpiresAt ?? 0;
  }

  /** Open Obsidian Settings to Butter's tab, optionally jumping to a
   *  specific sub-tab. Used by surfaces (toolbar context menu, etc.)
   *  that want a one-click route into the relevant settings page. */
  openSettings(
    subtab?:
      | "general"
      | "behavior"
      | "toolbar"
      | "advanced"
      | "license",
  ): void {
    if (subtab && this.settingTab) {
      this.settingTab.activeTab = subtab;
    }
    const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    if (!setting) return;
    setting.open?.();
    setting.openTabById?.(this.manifest.id);
  }

  /**
   * Keep Butter locally enabled without requiring trial or license
   * activation. Emits a `butter:license-changed` workspace event when
   * status transitions so existing view refresh hooks still work.
   */
  async refreshLicenseStatus(): Promise<void> {
    const before = this.licenseStatus;
    this.licenseStatus = "valid";

    if (this.licenseStatus !== before) {
      this.app.workspace.trigger("butter:license-changed");
    }
  }

  /** Heuristic: trial-product keys carry either the new `BTR-T-`
   *  prefix (post-prefix-shortening, 2026-05-11+) or the legacy
   *  `BUTTER_TRIAL-` prefix (pre-shortening - existing customers).
   *  Lifetime license keys use the plain `BTR-` or `BUTTER-` prefix.
   *  The Worker doesn't tell us which product a key belongs to from
   *  /session alone, so we infer locally.
   *
   *  Note: the trailing dash on `BTR-T-` is required for
   *  disambiguation - a lifetime key whose body starts with `T`
   *  (e.g. `BTR-TXY8-…`) must NOT match as a trial. The legacy
   *  `BUTTER_TRIAL` is unambiguous on its own (the underscore
   *  guarantees no collision with the `BUTTER-` lifetime prefix). */
  isTrialKey(key: string): boolean {
    return key.startsWith("BTR-T-") || key.startsWith("BUTTER_TRIAL");
  }

  private deriveTrialOrValid(key: string): "valid" | "trial" {
    return this.isTrialKey(key) ? "trial" : "valid";
  }

  /**
   * Background-resume an in-flight trial activation. Called from
   * `onload()`. If `pendingTrialActivation` is set + not stale (< 30
   * min old), fires one `/trial/poll` request. On `ready`, persists
   * the license + clears the pending state + emits
   * `butter:license-changed` so any open Settings re-renders. On
   * `pending`, no-op (the in-tab poller takes over once Settings
   * opens). On `invalid_token`, clears the pending state silently.
   */
  async resumeTrialActivation(): Promise<void> {
    const pending = this.settings.pendingTrialActivation;
    if (!pending) return;
    const ageMs = Date.now() - (pending.startedAt || 0);
    if (ageMs > 30 * 60 * 1000) {
      this.settings.pendingTrialActivation = null;
      await this.saveSettings();
      return;
    }
    try {
      const res = await this.licenseClient.pollTrial(pending.pollToken);
      if (res.status === "ready" && res.licenseKey) {
        this.settings.licenseKey = res.licenseKey;
        if (res.expiresAt) {
          const exp = Date.parse(res.expiresAt);
          if (!Number.isNaN(exp)) this.settings.licenseExpiresAt = exp;
        }
        this.settings.pendingTrialActivation = null;
        if (!this.settings.activatedAt) this.settings.activatedAt = Date.now();
        await this.saveSettings();
        await this.refreshLicenseStatus();
        // refreshLicenseStatus only fires the changed event when the
        // status itself flips. Re-fire here so an open Settings panel
        // also re-renders (e.g. license_expires_at changed even if
        // status was already "trial" via offline-grace heuristic).
        this.app.workspace.trigger("butter:license-changed");
      }
    } catch (err) {
      if (err instanceof LicenseClientError && err.kind === "invalid_token") {
        this.settings.pendingTrialActivation = null;
        await this.saveSettings();
      }
      // Other errors: leave pendingTrialActivation in place - the
      // user's next visit to Settings will retry inline.
    }
  }

  /**
   * Handle the magic-link recovery deep-link
   * `obsidian://butter-recover?key=…&customer=…`. Fired when the
   * customer clicks "Re-open in Butter Editor" on the HTML recovery
   * page served by the Worker.
   *
   * Trust model: the user already proved they control the email by
   * being able to click the link from inside their inbox. The plugin
   * still validates the key against Polar via /session before
   * unlocking - no blind trust. So an attacker who somehow forged a
   * deep-link (URL phishing) can't unlock anything because /session
   * would reject a key that isn't on Polar's records.
   *
   * UX: silently auto-fills + validates. On success: opens settings
   * to the Account tab + toast. On failure: opens to Account tab so
   * the user sees the error context inline.
   */
  async handleRecoveryDeepLink(rawKey?: string, rawCustomer?: string): Promise<void> {
    const key = (rawKey ?? "").trim();
    const customer = (rawCustomer ?? "").trim();
    if (!key) {
      new Notice("Recovery link is missing the license key.", 7000);
      this.openSettings("license");
      return;
    }
    // Email is informational only; we don't enforce it here. The
    // Worker checks the key against Polar's records.
    try {
      const session = await this.licenseClient.validateAndIssueSession(
        key,
        this.settings.deviceId,
      );
      this.settings.licenseKey = key;
      this.settings.sessionToken = session.sessionToken;
      this.settings.sessionExpiresAt = Date.parse(session.expiresAt);
      this.settings.lastValidatedAt = Date.now();
      if (session.customerId) this.settings.customerId = session.customerId;
      this.settings.everValidated = true;
      await this.saveSettings();
      await this.refreshLicenseStatus();
      this.openSettings("license");
      const tag = customer ? ` (${customer})` : "";
      new Notice(`License recovered${tag}.`, 5000);
    } catch (err) {
      const msg = err instanceof LicenseClientError && err.kind === "license_invalid"
        ? "Recovery link's key is not valid (revoked, expired, or unrecognized)."
        : "Couldn't validate the recovered license. Try again from Settings → Account.";
      new Notice(msg, 8000);
      this.openSettings("license");
    }
  }

  async onload() {
    await this.loadSettings();

    // Keep Butter enabled locally without contacting the licensing
    // worker. The license client remains available for legacy helper
    // paths, but startup no longer waits on remote validation.
    this.licenseClient = new LicenseClient();
    await this.refreshLicenseStatus();
    // Magic-link recovery deep-link. The Worker's HTML recovery page
    // renders a button as obsidian://butter-recover?key=…&customer=…
    // - clicking it brings Obsidian to front and lands here. See
    // handleRecoveryDeepLink for the security note.
    this.registerObsidianProtocolHandler("butter-recover", (params) => {
      void this.handleRecoveryDeepLink(params.key, params.customer);
    });

    // Boot toast announcing the running plugin + version. Reads
    // straight from the loaded manifest so dev builds (which inject
    // a "(DEV)" suffix into the name and `-N` into the version)
    // automatically show as `Butter Editor (DEV) v0.9.2-127`, while
    // production builds show `Butter Editor v0.9.2`. The counter in
    // the dev version tells you whether a rebuild actually loaded.
    // new Notice(`${this.manifest.name} v${this.manifest.version}`, 3000);

    // Locked-file UX. When another process holds a vault file open
    // exclusively (VS Code, antivirus mid-scan, another Obsidian
    // instance), Obsidian's readFile throws `EPERM` / `EBUSY` /
    // `EACCES` and the file silently refuses to open with only a
    // cryptic console error. We catch the unhandled rejection at
    // the window level, identify the failing leaf, and swap it to
    // the ButterLockedFileView - a clean explainer with native-
    // styled action buttons (Try again / Open another / New note).
    // Falls back to a Notice if we can't find a target leaf.
    const lockedFileSwapped = new Set<string>();
    this.registerDomEvent(window, "unhandledrejection", (ev: PromiseRejectionEvent) => {
      const err = ev.reason as unknown;
      if (!err) return;
      const errMsg = (err as { message?: unknown }).message;
      const msg =
        typeof errMsg === "string"
          ? errMsg
          : typeof err === "string"
            ? err
            : "";
      if (!/E(PERM|BUSY|ACCES)/.test(msg)) return;
      const pathMatch = msg.match(/'([^']+\.\w+)'/);
      const fullPath = pathMatch?.[1];
      if (!fullPath) return;

      // Normalize: errors give absolute filesystem paths; vault
      // files use vault-relative paths. Try both shapes.
      const vaultRelative = fullPath
        .replace(/^.*[\\/](?=[^\\/]+[\\/])/, "")
        .replace(/\\/g, "/");
      const name = fullPath.split(/[\\/]/).pop() ?? fullPath;

      // Dedupe - multiple rejections per failure are common
      if (lockedFileSwapped.has(fullPath)) return;
      lockedFileSwapped.add(fullPath);
      window.setTimeout(() => lockedFileSwapped.delete(fullPath), 3000);

      // Find the leaf that was trying to show this file. Search
      // order:
      //   1. Markdown/Butter leaves that still have the file set
      //      (rare - usually the leaf gets cleared on failure).
      //   2. The active leaf if it's now "empty" - when the readFile
      //      fails, Obsidian flips the target leaf to its empty
      //      state (the "new tab" page), and that empty leaf is
      //      usually the active one.
      //   3. Any leaf of type "empty" - fallback if more than one
      //      leaf is open or focus moved.
      const allTyped: WorkspaceLeaf[] = [
        ...this.app.workspace.getLeavesOfType("markdown"),
        ...this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER),
      ];
      let target: WorkspaceLeaf | undefined = allTyped.find((l) => {
        const file = (l.view as { file?: TFile } | undefined)?.file;
        return file && (file.path === vaultRelative || fullPath.endsWith(file.path));
      });
      if (!target) {
        const active = this.app.workspace.getMostRecentLeaf();
        if (active && active.view.getViewType() === "empty") {
          target = active;
        }
      }
      if (!target) {
        const empties = this.app.workspace.getLeavesOfType("empty");
        // Single empty leaf → that's our target. Multiple → pick
        // the active one or the first as a best guess.
        target = empties[0];
      }

      // Best vault-relative path: prefer the target leaf's own file
      // path if one is open; otherwise fall back to the precomputed
      // vault-relative path. (Earlier versions iterated every tracked
      // file looking for a suffix match - removed per Obsidian's
      // policy of avoiding `getFiles().find`.)
      const targetFile = (target?.view as { file?: { path?: string } } | undefined)?.file;
      const lockedPath = targetFile?.path ?? vaultRelative;

      if (target) {
        void target.setViewState({
          type: VIEW_TYPE_BUTTER_LOCKED,
          state: { lockedPath, lockedName: name },
        });
      } else {
        // Last resort: Notice toast.
        new Notice(
          `"${name}" is locked by another process. Close the other app and try again.`,
          7000,
        );
      }
    });

    // Mobile chrome scroll-hide. Native Obsidian Mobile fades the
    // view-header chrome out when the user scrolls down through the
    // note and brings it back when they scroll up - what makes the
    // chrome read as "transparent" in casual comparison. The native
    // behavior is wired to `.cm-scroller`, which our PM editor
    // doesn't have. Hook `.butter-editor-view` (our scroller) to the
    // same effect by toggling a body class that CSS targets.
    if (Platform.isMobile) {
      let lastScrollTop = 0;
      const onScroll = (ev: Event) => {
        const target = ev.target as HTMLElement | null;
        if (!target || !target.classList.contains("butter-editor-view")) return;
        const st = target.scrollTop;
        const delta = st - lastScrollTop;
        // Hide chrome when scrolling DOWN past a small threshold;
        // show when scrolling UP or near the top.
        if (st < 24) {
          activeDocument.body.classList.remove("butter-scroll-hide");
        } else if (delta > 6) {
          activeDocument.body.classList.add("butter-scroll-hide");
        } else if (delta < -6) {
          activeDocument.body.classList.remove("butter-scroll-hide");
        }
        lastScrollTop = st;
      };
      this.registerDomEvent(activeDocument, "scroll", onScroll, { capture: true, passive: true });
    }


    // Custom icons - registered once at load so `setIcon(el, "butter-…")`
    // works the same way as Lucide icon IDs anywhere in the plugin.
    // Row / column rectangles with a diagonal strike-through. The
    // strike crosses the shape's center, reading universally as
    // "this is being deleted" (same visual idiom as a struck-out
    // line of text). Direction encodes axis: row icon is a wide-
    // short bar with a strike; column icon is a tall-narrow bar
    // with a strike that crosses through its center.
    // Butter brand mark - the wave-glyph-in-a-rounded-rect logo.
    // Registered as `butter-editor` and referenced by `modeIcon()`
    // for the View-as menu + the editor's mode-cycle button.
    addIcon(
      "butter-editor",
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:1.5;"><g transform="matrix(1,0,0,1,-112.678345,-44.485992)"><g transform="matrix(1.087664,0,0,1.433718,220.741139,-122.077846)"><g transform="matrix(0.023898,0,0,0.018129,-117.145741,104.829128)"><path d="M1206.206,684.914C1576.954,684.914 1610.168,718.128 1610.168,1088.876C1610.168,1459.624 1576.954,1492.838 1206.206,1492.838C835.458,1492.838 802.244,1459.624 802.244,1088.876C802.244,718.128 835.458,684.914 1206.206,684.914Z" fill="none" stroke="currentColor" stroke-width="76.95"/></g><g transform="matrix(0.013632,0,0,0.015879,-106.215729,112.408534)"><path d="M657.622,782.347C670.417,768.126 657.607,765.864 657.607,765.864C657.607,342.578 713.651,304.657 1339.243,304.657C1964.094,304.657 2020.745,342.488 2020.879,764.362L2020.865,765.864C2019.98,968.497 1943.553,862.395 1778.676,999.512C1620.883,1130.737 1475.792,1048.446 1372.478,952.257C1259.153,846.749 1084.931,928.14 1019.59,949.717C810.02,1018.92 587.616,860.151 657.622,782.347ZM925.33,745.67L1751.055,745.67C1786.884,745.67 1815.973,725.988 1815.973,701.746C1815.973,677.503 1786.884,657.821 1751.055,657.821L925.33,657.821C889.501,657.821 860.413,677.503 860.413,701.746C860.413,725.988 889.501,745.67 925.33,745.67ZM925.33,563.005L1488.998,563.005C1524.827,563.005 1553.916,543.323 1553.916,519.08C1553.916,494.838 1524.827,475.156 1488.998,475.156L925.33,475.156C889.501,475.156 860.413,494.838 860.413,519.08C860.413,543.323 889.501,563.005 925.33,563.005Z" fill="currentColor"/></g></g></g></svg>`,
    );

    addIcon(
      "butter-delete-row",
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="10" width="18" height="4" rx="1"/><path d="M4 18l16-12"/></svg>`,
    );
    addIcon(
      "butter-delete-column",
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="3" width="4" height="18" rx="1"/><path d="M6 4l12 16"/></svg>`,
    );

    // Status-bar save indicator. Lucide icon only - `check` when the
    // last save round-tripped cleanly, `triangle-alert` when a save
    // had to fall through to canonical with structural normalization.
    // Click on the warning state opens the diff modal.
    this.saveStatus = installSaveStatus(this, (state) => {
      new SaveDiffModal(this.app, state.original, state.saved, state.reason).open();
    });

    this.registerView(
      VIEW_TYPE_BUTTER,
      (leaf) => new ButterEditorView(leaf, this.settings, this, (result) => {
        this.saveStatus?.set(result);
      }),
    );

    if (this.settings.openNewFilesInButter) {
      this.installExtensionRouting();
    }

    this.registerView(
      VIEW_TYPE_BUTTER_OUTLINE,
      (leaf) => new ButterOutlineView(leaf),
    );

    this.registerView(
      VIEW_TYPE_BUTTER_LOCKED,
      (leaf) => new ButterLockedFileView(leaf, this),
    );

    // Register Butter as a valid `hover-link` source so Obsidian's
    // core page-preview plugin shows hover cards for wikilinks and
    // embeds inside Butter views - same UX as Live Preview / Reading
    // mode. `defaultMod: true` means users who have "require modifier
    // key for preview" enabled must hold that modifier (Obsidian's
    // own preference); we delegate to their setting.
    this.app.workspace.registerHoverLinkSource?.(
      BUTTER_HOVER_SOURCE,
      { display: "Butter Editor", defaultMod: true },
    );

    this.registerCommands();
    this.registerMenus();
    this.registerNewFileHook();
    this.registerFormattingCaptureHandler();
    this.registerPolishCommands();

    // Word + character count in the status bar.
    installWordCount(this, () => {
      const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
      return v?.pmViewRef() ?? null;
    });

    this.settingTab = new ButterSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Apply the animations kill-switch state to body immediately so
    // any in-flight entrance animations or transitions on already-
    // mounted Butter elements are suppressed from the first frame.
    this.applyAnimationsBodyClass();
    this.register(() => activeDocument.body.classList.remove("butter-no-anim"));

    // Obsidian's internal plugins may not be ready at onload; defer
    // the outline-mode reconcile until the workspace is up.
    this.app.workspace.onLayoutReady(() => {
      void this.applyOutlineMode();
      // Wire the cycle action button onto every existing markdown
      // view + every future one. ButterEditorView wires it itself
      // in onOpen - only markdown views need the injection here.
      this.installCycleButtonsOnAllMarkdownViews();
      // First-launch onboarding. Fires only when the user hasn't yet
      // either picked a preset or dismissed the modal - both paths
      // set the flag so subsequent launches skip silently.
      if (!this.settings.hasCompletedOnboarding) {
        new WelcomeModal(this.app, this).open();
      }
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.installCycleButtonsOnAllMarkdownViews();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.installCycleButtonsOnAllMarkdownViews();
        // Reset save-status indicator when switching files. The
        // newly-opened file's first save (whenever it fires) will
        // update the status; until then the indicator shows clean by
        // default. Avoids carrying a "normalized" warning over from a
        // different file the user already moved past.
        this.saveStatus?.set({ kind: "clean" });
      }),
    );

    // Additive-only file-menu integration. Fires for the more-options
    // 3-dot dropdown and tab-header right-click. Strategy:
    //   • Markdown view (current = source/live/reading): Obsidian
    //     already shows native Source/Live preview/Reading view items.
    //     We add a single "Open as Butter" item.
    //   • Butter view (current = butter): Obsidian doesn't surface
    //     the three markdown view-as items here, so we add them all.
    // After adding, we move our items to the TOP of the menu. We
    // only move our own captured `item.dom` elements - no string
    // matching, no removal of native items, no locale fragility.
    this.registerEvent(
      this.app.workspace.on(
        "file-menu",
        (menu: Menu, file: unknown, source: string, leaf?: WorkspaceLeaf) => {
          if (source !== "more-options" && source !== "tab-header") return;
          if (!(file instanceof TFile) || file.extension !== "md") return;
          const targetLeaf = leaf ?? this.app.workspace.getMostRecentLeaf();
          if (!targetLeaf) return;
          const current = getCurrentMode(targetLeaf);
          const ourModes: ButterViewMode[] =
            current === "butter"
              ? ["source", "live", "reading"]
              : ["butter"];

          const addedItems: MenuItem[] = [];
          for (const mode of ourModes) {
            menu.addItem((item) => {
              item.setTitle(`Open as ${modeLabel(mode)}`);
              item.setIcon(modeIcon(mode));
              item.onClick(() => {
                void switchToMode(targetLeaf, mode);
              });
              addedItems.push(item);
            });
          }

          // Promote our items to the top of the menu DOM. We only move
          // elements WE added (captured via the item callback), so this
          // doesn't touch native items or depend on their text - robust
          // across locales and across Obsidian menu-structure tweaks.
          // Iterate in reverse so the final visible order matches the
          // order we added them in.
          const menuDom = menu.dom;
          if (menuDom) {
            for (let i = addedItems.length - 1; i >= 0; i--) {
              const itemDom = (addedItems[i] as MenuItem & { dom?: HTMLElement }).dom;
              if (itemDom && itemDom.parentNode === menuDom) {
                menuDom.insertBefore(itemDom, menuDom.firstChild);
              }
            }
          }
        },
      ),
    );
  }

  private installCycleButtonsOnAllMarkdownViews() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView & {
        _butterCycleAdded?: boolean;
        _butterCycleEl?: HTMLElement;
      };
      // Skip deferred / placeholder views - Obsidian sometimes returns
      // a stub for an unmounted leaf where `addAction` isn't defined.
      // We'll re-run on layout-change once the view becomes real.
      if (typeof view?.addAction !== "function") continue;
      const currentMode = getCurrentMode(leaf) ?? "live";
      const icon = modeIcon(currentMode);

      if (!view._butterCycleAdded) {
        view._butterCycleAdded = true;
        const el = view.addAction(
          icon,
          "Switch view mode",
          () => {
            cycleView(view.leaf, this.settings.viewCycleModes);
          },
        );
        el.setAttribute("data-butter-action", "cycle");
        view._butterCycleEl = el;
      } else if (view._butterCycleEl) {
        // Existing button: refresh icon so it tracks in-place mode
        // changes (Source ↔ Live Preview ↔ Reading don't recreate
        // the view, just toggle mode - addAction wouldn't re-fire,
        // so we update the icon manually on every layout-change).
        setIcon(view._butterCycleEl, icon);
      }

      // Hide Obsidian's native LP/Reading toggle button. Identified by
      // the lucide icon class on its inner SVG - Obsidian uses one of
      // a small known set (book-open / edit-3 / pencil / etc.) for
      // the toggle. We skip our own button via data-butter-action.
      this.hideNativeToggleIn(view);
    }
  }

  private hideNativeToggleIn(view: MarkdownView) {
    if (!view?.containerEl) return;
    const actions = view.containerEl.querySelector(".view-actions");
    if (!actions) return;
    const NATIVE_TOGGLE_ICONS = new Set([
      "lucide-edit-3",
      "lucide-pencil",
      "lucide-pen",
      "lucide-square-pen",
      "lucide-book-open",
      "lucide-eye",
    ]);
    actions.querySelectorAll<HTMLElement>(".clickable-icon").forEach((btn) => {
      if (btn.getAttribute("data-butter-action")) return; // ours, skip
      if (btn.dataset.butterToggleHidden === "1") return; // already hidden
      const svg = btn.querySelector("svg");
      if (!svg) return;
      const hasToggleIcon = Array.from(svg.classList).some((c) =>
        NATIVE_TOGGLE_ICONS.has(c),
      );
      if (!hasToggleIcon) return;
      btn.addClass("butter-hidden");
      btn.dataset.butterToggleHidden = "1";
    });
  }

  onunload(): void {
    // FIRST: flush any in-flight scheduled saves across open Butter
    // views. If the user disables Butter mid-typing (within the save
    // scheduler's idle window), pending edits would otherwise get
    // torn down without firing and the last few keystrokes would be
    // lost. Obsidian unloads the plugin before tearing down its
    // views, so we can't rely on per-view `onClose` to catch this
    // path.
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER);
    for (const leaf of leaves) {
      const view = leaf.view as ButterEditorView | undefined;
      const scheduler = (view as { saveScheduler?: { hasPending: () => boolean; flush: () => void } } | undefined)?.saveScheduler as
        | { hasPending: () => boolean; flush: () => void }
        | null
        | undefined;
      if (scheduler && scheduler.hasPending()) {
        try {
          scheduler.flush();
        } catch {
          /* swallow - save can fail during teardown; onClose will
             get another shot if we make it that far */
        }
      }
    }

    // Strip every body class Butter toggles. The CSS rules these
    // classes target are gone with our styles.css, so they're inert
    // on disable - but leaving them on <body> after uninstall reads
    // as residue when a user inspects the DOM. Cheap to clean up.
    // (`butter-no-anim` is already registered for removal via
    // `this.register()` during enableOnReady; included here too as a
    // belt-and-braces in case that path didn't run.)
    const body = activeDocument.body;
    for (const cls of BUTTER_BODY_CLASSES) {
      body.removeClass(cls);
    }

    // Best-effort: if we turned off core Outline, flip it back on so
    // the user isn't left with no outline when Butter is disabled.
    const core = this.app.internalPlugins?.plugins?.outline;
    if (this.disabledNativeOutline && core && !core.enabled) {
      void (async () => {
        try {
          await core.enable?.();
        } catch {
          /* nothing to do */
        }
      })();
      this.disabledNativeOutline = false;
    }
  }

  private registerCommands() {
    this.addCommand({
      id: "toggle-butter",
      name: "Toggle WYSIWYG mode",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        if (v?.file) {
          if (!checking) swapButterToMarkdown(v);
          return true;
        }
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (md?.file) {
          if (!checking) swapMarkdownToButter(md);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-as-butter",
      name: "Open current note in WYSIWYG view",
      checkCallback: (checking) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!md?.file) return false;
        if (!checking) swapMarkdownToButter(md);
        return true;
      },
    });

    this.addCommand({
      id: "open-as-markdown",
      name: "Switch back to default Markdown view",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        if (!v?.file) return false;
        if (!checking) swapButterToMarkdown(v);
        return true;
      },
    });

    // Find / Replace in note. No default hotkeys - Obsidian's policy
    // discourages default bindings since they can override user-
    // configured hotkeys. Users bind these via Settings → Hotkeys.
    this.addCommand({
      id: "find-in-note",
      name: "Find in note",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        const pm = v?.pmViewRef();
        if (!pm) return false;
        if (!checking) openFind(pm);
        return true;
      },
    });

    this.addCommand({
      id: "replace-in-note",
      name: "Replace in note",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        const pm = v?.pmViewRef();
        if (!pm) return false;
        if (!checking) openReplace(pm);
        return true;
      },
    });

    // ── Formatting shortcuts ───────────────────────────────────
    //
    // Registered at the Obsidian command level rather than as PM
    // keymap bindings. Obsidian's global dispatcher fires the first
    // command whose checkCallback returns true; since `ctx` for a
    // Butter view is a ButterEditorView (not MarkdownView),
    // Obsidian's own `editor:toggle-bold` etc. return false while
    // ours return true, so our commands are the ones that run in
    // Butter while the natives keep working in Source / Live Preview.
    const butterMarkCommand = (
      id: string,
      name: string,
      hotkey:
        | { modifiers: ("Mod" | "Shift" | "Alt" | "Ctrl" | "Meta")[]; key: string }
        | null,
      markName: string,
    ) => {
      this.addCommand({
        id,
        name,
        ...(hotkey ? { hotkeys: [hotkey] } : {}),
        checkCallback: (checking) => {
          const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
          const pm = v?.pmViewRef();
          if (!pm) return false;
          const mark = (pm.state.schema.marks as Record<string, MarkType>)[markName];
          if (!mark) return false;
          if (!checking) toggleMark(mark)(pm.state, pm.dispatch.bind(pm));
          return true;
        },
      });
    };

    butterMarkCommand("toggle-bold", "Toggle bold", null, "strong");
    butterMarkCommand("toggle-italic", "Toggle italic", null, "em");
    butterMarkCommand("toggle-inline-code", "Toggle inline code", null, "code");
    butterMarkCommand(
      "toggle-strikethrough",
      "Toggle strikethrough",
      null,
      "strikethrough",
    );
    butterMarkCommand("toggle-highlight", "Toggle highlight", null, "highlight");
  }

  /**
   * Commands that back the Tier-2 polish layer: outline view, zen
   * mode, shortcut help. All globally-available (palette + ribbon)
   * rather than gated on Butter being active, because they're about
   * the shell / workflow, not document edits.
   */
  private registerPolishCommands() {
    this.addCommand({
      id: "show-shortcuts",
      name: "Show keyboard shortcuts",
      callback: () => new ShortcutHelpModal(this.app).open(),
    });

    this.addCommand({
      id: "open-outline",
      name: "Open outline view",
      checkCallback: (checking) => {
        if (!this.settings.useButterOutline) return false;
        if (!checking) void this.openOutline();
        return true;
      },
    });

    // One-shot source normalizer on the active file. Applies BOTH
    // normalizers (heading-gap + condense-blanks) to the current
    // file's content via vault.modify, independent of the global
    // toggles. Useful for cleaning up a single note without opting
    // in across the vault.
    //
    // If the file has no changes after normalization, no write
    // happens (avoids spurious mtime bumps).
    // Two cleanup commands with deliberately distinct scopes:
    //
    //   "Tidy whitespace" - string-level only. Runs heading-gap +
    //   condense-blanks + close-fences once on the source text. Doesn't
    //   parse the file. Useful for quick whitespace cleanup that doesn't
    //   touch marker style, table padding, or anything else.
    //
    //   "Rewrite in canonical form" - full parse + serialize. Rewrites
    //   markers (bullet/italic/bold), table padding, indentation, blank-
    //   line layout. Then applies normalizers if their toggles are on.
    //   The thorough cleanup; expect a bigger diff.
    this.addCommand({
      id: "normalize-current-note",
      name: "Tidy whitespace in current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.normalizeCurrentFile();
        return true;
      },
    });

    this.addCommand({
      id: "canonicalize-current-note",
      name: "Rewrite current note in canonical form",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.canonicalizeFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "canonicalize-vault",
      name: "Rewrite entire vault in canonical form (irreversible - Git commit first)",
      callback: () => void this.canonicalizeVaultWithConfirm(),
    });

    // Mobile-friendly error inspection. Mobile Obsidian has no
    // accessible JS console, so console.error is invisible to the
    // user. The error ring buffer in debug.ts captures recent
    // entries; this command surfaces them in a modal that's
    // copy-able + clearable.
    this.addCommand({
      id: "show-recent-errors",
      name: "Show recent errors",
      callback: () => {
        new ErrorLogModal(this.app, getErrorLog(), () => clearErrorLog()).open();
      },
    });

    this.outlineRibbonEl = this.addRibbonIcon(
      "list-tree",
      "Open Butter outline",
      () => this.openOutline(),
    );
    // Applied on layout-ready below (see applyOutlineMode).
  }

  private async openOutline() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_BUTTER_OUTLINE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_BUTTER_OUTLINE, active: true });
    await workspace.revealLeaf(leaf);
  }

  /**
   * Read the active markdown file, apply both normalizers to its
   * body (preserving frontmatter + line-ending style), and write the
   * result back. No-op if normalization produces the same bytes.
   *
   * Operates at the FILE level (not through the PM view), so it
   * works regardless of whether the current view is Butter, Live
   * Preview, Source, or Reading. Also independent of the global
   * toggles - users can invoke this for one-off cleanup without
   * opting into automatic normalization vault-wide.
   */
  private async normalizeCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    const original = await this.app.vault.read(file);

    // Detect + strip frontmatter so the normalizer runs on body only.
    // We re-attach frontmatter verbatim. Butter's parser doesn't
    // handle YAML frontmatter directly - it's a separate top-matter
    // construct Obsidian owns.
    const fmMatch = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(original);
    const frontmatter = fmMatch ? fmMatch[1] : "";
    const body = fmMatch ? original.slice(fmMatch[1].length) : original;

    // Preserve line ending. Work on LF internally then restore.
    const crlf = /\r\n/.test(body);
    const bodyLF = body.replace(/\r\n/g, "\n");

    const normalizedLF = normalizeSource(bodyLF, {
      headingGap: true,
      condenseBlanks: true,
      closeUnclosedFences: true,
    });

    if (normalizedLF === bodyLF) return; // no change - skip write

    const normalized = crlf
      ? normalizedLF.replace(/\n/g, "\r\n")
      : normalizedLF;

    await this.app.vault.modify(file, frontmatter + normalized);
  }

  /**
   * Build the canonical-form options object from current settings.
   * Used by the canonicalize commands and the save path so they
   * stay in lockstep - same preferences applied wherever canonical
   * synthesis happens.
   */
  private canonicalOptionsFromSettings() {
    return {
      bullet: this.settings.canonicalBullet,
      italic: this.settings.canonicalItalic,
      bold: this.settings.canonicalBold,
      codeFence: this.settings.canonicalCodeFence,
      horizontalRule: this.settings.canonicalHorizontalRule,
    };
  }

  /**
   * Force-canonicalize a single file. Parse the body, serialize via
   * canonical (honoring user's marker preferences), apply enabled
   * normalizers, write back.
   *
   * Frontmatter is preserved byte-identical (Butter's parser doesn't
   * own YAML; that's Obsidian's surface). Line endings + BOM are
   * preserved at the file shell level.
   *
   * Skips writing if the canonical output equals the input - avoids
   * spurious mtime bumps and sync events for already-canonical files.
   *
   * Returns: { changed: boolean, error?: string } so the vault-wide
   * driver can report aggregate results without throwing on per-file
   * parse failures.
   */
  private async canonicalizeFile(
    file: TFile,
  ): Promise<{ changed: boolean; error?: string }> {
    try {
      const original = await this.app.vault.read(file);

      // BOM detection.
      let hasBOM = false;
      let afterBOM = original;
      if (original.charCodeAt(0) === 0xfeff) {
        hasBOM = true;
        afterBOM = original.slice(1);
      }

      // Frontmatter passthrough.
      const fmMatch = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/.exec(afterBOM);
      const frontmatter = fmMatch ? fmMatch[1] : "";
      const body = fmMatch ? afterBOM.slice(fmMatch[1].length) : afterBOM;

      const isCRLF = body.includes("\r\n");
      const bodyLF = body.replace(/\r\n/g, "\n");

      // Trailing-newline count from input. Canonical default is 1
      // when ambiguous; preserve when explicit.
      const trailMatch = bodyLF.match(/\n*$/);
      const trailingCount = trailMatch ? Math.max(1, trailMatch[0].length) : 1;

      const doc = parser.parse(bodyLF);
      if (!doc) {
        return { changed: false, error: "parse returned null" };
      }

      let canonical = serializer.serialize(
        doc,
        this.canonicalOptionsFromSettings(),
      );

      // Apply enabled normalizers AFTER canonical-serialize. They're
      // idempotent and operate on the source string.
      if (
        this.settings.normalizeHeadingGap ||
        this.settings.condenseBlankLines ||
        this.settings.closeUnclosedFences
      ) {
        canonical = normalizeSource(canonical, {
          headingGap: this.settings.normalizeHeadingGap,
          condenseBlanks: this.settings.condenseBlankLines,
          closeUnclosedFences: this.settings.closeUnclosedFences,
        });
      }

      // Restore trailing-newline count.
      canonical = canonical.replace(/\n*$/, "") + "\n".repeat(trailingCount);

      // Reattach frontmatter, line-ending, BOM.
      let out = frontmatter + canonical;
      out = out.replace(/\r\n/g, "\n"); // normalize first
      if (isCRLF) out = out.replace(/\n/g, "\r\n");
      if (hasBOM) out = "﻿" + out;

      if (out === original) return { changed: false };

      await this.app.vault.modify(file, out);
      return { changed: true };
    } catch (e) {
      const err = e as { message?: string };
      return {
        changed: false,
        error: String(err?.message ?? e),
      };
    }
  }

  /**
   * Show a confirm modal then iterate every .md file in the vault,
   * canonicalizing each. Reports aggregate counts via Notice.
   * Long-running (~ms per file × file count) - chunked into yields
   * so the UI doesn't freeze.
   */
  private async canonicalizeVaultWithConfirm(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const ok = await new Promise<boolean>((resolve) => {
      new CanonicalizeVaultModal(this.app, files.length, resolve).open();
    });
    if (!ok) return;

    const startNotice = new Notice(
      `Canonicalizing ${files.length} files…`,
      0,
    );
    let changed = 0;
    let unchanged = 0;
    let errored = 0;
    const errorSamples: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const result = await this.canonicalizeFile(file);
      if (result.error) {
        errored++;
        if (errorSamples.length < 5) {
          errorSamples.push(`${file.path}: ${result.error}`);
        }
      } else if (result.changed) {
        changed++;
      } else {
        unchanged++;
      }

      // Yield to the event loop every 25 files so the UI breathes
      // and the user can cancel via reload if something hangs.
      if (i % 25 === 0) {
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }

    startNotice.hide();
    const summary =
      `Canonicalized: ${changed} changed, ${unchanged} unchanged` +
      (errored ? `, ${errored} errored` : "");
    new Notice(summary, 8000);
    if (errored) {
      console.warn(
        "[butter] Canonicalize errors:\n" + errorSamples.join("\n"),
      );
    }
  }

  /** Toggle `body.butter-no-anim` to match the current setting. The
   *  CSS rule keyed off this class nukes animations + transitions on
   *  every Butter-prefixed element and the ProseMirror tree. Called
   *  on plugin load and whenever the user flips the setting. */
  applyAnimationsBodyClass(): void {
    activeDocument.body.classList.toggle(
      "butter-no-anim",
      this.settings.disableAnimations,
    );
  }

  /**
   * Reconcile the world with `settings.useButterOutline`:
   *
   *   • On ─ disable core Outline (remembered so we can restore on
   *     unload / setting-off). Show our ribbon and command.
   *   • Off ─ close any open Butter Outline leaves and re-enable
   *     core Outline if we were the one that disabled it. Hide our
   *     ribbon.
   */
  async applyOutlineMode() {
    const core = this.app.internalPlugins?.plugins?.outline;
    if (this.settings.useButterOutline) {
      if (core?.enabled && !this.disabledNativeOutline) {
        this.disabledNativeOutline = true;
        try {
          await core.disable?.();
        } catch {
          this.disabledNativeOutline = false;
        }
      }
      if (this.outlineRibbonEl) this.outlineRibbonEl.removeClass("butter-hidden");
    } else {
      for (const leaf of this.app.workspace.getLeavesOfType(
        VIEW_TYPE_BUTTER_OUTLINE,
      )) {
        leaf.detach();
      }
      if (this.disabledNativeOutline && core && !core.enabled) {
        try {
          await core.enable?.();
        } catch {
          /* user can re-enable manually if this fails */
        }
        this.disabledNativeOutline = false;
      }
      if (this.outlineRibbonEl) this.outlineRibbonEl.addClass("butter-hidden");
    }
  }

  /** Push the experimental theme-compat class state to every active
   *  Butter view so the setting's toggle takes effect immediately
   *  without the user reopening each file. */
  public applyThemeCompatModeToAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.applyThemeCompatMode === "function") {
        v.applyThemeCompatMode();
      }
    }
  }

  /** Push the toolbar-position preference to every active Butter view.
   *  Updates the data-toolbar-pos attribute (CSS swaps sticky-top vs
   *  sticky-bottom rules) AND moves the toolbar DOM node to the end /
   *  before-editor position so sticky positioning has the right
   *  ancestor placement. Called from the settings tab on dropdown
   *  change. */
  public applyToolbarPositionToAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.applyToolbarPosition === "function") {
        v.applyToolbarPosition();
      }
    }
  }

  /** Push toolbar button visibility (from settings) to every active
   *  Butter view. Called from the settings tab when the user toggles
   *  a per-button hide/show. */
  public applyToolbarButtonVisibilityToAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.applyToolbarButtonVisibility === "function") {
        v.applyToolbarButtonVisibility();
      }
    }
  }

  private registerMenus() {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) => {
          item
            .setTitle("Open in Butter editor")
            .setIcon("edit-3")
            .onClick(() => {
              const leaf = this.app.workspace.getLeaf(false);
              void leaf.setViewState({
                type: VIEW_TYPE_BUTTER,
                state: { file: file.path },
              });
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        menu.addItem((item) => {
          item
            .setTitle("Switch to Butter editor")
            .setIcon("edit-3")
            .onClick(() => swapMarkdownToButter(view));
        });
      }),
    );
  }

  /**
   * Install a document-level keydown listener in CAPTURE phase so
   * Butter's formatting hotkeys intercept before Obsidian's own
   * command dispatcher (which would otherwise route Ctrl+B through
   * `editor:toggle-bold` against our editor shim and eat the event).
   *
   * Only fires when the active view is a ButterEditorView with an
   * active PM editor; otherwise the event is left alone so Obsidian's
   * native hotkeys keep working in Source / Live Preview / every
   * other view type.
   */
  private registerFormattingCaptureHandler() {
    const isMod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

    const handler = (evt: KeyboardEvent) => {
      if (!isMod(evt)) return;

      const key = evt.key.toLowerCase();
      const shift = evt.shiftKey;
      let markName: string | null = null;
      if (!shift) {
        if (key === "b") markName = "strong";
        else if (key === "i") markName = "em";
        else if (key === "e") markName = "code";
      } else {
        if (key === "s") markName = "strikethrough";
        else if (key === "h") markName = "highlight";
      }
      if (!markName) return;

      const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
      const pm = v?.pmViewRef();
      if (!pm) return;

      const target = evt.target as Node | null;
      if (!target || !v!.containerEl.contains(target)) return;

      const mark = pm.state.schema.marks[markName];
      if (!mark) return;

      evt.preventDefault();
      evt.stopImmediatePropagation();
      toggleMark(mark)(pm.state, pm.dispatch.bind(pm));
    };

    // Window capture phase is the earliest listener slot in the DOM
    // event chain - earlier than any document-level handler Obsidian
    // or another plugin could register. Whichever one Obsidian's own
    // hotkey dispatcher uses, ours fires first and claims the event
    // (via stopImmediatePropagation) when Butter is the target. For
    // all other views, the handler early-returns and the event
    // continues to native hotkey processing.
    this.registerDomEvent(window, "keydown", handler, { capture: true });
    this.registerDomEvent(activeDocument, "keydown", handler, { capture: true });
  }

  /**
   * Route .md files to Butter at the view-registry level so every
   * open path - file-explorer click, wikilink, quick-switcher,
   * new-note, OS drag-drop - creates a Butter view directly instead
   * of a MarkdownView we then race-swap. Obsidian's public
   * `Plugin.registerExtensions` throws on conflict (the built-in
   * markdown view already owns `.md`), so we operate on the
   * underlying viewRegistry: capture the current handler, install
   * ours, and restore the captured handler on plugin unload.
   *
   * The explicit "switch to source/live/reading" cycle still works
   * because `swapButterToMarkdown` sets the leaf's view type to
   * `"markdown"` directly, which bypasses the extension map.
   *
   * Setting-gated; takes effect on plugin load only. Toggling
   * `openNewFilesInButter` at runtime requires a reload.
   *
   * `viewRegistry` is internal API. The whole flow is guarded so a
   * future Obsidian version that renames or removes it degrades
   * gracefully to "no auto-route"; the file-open polling hook below
   * picks up the slack via the swap-after-mount path.
   *
   * Partial-failure handling: if `unregister` succeeds but `register`
   * for Butter throws, we restore the captured handler immediately
   * so `.md` files don't end up orphaned mid-session.
   */
  private installExtensionRouting() {
    const reg = this.app.viewRegistry;
    const previous: string | undefined = reg?.typeByExtension?.["md"];
    if (
      !previous ||
      typeof reg?.unregisterExtensions !== "function" ||
      typeof reg?.registerExtensions !== "function"
    ) {
      return;
    }
    try {
      reg.unregisterExtensions(["md"]);
    } catch (e) {
      recordError("auto-butter", `unregister .md failed: ${String(e)}`);
      return;
    }
    try {
      reg.registerExtensions(["md"], VIEW_TYPE_BUTTER);
    } catch (e) {
      recordError("auto-butter", `register .md → butter failed: ${String(e)}`);
      try { reg.registerExtensions(["md"], previous); } catch { /* best-effort restore */ }
      return;
    }
    this.register(() => {
      try {
        reg.unregisterExtensions?.(["md"]);
        reg.registerExtensions?.(["md"], previous);
      } catch (e) {
        recordError("auto-butter", `restore .md handler on unload failed: ${String(e)}`);
      }
    });
  }

  private registerNewFileHook() {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.openNewFilesInButter) return;
        if (!file || file.extension !== "md") return;
        // Poll for up to ~10 frames (~165ms @ 60fps) looking for a
        // MarkdownView leaf showing the just-opened file. file-open
        // fires at variable points across open paths:
        //   - file-explorer click: leaf already mounted, find on attempt 0
        //   - quick-switcher: usually 1-2 frames late
        //   - link click that converts a butter leaf back to markdown:
        //     Obsidian fires file-open BEFORE the view-type swap
        //     completes, so we need to wait until the swap lands
        // A fixed single-rAF deferral handled the easy paths but lost
        // the race on the slow ones, leaving the leaf in Live Preview.
        this.tryAutoSwapToButter(file, 0);
      }),
    );
  }

  /** Locate any leaf showing `file` as a MarkdownView and swap it to
   *  Butter. Re-arms via `requestAnimationFrame` up to MAX_ATTEMPTS so
   *  we catch leaves that haven't finished mounting yet. Short-
   *  circuits silently if the file is already in a Butter view (the
   *  expected path now that view-registry routing sends .md straight
   *  to Butter). Only logs when an actual swap is performed or when
   *  the budget runs out without finding either butter or markdown
   *  view - those are the real signals worth noticing. */
  private tryAutoSwapToButter(file: TFile, attempt: number) {
    const MAX_ATTEMPTS = 10;
    if (!this.settings.openNewFilesInButter) return;
    let target: WorkspaceLeaf | null = null;
    let alreadyButter = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (alreadyButter) return;
      const view = leaf.view;
      if (view instanceof ButterEditorView && view.file?.path === file.path) {
        alreadyButter = true;
        return;
      }
      if (!target && view instanceof MarkdownView && view.file?.path === file.path) {
        target = leaf;
      }
    });
    if (alreadyButter) return; // routed directly via extension map - nothing to do
    if (target) {
      debug("auto-butter", `swap on attempt ${attempt}:`, file.path);
      void (target as WorkspaceLeaf).setViewState({
        type: VIEW_TYPE_BUTTER,
        state: { file: file.path },
      });
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      debug("auto-butter", `no butter or markdown leaf after ${attempt} attempts:`, file.path);
      return;
    }
    window.requestAnimationFrame(() => this.tryAutoSwapToButter(file, attempt + 1));
  }

  async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    // Sanitize: only carry forward keys we know about. Unknown keys
    // accumulate when settings are renamed or removed in code but
    // the saved data.json keeps the old field. Without this filter,
    // `Object.assign({}, DEFAULT_SETTINGS, raw)` would preserve them
    // on every save in perpetuity. We track whether any were dropped
    // and force a clean save below so the on-disk file matches the
    // in-memory shape immediately.
    const known = new Set(Object.keys(DEFAULT_SETTINGS));
    const filtered: Record<string, unknown> = {};
    let hadUnknownKeys = false;
    for (const [k, v] of Object.entries(raw)) {
      if (known.has(k)) filtered[k] = v;
      else hadUnknownKeys = true;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, filtered);
    // Migrate legacy mobileToolbarStyle keys ("native" / "butter") to
    // the new names ("detached" / "attached"). Old data.json files
    // still have the legacy values; rename them in-memory now and
    // mark dirty so the new key gets written on the next save.
    {
      const raw = this.settings.mobileToolbarStyle as unknown as string;
      if (raw === "native") {
        this.settings.mobileToolbarStyle = "detached";
        hadUnknownKeys = true;
      } else if (raw === "butter") {
        this.settings.mobileToolbarStyle = "attached";
        hadUnknownKeys = true;
      }
    }
    // Push verbose-logging state to the module flag so debug() calls
    // across the plugin pick up the current setting without having
    // to thread `settings` through every file.
    setVerbose(this.settings.verboseLogging);
    // Migrate legacy hidden-button arrays to the new layout tree.
    // Only runs when the layout is null (first load with new code).
    // The hidden arrays are left in place so a downgrade still works.
    if (this.settings.toolbarLayout === null) {
      this.settings.toolbarLayout = migrateFromHiddenList(
        defaultMainLayout(),
        this.settings.toolbarHiddenButtons,
      );
    } else {
      // Existing layout - replace any legacy `heading` button with
      // the new individual H1-H6 split (saved layouts from before
      // the split would otherwise reference an unknown id).
      this.settings.toolbarLayout = migrateLegacyHeadingButton(
        this.settings.toolbarLayout,
      );
    }
    if (this.settings.tableToolbarLayout === null) {
      this.settings.tableToolbarLayout = migrateFromHiddenList(
        defaultTableLayout(),
        this.settings.tableToolbarHiddenButtons,
      );
    }
    // Generate a per-install device ID on first load. Used as the
    // stable identifier for trial dedupe + session token binding.
    // crypto.randomUUID is available in Obsidian's Electron context.
    let deviceIdGenerated = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      deviceIdGenerated = true;
    }
    // Persist the cleaned shape if we discarded anything - without
    // this the stale keys would re-appear in data.json on the next
    // save (since saveData writes the whole settings object). The
    // re-save is a no-op if `hadUnknownKeys` is false.
    if (hadUnknownKeys || deviceIdGenerated) await this.saveSettings();
  }

  /** Resolve the user's main toolbar layout - returns the customized
   *  layout if set, otherwise a fresh copy of the default. The toolbar
   *  reader gets a deep clone so direct mutations don't leak into
   *  settings (the settings tab does explicit save + rebuild).
   *
   *  Desktop-specific: `mobileToolbarLayout` is queried separately
   *  via `getMobileToolbarLayout()`. The render path uses the
   *  platform-aware `getActiveToolbarLayout()`, which dispatches
   *  between the two based on `Platform.isMobile`. */
  public getMainToolbarLayout(): ToolbarLayoutItem[] {
    return this.settings.toolbarLayout ?? defaultMainLayout();
  }

  /** Mobile-specific main-toolbar layout - see `getMainToolbarLayout`.
   *  Customizer reads this directly when on the Mobile segment so
   *  the user can prepare their phone layout from desktop. */
  public getMobileToolbarLayout(): ToolbarLayoutItem[] {
    return this.settings.mobileToolbarLayout ?? mobileLayoutDefault();
  }

  /** Platform-aware resolver. Render-path callers (the main
   *  toolbar's `getLayout` callback) use this so the same toolbar
   *  factory works on both desktop and mobile without each
   *  consumer needing to know about the split. */
  public getActiveToolbarLayout(): ToolbarLayoutItem[] {
    if (Platform.isMobile) return this.getMobileToolbarLayout();
    return this.getMainToolbarLayout();
  }

  public getTableToolbarLayout(): ToolbarLayoutItem[] {
    return this.settings.tableToolbarLayout ?? defaultTableLayout();
  }

  public getMobileTableToolbarLayout(): ToolbarLayoutItem[] {
    return (
      this.settings.mobileTableToolbarLayout ?? mobileTableLayoutDefault()
    );
  }

  public getActiveTableToolbarLayout(): ToolbarLayoutItem[] {
    if (Platform.isMobile) return this.getMobileTableToolbarLayout();
    return this.getTableToolbarLayout();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Re-apply on every save so the Debug-tab toggle takes effect
    // without reloading the plugin.
    setVerbose(this.settings.verboseLogging);
  }
}

// Settings tab moved to src/settings-tab.ts.

/**
 * Modal that confirms a vault-wide canonicalization. Shows the
 * affected file count and warns that the operation isn't undoable
 * from inside Butter - recommends a git commit beforehand.
 */
/**
 * In-app error log viewer. Mobile Obsidian has no accessible JS
 * console, so this modal surfaces the recent-errors ring buffer for
 * users who hit a save error on phone or tablet.
 */
class ErrorLogModal extends Modal {
  constructor(
    app: App,
    private entries: { timestamp: number; category: string; message: string }[],
    private onClear: () => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Butter - recent errors (${this.entries.length})`);

    if (this.entries.length === 0) {
      contentEl.createEl("p", {
        text: "No errors recorded since plugin load. Things look good.",
      });
      return;
    }

    const desc = contentEl.createEl("p", {
      cls: "setting-item-description",
    });
    desc.setText(
      "Most-recent error first. Long-press to copy, paste into a bug " +
        "report. The buffer holds the last 50 entries; older ones are " +
        "discarded.",
    );

    const list = contentEl.createDiv({ cls: "butter-error-log-list" });
    // Newest first.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const row = list.createDiv({ cls: "butter-error-log-entry" });
      const meta = row.createEl("div", {
        cls: "butter-error-log-meta",
      });
      const ts = new Date(e.timestamp);
      meta.setText(
        `[${ts.toLocaleTimeString()}] [${e.category}]`,
      );
      const msg = row.createEl("pre", {
        cls: "butter-error-log-msg",
      });
      msg.setText(e.message);
      // Class-driven styles - see .butter-error-log-* in styles.css.
      row.addClass("butter-error-log-row");
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const closeBtn = btnRow.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());
    const clearBtn = btnRow.createEl("button", {
      text: "Clear log",
      cls: "mod-warning",
    });
    clearBtn.addEventListener("click", () => {
      this.onClear();
      this.close();
      new Notice("Butter error log cleared.");
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class CanonicalizeVaultModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private fileCount: number,
    private resolve: (ok: boolean) => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Canonicalize entire vault?");
    contentEl.createEl("p", {
      text:
        `This will rewrite every markdown file in the vault (${this.fileCount} files) in canonical form using your current marker preferences. Each file is parsed, re-serialized, and written back.`,
    });
    contentEl.createEl("p", {
      text:
        "This operation is not undoable from inside Butter. Strongly recommended: commit your vault to Git first, so you have a recovery point if a file's canonical form turns out to be unexpected.",
    });
    contentEl.createEl("p", {
      text:
        "Files that fail to parse will be skipped and reported. Files already in canonical form will not be touched (no spurious mtime bumps).",
    });
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const okBtn = btnRow.createEl("button", {
      text: "Canonicalize all files",
      cls: "mod-warning",
    });
    cancelBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(false);
      this.close();
    });
    okBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(true);
      this.close();
    });
  }
  onClose() {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}
