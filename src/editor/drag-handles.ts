/**
 * Block drag handles - pointer-based reorder engine inspired by the
 * Notion/Craft interaction model.
 *
 * Why pointer events, not HTML5 drag-and-drop:
 *   • Full control over the ghost image (custom styling, animated,
 *     cursor-tracked via transform) instead of the blurry snapshot
 *     the browser produces.
 *   • No dataTransfer payload to pollute the drop target. HTML5 DnD
 *     + contenteditable causes the browser to paste the payload as
 *     text if ProseMirror's own drop handler fires - plus it needs
 *     defensive capture-phase registration to avoid that. Pointer
 *     events bypass the whole system.
 *   • Smooth autoscroll near viewport edges with quadratic easing.
 *   • Esc-to-cancel is a one-line keydown listener.
 *
 * Architecture:
 *   • Hover detection probes a stable X inside the content column
 *     using `document.elementFromPoint`, so moving from block → handle
 *     (through the gutter gap) doesn't clear hover state.
 *   • Drag engine: pointerdown on the handle arms a "click-or-drag"
 *     check - only starts the drag after the pointer has moved >4px,
 *     leaving room for a future click-menu integration.
 *   • Drop analysis: find the nearest top-level block under the
 *     cursor's Y, decide before/after by the pointer's position
 *     relative to the block's vertical midpoint.
 */
import {
  Plugin as PMPlugin,
  PluginKey,
  TextSelection,
  NodeSelection,
} from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { App, Menu, Notice, Platform } from "obsidian";
import { scrollHost } from "../util/dom-utils";
import {
  dispatchMultiBlock,
  getMultiBlockSelection,
  openMultiBlockContextMenu,
  computeListSubtree,
} from "./multi-block-select";
import {
  buildSingleBlockMenuItems,
  renderBlockMenuItems,
  applyBlockContextMenuChrome,
  blockMenuLabel,
  blockMenuHeaderIcon,
} from "./block-menu-spec";

const key = new PluginKey("butter-drag-handles");

// Modifier-click and double-click multi-select handling moved into
// multi-block-select.ts (its document mousedown listener handles
// gestures via capture phase, which is more robust than the handle's
// own pointerdown - avoids races with Obsidian's menu auto-dismiss).

// ── Block context menu ──────────────────────────────────────────
//
// Opens an Obsidian `Menu` when the user clicks (but doesn't drag)
// the handle. Items are block-type aware: every block can be Copied
// to the clipboard (as its markdown source), Duplicated, or Deleted.
// Code blocks add a "Change language…" entry that opens the inline
// picker popover. Headings add a level changer. Callouts add a type
// changer. List items add indent/outdent.
//
// Implementation notes:
//   • `serializeNode` is injected from main.ts - the drag-handle
//     plugin doesn't itself depend on the serializer, so we take a
//     `(PMNode) => string` callback.
//   • Clipboard writes use `navigator.clipboard.writeText`; we
//     swallow promise rejections (permission prompts, HTTP context)
//     and show a short `Notice` so the user isn't left guessing.
//   • Duplicate clones the node via `type.create(attrs, content, marks)`
//     - this is a *structural* copy, not a reference copy, so editing
//     the duplicate doesn't mutate the original.

// Header label + icon helpers moved to `block-menu-spec.ts` so
// link / inline-atom context menus can reuse the same per-node
// labels when they synthesize their own headers.

// ── Turn into & per-type menu items ─────────────────────────────
// Moved to `block-menu-spec.ts` so the multi-block menu can share the
// same item catalog and intersect across the selection.


/**
 * Open the single-block context menu for the block under the drag
 * handle. Block-type-specific items (Turn into, code Edit source /
 * Language, Callout type, List type, math Edit source) are sourced
 * from `buildSingleBlockMenuItems` in `block-menu-spec.ts` - same
 * catalog the multi-block menu intersects against. Universal lifecycle
 * actions (Copy, Duplicate, Delete) live inline here.
 */
export function openBlockContextMenu(
  app: App,
  e: PointerEvent | MouseEvent,
  view: EditorView,
  block: BlockHit,
  serializeNode: (node: PMNode) => string,
): Menu {
  const menu = new Menu();
  const { node, pos } = block;

  // ── Block-type-specific items (Turn into, code Edit source /
  // Language, math Edit source, Callout type, List type). Built
  // from `block-menu-spec.ts` and rendered via `renderBlockMenuItems`
  // so the multi-block menu can drive itself off the same catalog.
  const specItems = buildSingleBlockMenuItems({
    view,
    pos,
    node,
    app,
    blockDom: block.dom,
  });
  if (specItems.length > 0) {
    renderBlockMenuItems(menu, specItems, (item) => {
      // Single-block click: dispatch the item against this one block.
      // For applyTr items, build a fresh tr and dispatch; for sideEffect
      // items, run them directly. Using the latest state.tr each click
      // keeps positions valid even after prior menu interactions.
      if (item.applyTr) {
        const tr = view.state.tr;
        item.applyTr(tr, pos, node);
        if (tr.docChanged) view.dispatch(tr);
        view.focus();
      } else if (item.sideEffect) {
        item.sideEffect(view, pos, node);
      }
    });
  }

  // ── Universal lifecycle actions ────────────────────────────
  menu.addSeparator();

  menu.addItem((item) => {
    item.setTitle("Copy");
    item.setIcon("copy");
    item.onClick(async () => {
      try {
        const md = serializeNode(node);
        await navigator.clipboard.writeText(md.replace(/\n+$/, ""));
        new Notice("Copied block");
      } catch {
        new Notice("Clipboard write failed");
      }
    });
  });

  menu.addItem((item) => {
    item.setTitle("Duplicate");
    item.setIcon("copy-plus");
    item.onClick(() => {
      const after = pos + node.nodeSize;
      const clone = node.type.create(node.attrs, node.content, node.marks);
      view.dispatch(view.state.tr.insert(after, clone));
    });
  });

  menu.addSeparator();

  menu.addItem((item) => {
    item.setTitle("Delete");
    item.setIcon("trash-2");
    // setWarning is the blessed API on recent Obsidian versions; it
    // also applies the `is-warning` class that styles the item red.
    // Cast + optional-chain guard against older API shapes.
    item.setWarning?.(true);
    item.dom?.classList.add("is-warning");
    item.onClick(() => {
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
    });
  });

  // Put the block into PM's NodeSelection so the editor has a
  // proper "this whole block is selected" state - gets the
  // .ProseMirror-selectednode class (styled with a dim outline in
  // styles.css) and enables keyboard shortcuts (Backspace deletes
  // the block, Cmd+C copies it as markdown, etc.). Unifies our
  // "click selected" hint with PM's native node-selection state
  // rather than maintaining a parallel class.
  try {
    const tr = view.state.tr.setSelection(
      NodeSelection.create(view.state.doc, pos),
    );
    view.dispatch(tr);
  } catch {
    /* some nodes can't be NodeSelected (rare, e.g. positions that
       aren't at a node boundary). Menu still opens; selection stays
       wherever it was. */
  }

  // Notion-style placement: menu opens just to the LEFT of the drag
  // handle (in the gutter / page margin). If there isn't room - the
  // editor is narrow, fullscreen, or zoomed in close - flip to the
  // RIGHT side of the handle, opening over the start of the block
  // content. Width + header chrome standardized via
  // `applyBlockContextMenuChrome` so every block type's menu is the
  // same size and the alignment math is reliable.
  const charCount = node.textContent.length;
  applyBlockContextMenuChrome(menu, {
    icon: blockMenuHeaderIcon(node),
    title: blockMenuLabel(node),
    sub: `Block · ${charCount} char${charCount === 1 ? "" : "s"}`,
  });

  const HANDLE_OFFSET_LEFT = 30; // showHandleAt: 30px gutter offset
  const HANDLE_WIDTH = 22;
  const MENU_GAP = 6;
  const MENU_WIDTH = 240; // matches CSS lock
  const blockRect = block.dom.getBoundingClientRect();
  const handleLeft = blockRect.left - HANDLE_OFFSET_LEFT;
  const handleRight = handleLeft + HANDLE_WIDTH;
  const leftX = handleLeft - MENU_GAP - MENU_WIDTH;
  const x = leftX >= 8 ? leftX : handleRight + MENU_GAP;
  // Top-anchor against the block - mirrors Notion's "menu sits at
  // the top of the block" attachment, regardless of where in the
  // block the click originated.
  const y = Math.max(8, blockRect.top);
  menu.showAtPosition({ x, y });
  return menu;
}

export interface DragSettings {
  motion: "springy" | "snappy" | "smooth";
  handleVisibility: "hover" | "always";
}

const MOTION_CURVES: Record<DragSettings["motion"], { spring: string; soft: string }> = {
  springy: {
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    soft: "cubic-bezier(0.2, 1.2, 0.4, 1)",
  },
  snappy: {
    spring: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    soft: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
  smooth: {
    spring: "cubic-bezier(0.4, 0, 0.2, 1)",
    soft: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
};

const EXCLUDED_NODES = new Set([
  // Inline atoms (not block-level; drag handle wouldn't make sense).
  "image",
  "hard_break",
  "block_id",
  "obsidian_tag",
  "wikilink",
  "inline_math",
  "inline_footnote",
  "footnote_ref",
  "block_comment",
]);

// SELF_FRAMED_NODES (and the .is-self-framed CSS branch that went
// with it) dropped - every block is treated uniformly by its own
// border-box bounds. Ghost radius comes from
// `getComputedStyle(sourceBlock).borderRadius` at drag time, so
// callouts / code / images that already have their own chrome
// don't need a special ghost rule - the ghost mirrors their
// radius exactly by definition.

interface BlockHit {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
}

/** Mutable rect shape used by BlockEntry. Plain object instead of
 *  DOMRect so we can pre-allocate a reusable buffer in the drag
 *  plugin and rewrite fields per pointermove rather than allocating
 *  N × DOMRect every frame. DOMRect's top/bottom/left/right are
 *  read-only getters, which forces fresh-construction per call. */
interface BlockRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface BlockEntry {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
  rect: BlockRect;
}

function listTopLevelBlocks(view: EditorView): BlockEntry[] {
  const doc = view.state.doc;
  const blocks: BlockEntry[] = [];
  doc.forEach((node: PMNode, offset: number) => {
    if (EXCLUDED_NODES.has(node.type.name)) return;
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const dr = dom.getBoundingClientRect();
    blocks.push({
      pos: offset,
      node,
      dom,
      rect: {
        top: dr.top,
        bottom: dr.bottom,
        left: dr.left,
        right: dr.right,
        width: dr.width,
        height: dr.height,
      },
    });
  });
  return blocks;
}

interface DropResolution {
  hit: BlockHit;
  where: "before" | "after";
  /** Viewport Y of the true gap center between the involved blocks
   *  same value whether the pointer is in the upper or lower half of
   *  the margin between them. */
  gapY: number;
  /** Horizontal bounds of the gap for indicator width. */
  gapLeft: number;
  gapRight: number;
  /** Index of the target block in the blocks list (for reuse by
   *  reflow so it doesn't have to rescan). */
  targetIdx: number;
}

/**
 * Find the drop target for a pointer at `clientY`. Splits the editor
 * into zones - block N owns Y from the midpoint to its prev block's
 * bottom to the midpoint to its next block's top - so every Y resolves
 * cleanly with no deadzone in the margin gaps. Inside each zone, the
 * pointer's position relative to the block's own midpoint decides
 * "before" vs "after".
 *
 * `blocks` is passed in (rather than computed here) so the caller can
 * reuse the same cached list between target resolution and reflow
 * each `getBoundingClientRect` call forces a layout recompute when
 * styles/transforms are pending, so making 56 of them per frame
 * (list twice) is the main source of drag sluggishness. Down to 28.
 */
function findDropTarget(
  blocks: BlockEntry[],
  clientY: number,
): DropResolution | null {
  if (!blocks.length) return null;

  // Binary search: blocks are in doc order ≈ vertical order, and the
  // per-block zones tile the Y axis with shared boundaries (zone N's
  // lowerBound == zone N+1's upperBound), so the predicate is
  // monotonic in i. O(log N) instead of O(N) - matters at 500+ blocks
  // when the cursor moves every frame during a drag.
  let lo = 0;
  let hi = blocks.length - 1;
  let foundIdx = -1;
  while (lo <= hi) {
    const i = (lo + hi) >>> 1;
    const b = blocks[i];
    const prevBottom = i > 0 ? blocks[i - 1].rect.bottom : b.rect.top - 9999;
    const nextTop =
      i < blocks.length - 1 ? blocks[i + 1].rect.top : b.rect.bottom + 9999;
    const upperBound = (prevBottom + b.rect.top) / 2;
    const lowerBound = (b.rect.bottom + nextTop) / 2;
    if (clientY < upperBound) {
      hi = i - 1;
    } else if (clientY >= lowerBound) {
      lo = i + 1;
    } else {
      foundIdx = i;
      break;
    }
  }
  if (foundIdx < 0) return null;

  const i = foundIdx;
  const b = blocks[i];
  const prevBottom = i > 0 ? blocks[i - 1].rect.bottom : b.rect.top - 9999;
  const mid = (b.rect.top + b.rect.bottom) / 2;
  const where: "before" | "after" = clientY < mid ? "before" : "after";
  const pair = where === "before"
    ? { aBottom: prevBottom, bTop: b.rect.top }
    : {
        aBottom: b.rect.bottom,
        bTop: i < blocks.length - 1 ? blocks[i + 1].rect.top : b.rect.bottom,
      };
  const gapY = (pair.aBottom + pair.bTop) / 2;
  return {
    hit: { pos: b.pos, node: b.node, dom: b.dom },
    where,
    gapY,
    gapLeft: b.rect.left,
    gapRight: b.rect.right,
    targetIdx: i,
  };
}

function moveBlock(
  view: EditorView,
  fromPos: number,
  toPos: number,
): { newPos: number } | null {
  const doc = view.state.doc;
  const node = doc.nodeAt(fromPos);
  if (!node) return null;
  const end = fromPos + node.nodeSize;

  let targetPos = toPos;
  if (targetPos > fromPos) targetPos -= node.nodeSize;

  const tr = view.state.tr.delete(fromPos, end).insert(targetPos, node);
  const caretTarget = Math.min(targetPos + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caretTarget)));
  view.dispatch(tr);
  return { newPos: targetPos };
}

/**
 * Move a contiguous run of top-level blocks (`fromPos`, total size
 * `totalSize`, captured `nodes`) to `toPos`. Used for list_item drags
 * that include nested children - the parent + each child get deleted
 * as one range and re-inserted as a single sequence so the subtree
 * stays intact and the relative order is preserved. Returns the new
 * doc position of the FIRST inserted node (the parent).
 */
/**
 * Move a set of top-level blocks to `toPos`, preserving doc order
 * relative to each other. Items must be `{pos, node}` and may be
 * non-contiguous (multi-block selection drag) - each is deleted in
 * place, then all are reinserted as a contiguous run at the target.
 *
 * Returns the new doc position of the FIRST inserted node.
 */
function moveBlocks(
  view: EditorView,
  items: { pos: number; node: PMNode }[],
  toPos: number,
): { newPos: number } | null {
  if (items.length === 0) return null;
  if (items.length === 1) return moveBlock(view, items[0].pos, toPos);
  const sorted = [...items].sort((a, b) => a.pos - b.pos);
  const tr = view.state.tr;
  // Delete from highest pos to lowest so earlier deletions don't
  // shift the positions of later ones.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { pos, node } = sorted[i];
    tr.delete(pos, pos + node.nodeSize);
  }
  // Each item with pos < toPos shifts the target by -nodeSize once
  // its delete is applied. Items with pos > toPos shift content
  // AFTER toPos but leave toPos unchanged.
  let targetAdjust = 0;
  for (const { pos, node } of sorted) {
    if (pos < toPos) targetAdjust += node.nodeSize;
  }
  const targetPos = Math.max(0, toPos - targetAdjust);
  const nodes = sorted.map((it) => it.node);
  tr.insert(targetPos, nodes);
  const caretTarget = Math.min(targetPos + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caretTarget)));
  view.dispatch(tr);
  return { newPos: targetPos };
}

/**
 * Update a list_item's `depth` attr in place. Used after a drag
 * that included a horizontal-cursor depth change (Notion-style
 * drag-nesting).
 */
function applyListItemDepth(
  view: EditorView,
  itemPos: number,
  depth: number,
): void {
  const node = view.state.doc.nodeAt(itemPos);
  if (!node || node.type.name !== "list_item") return;
  if ((node.attrs.depth as number) === depth) return;
  view.dispatch(
    view.state.tr.setNodeMarkup(itemPos, undefined, {
      ...node.attrs,
      depth,
      sourceRange: null,
    }),
  );
}

export function dragHandlePlugin(
  app: App,
  getSettings: () => DragSettings = () => ({
    motion: "springy",
    handleVisibility: "hover",
  }),
  /** Mobile-only: called when the user taps the editor with the
   *  keyboard down - the view uses this to flip PM's `editable`
   *  prop back on so the contenteditable accepts focus + typing.
   *  No-op on desktop. */
  unlockMobileEditable: () => void = () => {},
  serializeNode: (node: PMNode) => string = (n) => n.textContent,
) {
  // Plugin state for the "source-being-dragged" decoration.
  //
  // Why decorations instead of `el.style.opacity = "0"` /
  // `el.classList.add("butter-drag-source")`: those direct DOM
  // mutations land on a node that PM is also watching via
  // MutationObserver. PM treats them as foreign edits and re-creates
  // the NodeView, throwing away our styling. The drag-source ends up
  // visible at full opacity AND the cycle repeats every pointermove
  // (logged in 0.17.4 as "compact collapse on P.(no class)" 17×).
  // Decorations are PM's official channel for view-only attribute
  // overlays - applied through PM's own update pipeline, so they
  // don't trip the observer loop.
  /** Duration for push reflow + decoration release transitions. WAAPI
   *  push animations and the source's max-height release CSS transition
   *  are sized to this same value so the visual ends in sync. */
  const PUSH_DURATION = 240;
  const PUSH_EASING = "cubic-bezier(0.2, 1.2, 0.4, 1)";
  type DragDecoState = {
    sourcePos: number;
    sourceSize: number;
    /** When set, the decoration applies opacity:0 + overflow:hidden.
     *  The max-height clamp itself is driven by a WAAPI animation on
     *  source.dom in startDrag (CSS transitions can't go `none →
     *  length`, so we use WAAPI which handles any value pair).
     *  Tracked here just to distinguish compact vs non-compact mode
     *  in the style branch above. */
    capHeight?: number;
    /** When true, the decoration applies the
     *  `butter-drag-source-collapsed` class to every group member
     *  (in addition to opacity:0). The class has CSS transitions
     *  for max-height / margin / padding to 0, so the source slot
     *  smoothly shrinks. Used for multi-block drags so the source-
     *  side reservation matches the capped placeholder at the drop
     *  target - same visual language as compact-mode single-block.
     *  Routed through the decoration so PM's MutationObserver
     *  doesn't see the class change as a foreign edit. */
    collapsed?: boolean;
    /** When dragging a list_item parent, includes all nested-child
     *  positions (subsequent contiguous list_items at greater depth).
     *  Each gets its own opacity:0 decoration so the whole subtree
     *  fades during the drag - not just the parent. Omitted (or just
     *  [sourcePos]) for non-list drags. */
    groupPositions?: number[];
  };
  return new PMPlugin<DragDecoState | null>({
    key,
    state: {
      init() {
        return null;
      },
      apply(tr, value) {
        const meta = tr.getMeta(key) as DragDecoState | null | undefined;
        if (meta !== undefined) {
          // Explicit set/clear via dispatch.
          return meta;
        }
        if (!value) return value;
        // Map source position through any document changes (not
        // strictly expected during drag, but defensive).
        const mapped = tr.mapping.map(value.sourcePos, 1);
        const mappedGroup = value.groupPositions?.map((p) =>
          tr.mapping.map(p, 1),
        );
        return { ...value, sourcePos: mapped, groupPositions: mappedGroup };
      },
    },
    props: {
      decorations(state) {
        const value = key.getState(state) as DragDecoState | null;
        if (!value) return null;
        const node = state.doc.nodeAt(value.sourcePos);
        if (!node) return null;
        // Inline style only - DO NOT apply the existing
        // `.butter-drag-source` / `.butter-drag-source-collapsed`
        // classes. Those rules force `max-height: 0`, zero margins,
        // zero padding etc., which collapses the source's layout slot
        // entirely AND cascades into surrounding blocks (visible as
        // horizontal misalignment because the editor's column layout
        // and gutter offsets are computed relative to the source's
        // intact box). Inline `opacity: 0` (always) and inline
        // `max-height` (compact mode only) give exactly the visual
        // we want without disturbing the rest of the layout.
        // Source-block styling during drag. Decoration handles
        // opacity (always:0 in compact AND non-compact) plus
        // overflow:hidden in compact (so the WAAPI max-height
        // animation actually clips content during transition).
        // The max-height value itself is animated by a WAAPI
        // animation on source.dom - see startDrag's
        // sourceCollapseAnim.
        // Multi-block drags need overflow:hidden so the WAAPI
        // max-height animation in startDrag actually clips content
        // during the shrink (otherwise the box collapses but content
        // still paints outside it). Same overflow:hidden applies to
        // single compact-mode (capHeight set).
        const needsClip = value.capHeight != null || value.collapsed;
        const style = needsClip
          ? `opacity: 0 !important; overflow: hidden !important; transition: none !important;`
          : `opacity: 0 !important; transition: none !important;`;
        const positions = value.groupPositions ?? [value.sourcePos];
        const decos: Decoration[] = [];
        for (const pos of positions) {
          const n = state.doc.nodeAt(pos);
          if (!n) continue;
          decos.push(Decoration.node(pos, pos + n.nodeSize, { style }));
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
    view(editorView) {
      // `host` is mutable. On Obsidian reload the editor's DOM can be
      // reparented after this plugin initializes (the leaf gets moved
      // into the live workspace once the layout settles). Capturing
      // the parent once would strand the handle in the original -
      // now detached - container, which is exactly what was happening
      // in 0.9.4-86 ("drag handles vanish after reload, only return
      // when the tab is closed and reopened"). Re-anchor before any
      // handle update to keep the handle in the current parent. */
      const initialHost = editorView.dom.parentElement;
      if (!initialHost) return { destroy() {} };
      let host: HTMLElement = initialHost;

      // Always set position:relative on the host - unconditionally.
      // The previous gated form (`if (getComputedStyle.position ===
      // "static") set relative`) failed silently on workspace restore:
      // getComputedStyle returned a value that wasn't "static" before
      // host was fully connected to the document, so the branch
      // skipped, host stayed at default `static`, and the absolutely-
      // positioned handle resolved against the wrong containing
      // block - landing hundreds of pixels below where it belonged.
      // Inline style on host is idempotent + identical-value writes
      // don't trigger layout, so unconditional is the right shape.
      host.addClass("butter-pos-relative-host");

      /** Resolve the editor's current parent and, if it differs from
       *  the cached `host`, move the handle over. Also re-attaches
       *  the handle if it has been removed from the document tree
       *  (e.g., Obsidian's workspace restore detaches some node
       *  ancestor and the leftover handle node is no longer reachable
       *  from document.body). Called before every showHandleAt AND
       *  on every mousemove so the repair happens at the moment the
       *  user starts trying to use the handle.
       *  Returns true when host is current + handle is attached,
       *  false when nothing's resolvable (editor temporarily detached
       *  entirely - rare; treat as "wait for next event"). */
      const ensureHostCurrent = (): boolean => {
        const current = editorView.dom.parentElement;
        if (!current) return false;
        if (current !== host) {
          host = current;
          if (getComputedStyle(host).position === "static") {
            host.addClass("butter-pos-relative-host");
          }
        }
        if (handle.parentElement !== host || !handle.isConnected) {
          host.appendChild(handle);
        }
        return true;
      };

      const applyMotion = () => {
        const { motion } = getSettings();
        const curves = MOTION_CURVES[motion];
        activeDocument.documentElement.style.setProperty(
          "--butter-drag-spring",
          curves.spring,
        );
        activeDocument.documentElement.style.setProperty(
          "--butter-drag-spring-soft",
          curves.soft,
        );
      };
      applyMotion();

      // ── DOM elements ──────────────────────────────────────────

      const handle = activeDocument.createElement("div");
      handle.className = "butter-drag-handle";
      handle.setAttribute("aria-label", "Drag to reorder block");
      handle.setAttribute("contenteditable", "false");
      const gripDots = activeDocument.createElement("div");
      gripDots.className = "butter-drag-grip-dots";
      for (let i = 0; i < 6; i++) gripDots.appendChild(activeDocument.createElement("span"));
      handle.appendChild(gripDots);
      host.appendChild(handle);

      // Diagnostic dump for the `Butter: dump drag handle state`
      // command. Stashed on the editor's DOM so the command handler
      // can find the right plugin instance for the active view.
      (editorView.dom as unknown as { __butterDragDiag?: () => string })
        .__butterDragDiag = () => {
        const dom = editorView.dom;
        const hostNow = dom.parentElement;
        const handleRect = handle.getBoundingClientRect();
        const dr = dom.getBoundingClientRect();
        const blocks = listTopLevelBlocks(editorView);
        return [
          `host stable? ${hostNow === host}`,
          `host connected? ${hostNow ? hostNow.isConnected : "null"}`,
          `host pos: ${hostNow ? getComputedStyle(hostNow).position : "n/a"}`,
          `editor rect: ${Math.round(dr.left)},${Math.round(dr.top)} ${Math.round(dr.width)}x${Math.round(dr.height)}`,
          `handle in DOM? ${handle.isConnected}`,
          `handle parent === host? ${handle.parentElement === hostNow}`,
          `handle classes: ${handle.className}`,
          `handle rect: ${Math.round(handleRect.left)},${Math.round(handleRect.top)} ${Math.round(handleRect.width)}x${Math.round(handleRect.height)}`,
          `handle inline: top=${handle.style.top} left=${handle.style.left}`,
          `blocks found: ${blocks.length}`,
          `1st block rect: ${blocks[0] ? Math.round(blocks[0].rect.top) + "," + Math.round(blocks[0].rect.bottom) : "n/a"}`,
          `currentHit pos: ${currentHit ? currentHit.pos : "null"}`,
          `dragState: ${dragState ? "active" : "null"}`,
        ].join("\n");
      };


      // Ghost is created on demand per drag, destroyed on end.
      let ghost: HTMLElement | null = null;
      // Reflow: live-preview mode. Source collapses (class only);
      // target block and all top-level blocks after it get shifted
      // down by sourceHeight via CSS transform. A placeholder
      // (absolute-positioned in `host`, outside PM's DOM) occupies
      // the opened gap. NO DOM insertions into editorView.dom - all
      // changes are class toggles and inline `transform`/`style.--`
      // custom-property tweaks that PM doesn't serialize.
      let reflowPlaceholder: HTMLElement | null = null;
      // Source collapse: in compact mode the source's max-height
      // animates from natural → cap at drag start, and back at
      // teardown. WAAPI on source.dom (not a CSS transition) because
      // CSS transitions don't animate `none ↔ length` - both
      // endpoints must be lengths. WAAPI takes any value pair.
      // The animation doesn't mutate the element's inline style
      // attribute (it composites at render time), so PM's
      // MutationObserver doesn't trip.
      let sourceCollapseAnim: Animation | null = null;
      /** Per-element push animations. Map lets us diff against a new
       *  target's required set on each mousemove: keep running what's
       *  still needed, retract what's no longer needed, spin up what's
       *  new. `shift` is the current signed translation (px) applied to
       *  the element - positive = down, negative = up. Needed so that
       *  when the push direction flips mid-drag (target moves from
       *  below source to above source), we retract the old direction's
       *  transform before applying the new one. */
      let pushedByEl = new Map<
        HTMLElement,
        { anim: Animation; shift: number; pos: number }
      >();
      let reflowState: {
        hitPos: number;
        where: "before" | "after";
      } | null = null;

      // ── State ─────────────────────────────────────────────────

      let currentHit: BlockHit | null = null;
      let dragState: {
        source: BlockHit;
        /** Source's natural vertical footprint = distance from
         *  source's border-top to the next sibling's border-top.
         *  Used by the release-phase decoration's max-height growback
         *  target so source un-clamps back to its real height. */
        actualFootprint: number;
        /** The amount push transforms shift shift-set blocks by.
         *  In compact mode this is the cap (so the visual gap during
         *  drag matches the cap-sized placeholder). In non-compact
         *  mode it's the full footprint (no cap to apply). */
        pushAmount: number;
        /** Placeholder UI height. Always = pushAmount (cap-sized in
         *  compact mode, full size in non-compact). */
        placeholderHeight: number;
        /** True when the source is taller than HUGE_BLOCK_MAX_HEIGHT_PX
         *  and the decoration is clamping its max-height. */
        compact: boolean;
        /** capContentHeight passed to the decoration when compact,
         *  computed once at drag start: cap minus collapsed-margin-
         *  to-next so the source's footprint to its neighbor below
         *  matches the cap size exactly. */
        capContentHeight: number;
        /** Where the cursor was relative to the source block's top-
         *  left at drag start. The ghost is positioned so this same
         *  offset is preserved - so if the user grabbed by the handle
         *  (to the left of the block), the ghost appears to the right
         *  of the cursor just like the block was, and it feels like
         *  the cursor is still holding that spot. */
        grabOffset: { x: number; y: number };
        /** Rendered height of the ghost element, captured once after
         *  buildGhost runs. Used by scheduleDropAnalysis to compute
         *  the drop-trigger Y at the ghost's vertical midpoint
         *  (rather than the cursor tip), so drops feel anchored to
         *  the center of what the user is carrying. */
        ghostHeight: number;
        dropInfo: { hit: BlockHit; where: "before" | "after"; depth?: number } | null;
        cancelled: boolean;
        pointerId: number;
        /** Group of nodes that move together. Always contains at least
         *  the source. For a list_item parent it also contains every
         *  nested child (subsequent contiguous list_items at greater
         *  depth). Used by the commit logic to delete + re-insert the
         *  whole subtree in one transaction, by the block cache to
         *  exclude all members from drop-target candidates, and by the
         *  footprint math to size push/placeholder for the full group
         *  height. */
        group: {
          positions: number[];
          nodes: PMNode[];
          /** Total nodeSize across the whole group. For contiguous
           *  groups this matches `lastPos+lastSize − firstPos`; for
           *  non-contiguous (multi-block selection) it's the sum of
           *  member sizes only - the doc spans BETWEEN selected
           *  blocks aren't part of it. */
          totalSize: number;
          /** True when the group is a single contiguous run in doc
           *  order (subtree, scope-select, range). False when it
           *  came from a non-contiguous multi-block selection
           *  (ctrl-click toggles). The no-op-drop check uses this
           *  to avoid treating a multi-block drag as a no-op when
           *  the cursor lands inside the group's bounding span. */
          contiguous: boolean;
        };
        /** For explicit multi-block drags only: the per-member doms
         *  whose inline style we forced into a collapsed state at
         *  startDrag, with their original cssText so finishDrag /
         *  cancel can restore them. Empty list for single-block or
         *  list_item subtree drags. */
        collapsedMemberStyles: { dom: HTMLElement; originalCss: string }[];
        /** Multi-block-only: every WAAPI Animation we started to
         *  collapse a member's max-height/margin/padding/border.
         *  finishDrag cancels them all so fill:forwards doesn't
         *  leave moved/cancelled members stuck collapsed. */
        collapsedAnimations: Animation[];
        /** When the source is a `list_item`, depth-during-drag is
         *  active. Cached values needed every pointermove without
         *  reading layout: the editor's content-edge X (where
         *  paragraphs start), the resolved `--list-indent` in pixels,
         *  and the source item's current depth (caps the new depth
         *  so the source can never end up at a depth its destination
         *  context can't validly host). */
        listDrag?: {
          /** X coordinate of the editor's content edge (column 0).
           *  Cursor X minus this value, divided by `indentPx`,
           *  floored, gives the depth column the pointer is currently
           *  over - so depth tracks where the cursor IS visually,
           *  not how far it's moved. */
          contentLeftX: number;
          indentPx: number;
          sourceDepth: number;
        };
      } | null = null;

      // Pending = user has pressed down on handle but we haven't
      // decided click-or-drag yet. Prevents hover from being cleared
      // during this brief arming window.
      let pendingDrag: {
        startX: number;
        startY: number;
        block: BlockHit;
        pointerId: number;
        armed: boolean;
      } | null = null;

      let rafHandle: number | null = null;
      let autoscrollHandle: number | null = null;
      let autoscrollSpeed = 0;
      /** Cached scroller element + its viewport-space rect, captured
       *  once per drag. The scroll container's OWN position doesn't
       *  change while the user drags - only its contents scroll.
       *  Re-querying `getBoundingClientRect` on every pointermove
       *  forces a layout recompute that on a 5000-block doc can cost
       *  ~90ms and show up as a 100ms longtask per pointer event. */
      let cachedScroller: HTMLElement | null = null;
      let cachedScrollerRect: DOMRect | null = null;

      // Tracks whichever block has its context menu open right now,
      // so the handle can be PINNED visible at that block (rather
      // than hover-toggling away when the pointer drifts) and any
      // new pointer interaction can dismiss the menu cleanly. Set
      // when the menu opens, cleared via `menu.onHide`.
      // Tracks whichever block has its context menu open right now,
      // so the handle can be PINNED visible at that block (rather
      // than hover-toggling away when the pointer drifts) and any
      // new pointer interaction can dismiss the menu cleanly. Set
      // when the menu opens, cleared via `menu.onHide`.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      let activeMenuBlock: BlockHit | null = null;
      let activeMenu: Menu | null = null;
      const closeActiveMenu = () => {
        if (activeMenu) {
          try { activeMenu.hide(); } catch { /* swallow */ }
          activeMenu = null;
        }
        activeMenuBlock = null;
      };

      // ── Hover: show handle on block ───────────────────────────

      // In-flight fade-in WAAPI animation. We use WAAPI (not CSS
      // transitions) for the fade-in because CSS transitions only
      // fire when the BEFORE / AFTER painted opacity differ - when
      // the handle is already visible at block A and we set up
      // is-visible at block B in the same JS task, the engine sees
      // opacity:1 → opacity:1 across paints and skips the
      // transition (handle teleports). WAAPI runs imperatively:
      // each call kicks off a fresh 0→1 animation regardless of
      // whether the handle was previously visible. Stored at view
      // scope so subsequent showHandleAt or hideHandle calls can
      // cancel a stale animation.
      let fadeInAnim: Animation | null = null;

      const showHandleAt = (hit: BlockHit) => {
        if (!ensureHostCurrent()) return;
        const hostRect = host.getBoundingClientRect();
        const blockRect = hit.dom.getBoundingClientRect();
        // Vertical anchor:
        //   • Callouts: center on the title row, not the outer shell.
        //     A callout's first content line is the title bar (which
        //     has its own padding); aligning to the shell's top puts
        //     the handle visibly above the title glyph.
        //   • Code blocks: mirror the callout treatment - align with
        //     the first line of code (or the top of the widget in view
        //     mode), not the shell border. The shell has padding +
        //     language tag + (when delegated) the edit-toolbar slot
        //     above the visible content, so a top-of-block anchor lands
        //     visibly above the first character.
        //   • Other tall blocks (paragraphs, headings, lists): near
        //     the top so the handle aligns with the first line of text
        //     - the "Notion-style" attachment point.
        //   • Short blocks (horizontal rules, thin embeds): top-anchor
        //     puts the 22px handle mostly below the block. Center
        //     instead when block height < handle height + margin.
        const HANDLE_HEIGHT = 22;
        const centerAnchor = blockRect.height < HANDLE_HEIGHT + 4;
        let topPx: number;
        if (hit.node.type.name === "obsidian_callout") {
          const titleEl = hit.dom.querySelector(
            ".butter-callout-header",
          );
          const titleRect = (titleEl ?? hit.dom).getBoundingClientRect();
          topPx =
            titleRect.top - hostRect.top + host.scrollTop +
            (titleRect.height - HANDLE_HEIGHT) / 2;
        } else if (hit.node.type.name === "code_block") {
          const mode =
            (hit.dom.dataset.butterMode as "view" | "edit") || "view";
          // Edit mode: a collapsed Range at the start of the <code>
          // element returns a rect whose height IS the rendered
          // line-height of the code at that caret position - by
          // definition font-calibrated. Just center on it.
          // View mode: rendered widgets (Mermaid, charts, tables)
          // don't have a "line" - but the wrap element inherits the
          // surrounding font / line-height, so reading
          // `getComputedStyle(...).lineHeight` gives the same per-
          // line metric the user would see if the widget were code.
          // That keeps the visual offset consistent with edit mode.
          let firstLineTop: number | null = null;
          let lineH = 0;
          if (mode === "edit") {
            const codeEl = hit.dom.querySelector(
              ".butter-code-block code",
            );
            if (codeEl) {
              try {
                const r = activeDocument.createRange();
                r.selectNodeContents(codeEl);
                r.collapse(true);
                const rect = r.getBoundingClientRect();
                if (rect.height > 0) {
                  firstLineTop = rect.top;
                  lineH = rect.height;
                }
              } catch {
                /* fall through to top-anchor */
              }
            }
          } else {
            const widgetEl = hit.dom.querySelector(
              ".butter-code-view-wrap",
            );
            if (widgetEl) {
              const wrapRect = widgetEl.getBoundingClientRect();
              const cs = getComputedStyle(widgetEl);
              const parsed = parseFloat(cs.lineHeight);
              const fs = parseFloat(cs.fontSize) || 13;
              // `line-height: normal` reports as "normal" → NaN here;
              // fall back to ~1.5× font size, which is what most
              // browsers resolve "normal" to for monospace text.
              const inferredLH = Number.isFinite(parsed) ? parsed : fs * 1.5;
              firstLineTop = wrapRect.top;
              lineH = inferredLH;
            }
          }
          if (firstLineTop !== null) {
            topPx =
              firstLineTop - hostRect.top + host.scrollTop +
              (lineH - HANDLE_HEIGHT) / 2;
          } else {
            topPx = blockRect.top - hostRect.top + host.scrollTop + 2;
          }
        } else if (centerAnchor) {
          topPx =
            blockRect.top - hostRect.top + host.scrollTop +
            (blockRect.height - HANDLE_HEIGHT) / 2;
        } else {
          topPx = blockRect.top - hostRect.top + host.scrollTop + 2;
        }
        const newPosKey = String(hit.pos);
        const sameBlock =
          handle.dataset.blockPos === newPosKey &&
          handle.classList.contains("is-visible") &&
          fadeInAnim === null;

        // Compensate for negative `margin-left` on the block so the
        // handle aligns with the block's CONTENT edge, not its
        // margin-box edge. Lists set `margin-left: -var(--list-indent)`
        // to keep their LI content flush with paragraphs while the
        // marker column sits in the page margin - without this
        // adjustment a list block's handle would land that much
        // further left than every other block's handle.
        const ml = parseFloat(getComputedStyle(hit.dom).marginLeft) || 0;
        const visualLeft = blockRect.left - Math.min(0, ml);

        handle.style.top = `${topPx}px`;
        handle.style.left = `${visualLeft - hostRect.left - 30}px`;
        // Stamp the block's doc position on the handle. Used by
        // the multi-block-select plugin's mousedown listener (which
        // fires reliably via document capture phase) to handle
        // shift/ctrl/double-click extends WITHOUT depending on the
        // handle's own pointerdown listener - that listener can be
        // raced by Obsidian's menu auto-dismiss flow, which clears
        // currentHit before pointerdown processes.
        handle.dataset.blockPos = newPosKey;
        handle.classList.add("is-visible");

        if (!sameBlock) {
          // Cancel any in-flight fade so the new one starts at 0.
          // Without cancelling, two animations would compose and
          // the handle's opacity would double-jump.
          if (fadeInAnim) fadeInAnim.cancel();
          // WAAPI fade-in. `fill: "backwards"` applies the first
          // keyframe (opacity 0) immediately on play, so even if
          // the handle was visible at a prior block this snaps it
          // invisible before fading back in - no teleport flash.
          fadeInAnim = handle.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 100, easing: "ease-out", fill: "backwards" },
          );
          fadeInAnim.onfinish = () => {
            fadeInAnim = null;
          };
          fadeInAnim.oncancel = () => {
            // (Re)assigned by a follow-up showHandleAt; clearing
            // here too is defensive.
            if (fadeInAnim?.playState === "idle") fadeInAnim = null;
          };
        }
      };

      /** If a top-level block is currently NodeSelected, return a
       *  BlockHit pointing at it. Used by hideHandle / update to pin
       *  the handle to the selected block so it persists for as long
       *  as the selection lives, instead of fading on pointer leave. */
      const nodeSelectionHit = (): BlockHit | null => {
        const sel = editorView.state.selection;
        if (!(sel instanceof NodeSelection)) return null;
        // Only pin for top-level blocks (depth 1 means the selection
        // is a direct child of doc - pinning to nested NodeSelections
        // would put the handle in the wrong gutter column).
        const $ = editorView.state.doc.resolve(sel.from);
        if ($.depth !== 0) return null;
        const node = editorView.state.doc.nodeAt(sel.from);
        const dom = editorView.nodeDOM(sel.from);
        if (!node || !(dom instanceof HTMLElement)) return null;
        return { pos: sel.from, node, dom };
      };

      const hideHandle = () => {
        if (dragState || pendingDrag?.armed) return;
        // Pin to the NodeSelection's block instead of hiding, so a
        // single click that selects a block leaves its handle visible
        // for re-click / modifier-extend gestures.
        const pinned = nodeSelectionHit();
        if (pinned) {
          currentHit = pinned;
          showHandleAt(pinned);
          return;
        }
        if (getSettings().handleVisibility === "always") {
          // In "always" mode, leave the handle on the last resolved
          // block - don't clear on pointer leave.
          return;
        }
        // Order matters: remove is-visible BEFORE cancelling the
        // fade-in. Sequence: removing the class lowers the CSS
        // opacity to 0 but WAAPI still overrides → no visible
        // change yet. Then cancelling WAAPI drops the override →
        // computed opacity changes from the WAAPI value to 0,
        // which the CSS opacity transition picks up and fades. If
        // we did this the other way around, cancel-first would
        // snap opacity to CSS's current value (1, while .is-visible
        // is still on) and produce a visible flash before the
        // fade-out begins.
        handle.classList.remove("is-visible");
        if (fadeInAnim) {
          fadeInAnim.cancel();
          fadeInAnim = null;
        }
        currentHit = null;
      };

      /**
       * Probe the block at the current pointer Y using a STABLE X
       * deep inside the content column. This makes hover tracking
       * work across the gap between the block content and the
       * gutter handle - otherwise moving toward the handle hits
       * neither and hover clears.
       */
      const updateHoverFromPointer = (clientX: number, clientY: number) => {
        if (dragState) return;
        // Repair the handle's host relationship eagerly on every
        // mousemove. On Obsidian's workspace restore the editor's
        // DOM lineage shifts AFTER plugin.view() ran; the handle can
        // end up orphaned or in a stale parent. Doing this here -
        // not just in showHandleAt - means the first mouse motion
        // post-reload re-attaches the handle before the hit lookup
        // runs, so the very first hover paints correctly.
        ensureHostCurrent();
        // While the context menu is open, allow hover to move the
        // handle to other blocks so the user can see drag-handle
        // affordances on neighbors and ctrl/shift+click them to
        // extend the multi-block selection. The menu stays anchored
        // to its original position; clicking another handle will
        // dismiss the menu via Obsidian's outside-mousedown handler
        // before our pointerdown processes the new click.

        // If pointer is already over the handle, keep current state
        // - otherwise the affordance disappears the instant the
        // user tries to click it.
        if (handle.classList.contains("is-visible")) {
          const h = handle.getBoundingClientRect();
          if (
            clientX >= h.left - 4 &&
            clientX <= h.right + 4 &&
            clientY >= h.top - 4 &&
            clientY <= h.bottom + 4
          ) {
            return;
          }
        }

        const edRect = editorView.dom.getBoundingClientRect();
        const inEditor =
          clientX >= edRect.left - 60 && // tolerate gutter region
          clientX <= edRect.right &&
          clientY >= edRect.top &&
          clientY <= edRect.bottom;
        if (!inEditor) {
          hideHandle();
          return;
        }

        // For the hover-handle, we only care which block's body
        // contains the pointer directly - not the gap zones that
        // drop-target resolution uses. Walk blocks and match rect.
        const hit = listTopLevelBlocks(editorView).find(
          (b) => clientY >= b.rect.top - 4 && clientY <= b.rect.bottom + 4,
        );
        if (!hit) {
          hideHandle();
          return;
        }
        if (
          currentHit &&
          currentHit.pos === hit.pos &&
          currentHit.dom === hit.dom
        ) {
          return;
        }
        currentHit = { pos: hit.pos, node: hit.node, dom: hit.dom };
        showHandleAt(currentHit);
      };

      const onDocMouseMove = (evt: MouseEvent) => {
        updateHoverFromPointer(evt.clientX, evt.clientY);
      };

      // Hover-tracking is desktop-only. On mobile the handle is hidden
      // and long-press initiates drags directly (see below).
      if (!Platform.isMobile) {
        activeDocument.addEventListener("mousemove", onDocMouseMove, { passive: true });
      }

      // ── Drag: pointerdown on handle ───────────────────────────

      const onHandlePointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        // Read-only license gate: editorView.editable is the boolean
        // computed from the editable prop callback. False during
        // unlicensed / expired / unknown license status - disable
        // drag-and-drop reorder to match the read-only contract.
        if (!editorView.editable) return;
        // If currentHit is null, it's likely because a context menu
        // just dismissed via Obsidian's outside-mousedown handler
        // and the menu's onHide cleared currentHit before THIS
        // pointerdown reached the bubble phase. Re-resolve from
        // the event coords so the click still processes - without
        // this, the multi-block extend gesture (click handle A to
        // open menu → ctrl+click handle B) was a no-op because
        // step B couldn't arm pendingDrag.
        if (!currentHit) {
          updateHoverFromPointer(e.clientX, e.clientY);
        }
        if (!currentHit) return;
        e.preventDefault();
        // Snapshot currentHit BEFORE dismissing the menu - the menu's
        // onHide handler clears currentHit (so the hover-handle can
        // re-resolve cleanly), which would otherwise race the
        // pendingDrag assignment below and arm a drag with block:null.
        const hitForDrag = currentHit;
        // If a menu is already open (likely from a prior click on
        // a different block), dismiss it before arming the new
        // click. Obsidian's Menu auto-dismisses on outside mousedown
        // too, but this fires earlier and keeps our `activeMenuBlock`
        // bookkeeping in sync.
        if (activeMenu) closeActiveMenu();
        pendingDrag = {
          startX: e.clientX,
          startY: e.clientY,
          block: hitForDrag,
          pointerId: e.pointerId,
          armed: true,
        };
        handle.classList.add("is-pressed");
        window.addEventListener("pointermove", onArmMove);
        window.addEventListener("pointerup", onArmUp);
      };

      const onArmMove = (e: PointerEvent) => {
        if (!pendingDrag || pendingDrag.pointerId !== e.pointerId) return;
        const dx = e.clientX - pendingDrag.startX;
        const dy = e.clientY - pendingDrag.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          const block = pendingDrag.block;
          const pointerId = pendingDrag.pointerId;
          window.removeEventListener("pointermove", onArmMove);
          window.removeEventListener("pointerup", onArmUp);
          pendingDrag = null;
          startDrag(e, block, pointerId);
        }
      };

      const onArmUp = (e: PointerEvent) => {
        // If we got here, the pointer went up without moving >4px
        // - that's a click, not a drag. Branch on modifiers /
        // double-click for multi-block selection; otherwise open the
        // context menu.
        const block = pendingDrag?.block;
        pendingDrag = null;
        handle.classList.remove("is-pressed");
        window.removeEventListener("pointermove", onArmMove);
        window.removeEventListener("pointerup", onArmUp);
        if (block && e.button === 0) {
          // Modifier and double-click multi-select gestures are
          // handled by multi-block-select.ts's document mousedown
          // listener (capture phase) - it dispatches the action and
          // calls stopImmediatePropagation so the handle's
          // pointerdown listener never even arms pendingDrag for
          // those clicks. So if we got here, it's a plain click.
          //
          // Branch on whether this block is part of an existing
          // multi-block selection:
          //   • In a multi-set with > 1 blocks AND this block IS in
          //     the set → open the GROUP menu (Copy / Cut / Duplicate
          //     / Delete operate on all selected blocks). Set is
          //     preserved.
          //   • Otherwise → clear the multi-set, open the SINGLE
          //     block menu (which sets NodeSelection on this block).
          const multi = getMultiBlockSelection(editorView.state);
          if (
            multi.positions.length > 1 &&
            multi.positions.includes(block.pos)
          ) {
            if (activeMenu) closeActiveMenu();
            activeMenuBlock = block;
            showHandleAt(block);
            const menu = openMultiBlockContextMenu(
              app,
              editorView,
              handle,
              block.pos,
              multi.positions,
              serializeNode,
            );
            activeMenu = menu;
            menu.onHide(() => {
              if (activeMenu === menu) {
                activeMenu = null;
                activeMenuBlock = null;
              }
            });
            return;
          }
          // List_item with nested children → auto-promote to a
          // subtree multi-select + open the GROUP menu so operations
          // (copy/cut/duplicate/delete) act on the whole subtree
          // without the user having to manually fan it out.
          if (block.node.type.name === "list_item") {
            const subtree = computeListSubtree(editorView.state, block.pos);
            if (subtree.length > 1) {
              dispatchMultiBlock(
                editorView.state,
                editorView.dispatch.bind(editorView),
                { kind: "set", positions: subtree, anchor: block.pos },
              );
              if (activeMenu) closeActiveMenu();
              activeMenuBlock = block;
              showHandleAt(block);
              const menu = openMultiBlockContextMenu(
                app,
                editorView,
                handle,
                block.pos,
                subtree,
                serializeNode,
              );
              activeMenu = menu;
              menu.onHide(() => {
                if (activeMenu === menu) {
                  activeMenu = null;
                  activeMenuBlock = null;
                }
              });
              return;
            }
          }
          dispatchMultiBlock(
            editorView.state,
            editorView.dispatch.bind(editorView),
            { kind: "clear" },
          );
          openMenuFor(e, block);
        }
      };

      /** Open the block context menu anchored at the given event
       *  position, pinned to the given block. Used by:
       *   • the right-click handler on the drag handle
       *   • action-row handlers in the menu itself (re-open after
       *     dismissal, etc.)
       *  Pulled out of the click path so plain click can be a pure
       *  selection action without menu side effects. */
      const openMenuFor = (e: MouseEvent | PointerEvent, block: BlockHit) => {
        if (activeMenu) closeActiveMenu();
        // Pin the handle to this block while the menu lives. The
        // hover system would otherwise un-pin it as soon as the
        // pointer drifts off the block - but the open menu is
        // anchored to the handle's position, so the handle has to
        // stay put.
        activeMenuBlock = block;
        showHandleAt(block);
        const menu = openBlockContextMenu(
          app, e, editorView, block, serializeNode,
        );
        activeMenu = menu;
        menu.onHide(() => {
          if (activeMenu === menu) {
            activeMenu = null;
            activeMenuBlock = null;
            handle.classList.remove("is-visible");
            currentHit = null;
            try {
              const sel = editorView.state.selection;
              if (sel instanceof NodeSelection) {
                editorView.dispatch(
                  editorView.state.tr.setSelection(
                    TextSelection.near(
                      editorView.state.doc.resolve(sel.from),
                    ),
                  ),
                );
              }
            } catch {
              /* doc shape changed mid-menu - let PM's selection
                 stand wherever it landed. */
            }
          }
        });
      };


      // Desktop: handle pointerdown arms click-or-drag on the gutter
      // handle. Mobile uses long-press on the block instead (below).
      if (!Platform.isMobile) {
        handle.addEventListener("pointerdown", onHandlePointerDown);
      }

      // ── Mobile: long-press on a block initiates drag ──────────
      //
      // No gutter handle on mobile - the user long-presses the block
      // body itself. Gated on the soft keyboard being away (proxy:
      // editor not focused) so the gesture doesn't fight Android's
      // text-selection long-press. If the user is typing, long-press
      // falls through to the platform's native selection gesture.
      const LONG_PRESS_MS = 500;
      const LONG_PRESS_MOVE_THRESHOLD = 8;
      let lpTimer: number | null = null;
      let lpBlock: BlockHit | null = null;
      let lpPointerId: number | null = null;
      let lpStart = { x: 0, y: 0 };
      let lpLast = { x: 0, y: 0 };
      const lpCancel = () => {
        if (lpTimer !== null) {
          window.clearTimeout(lpTimer);
          lpTimer = null;
        }
        lpBlock = null;
        lpPointerId = null;
      };
      const onMobilePointerDown = (e: PointerEvent) => {
        if (e.pointerType !== "touch") return;
        // If keyboard is up (editor focused) the user is typing
        // let native selection handle long-press.
        if (editorView.dom.contains(activeDocument.activeElement)) return;
        const blocks = listTopLevelBlocks(editorView);
        const hit = blocks.find(
          (b) => e.clientY >= b.rect.top - 4 && e.clientY <= b.rect.bottom + 4,
        );
        if (!hit) return;
        lpBlock = { pos: hit.pos, node: hit.node, dom: hit.dom };
        lpPointerId = e.pointerId;
        lpStart = { x: e.clientX, y: e.clientY };
        lpLast = { x: e.clientX, y: e.clientY };
        lpTimer = window.setTimeout(() => {
          lpTimer = null;
          const blk = lpBlock;
          const pid = lpPointerId;
          lpBlock = null;
          lpPointerId = null;
          if (!blk || pid === null) return;
          // Re-gate at fire time - if focus moved into the editor
          // (tap focused contenteditable), bail and let the platform
          // handle the gesture.
          if (editorView.dom.contains(activeDocument.activeElement)) return;
          // Synthesize a PointerEvent-shape with the latest known
          // coords - startDrag only reads clientX/clientY/pointerId.
          const synth = {
            clientX: lpLast.x,
            clientY: lpLast.y,
            pointerId: pid,
            preventDefault() {},
            stopPropagation() {},
          } as unknown as PointerEvent;
          // Haptic feedback for the drag-start moment, mirroring
          // native long-press affordance.
          try {
            (navigator as { vibrate?: (n: number) => void }).vibrate?.(15);
          } catch { /* not available */ }
          startDrag(synth, blk, pid);
        }, LONG_PRESS_MS);
      };
      const onMobilePointerMove = (e: PointerEvent) => {
        if (lpPointerId !== e.pointerId || lpTimer === null) return;
        lpLast = { x: e.clientX, y: e.clientY };
        const dx = e.clientX - lpStart.x;
        const dy = e.clientY - lpStart.y;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) lpCancel();
      };
      const onMobilePointerUp = (e: PointerEvent) => {
        if (lpPointerId !== e.pointerId) return;
        const wasArmed = lpTimer !== null;
        const dx = e.clientX - lpStart.x;
        const dy = e.clientY - lpStart.y;
        const wasTap = wasArmed && Math.hypot(dx, dy) <= LONG_PRESS_MOVE_THRESHOLD;
        const upX = lpLast.x;
        const upY = lpLast.y;
        lpCancel();
        // Tap with keyboard down: PM's `editable` prop is locked off
        // (see `installMobileToolbarBehavior` in main.ts). Flip it
        // back on, then focus + place cursor manually since the
        // browser's tap-to-focus didn't fire on the non-editable host.
        if (wasTap && !editorView.editable) {
          unlockMobileEditable();
          try {
            const posInfo = editorView.posAtCoords({ left: upX, top: upY });
            if (posInfo) {
              editorView.dispatch(
                editorView.state.tr.setSelection(
                  TextSelection.near(
                    editorView.state.doc.resolve(posInfo.pos),
                  ),
                ),
              );
            }
            editorView.focus();
          } catch { /* selection mapping failed - leave focus alone */ }
        }
      };
      if (Platform.isMobile) {
        editorView.dom.addEventListener("pointerdown", onMobilePointerDown, { passive: true });
        window.addEventListener("pointermove", onMobilePointerMove, { passive: true });
        window.addEventListener("pointerup", onMobilePointerUp, { passive: true });
        window.addEventListener("pointercancel", onMobilePointerUp, { passive: true });
      }

      // ── Drag: engine ──────────────────────────────────────────

      const startDrag = (e: PointerEvent, block: BlockHit, pointerId: number) => {
        // Dragging supersedes any open menu. Close OUR tracked menu
        // first (the block context menu we opened ourselves), then
        // also detach any stray `.menu` DOM elements so we cover
        // menus we don't track - Obsidian's native context menu,
        // other plugins' menus, hover-link previews, etc. They'd
        // otherwise float over the document mid-drag.
        if (activeMenu) closeActiveMenu();
        activeDocument.querySelectorAll<HTMLElement>(".menu").forEach((el) => {
          el.remove();
        });
        applyMotion();
        cachedScroller = scrollHost(editorView.dom) ?? host;
        cachedScrollerRect = cachedScroller.getBoundingClientRect();
        // Re-resolve the block's DOM at drag-start. `block.dom` was
        // captured at handle-show time; if the doc has since mutated
        // (block-type conversion via "Turn into", code-block edit-mode
        // toggle, image-resize re-render, etc.), the cached element
        // is detached and the visible block is a fresh DOM node. Using
        // the stale ref would leave the visible block uncollapsed and
        // produce a ghost cloned from the wrong shape. `nodeDOM(pos)`
        // returns the live element, falling back to the cached ref
        // only if the lookup fails (e.g., an exotic NodeView returned
        // a non-HTMLElement dom).
        const freshDom = editorView.nodeDOM(block.pos);
        if (freshDom instanceof HTMLElement && freshDom.isConnected) {
          block = { ...block, dom: freshDom, node: editorView.state.doc.nodeAt(block.pos) ?? block.node };
        }
        const cs = getComputedStyle(block.dom);
        const blockRect = block.dom.getBoundingClientRect();
        // Compute the drag GROUP - three sources, in priority order:
        //
        //   1. If the source is part of an active MULTI-BLOCK selection
        //      (>1 entry, source.pos is one of them), drag the whole
        //      set. The positions can be non-contiguous (ctrl-click
        //      toggle) - the commit logic handles that.
        //   2. Otherwise, if the source is a list_item, drag the
        //      list_item subtree (parent + nested children).
        //   3. Otherwise, drag just the source.
        //
        // The positions list feeds the source-decoration (one
        // opacity:0 per member), the block-cache filter (so members
        // can't be drop targets), and the commit's delete + insert.
        const multiSel = getMultiBlockSelection(editorView.state);
        const sourceInMulti =
          multiSel.positions.length > 1 &&
          multiSel.positions.includes(block.pos);
        let groupPositions: number[];
        if (sourceInMulti) {
          const sortedSel = [...multiSel.positions].sort((a, b) => a - b);
          // Pre-step: if the multi-block selection is non-contiguous,
          // consolidate the selected blocks into a single contiguous
          // run at the dragged block's position via moveBlocks. After
          // this, the rest of startDrag treats the group exactly like
          // a contiguous-subtree drag - same code path, smooth
          // bidirectional reflow, no scattered "left-behind" gaps.
          //
          // moveBlocks's math preserves the dragged block's pos: it
          // ends up at exactly block.pos, with predecessors just
          // before and successors just after. The consolidation is
          // committed to history, so Esc-cancel during the drag
          // leaves the consolidated form (Ctrl+Z restores the
          // original scattered layout).
          let isContiguous = true;
          for (let i = 1; i < sortedSel.length; i++) {
            const prevNode = editorView.state.doc.nodeAt(sortedSel[i - 1]);
            if (
              !prevNode ||
              sortedSel[i] !== sortedSel[i - 1] + prevNode.nodeSize
            ) {
              isContiguous = false;
              break;
            }
          }
          if (!isContiguous) {
            const items = sortedSel
              .map((p) => {
                const n = editorView.state.doc.nodeAt(p);
                return n ? { pos: p, node: n } : null;
              })
              .filter(
                (x): x is { pos: number; node: PMNode } => x !== null,
              );
            moveBlocks(editorView, items, block.pos);
            // Recompute groupPositions to the new contiguous run.
            const myIdx = items.findIndex((it) => it.pos === block.pos);
            let cursor = block.pos;
            for (let i = (myIdx >= 0 ? myIdx : 0) - 1; i >= 0; i--) {
              cursor -= items[i].node.nodeSize;
            }
            groupPositions = [];
            for (const it of items) {
              groupPositions.push(cursor);
              cursor += it.node.nodeSize;
            }
            // PM may have rebuilt the dragged block's NodeView during
            // the consolidation dispatch - re-resolve so the ghost
            // and rect math below see the live element.
            const freshDom = editorView.nodeDOM(block.pos);
            const freshNode = editorView.state.doc.nodeAt(block.pos);
            if (
              freshDom instanceof HTMLElement &&
              freshDom.isConnected &&
              freshNode
            ) {
              block = { ...block, dom: freshDom, node: freshNode };
            }
          } else {
            groupPositions = sortedSel;
          }
        } else {
          groupPositions = computeListSubtree(editorView.state, block.pos);
        }
        const groupNodes: PMNode[] = [];
        let groupTotalSize = 0;
        for (const p of groupPositions) {
          const n = editorView.state.doc.nodeAt(p);
          if (!n) continue;
          groupNodes.push(n);
          groupTotalSize += n.nodeSize;
        }
        // For contiguous groups this equals `block.pos + groupTotalSize`;
        // for non-contiguous (multi-block selection) we use the last
        // member's end so the "first block AFTER the group" search
        // doesn't accidentally pick up a non-selected sibling sitting
        // INSIDE the group's bounding span.
        const lastGroupPos = groupPositions[groupPositions.length - 1];
        const lastGroupNode = groupNodes[groupNodes.length - 1];
        const groupEndPos = lastGroupPos + (lastGroupNode?.nodeSize ?? 0);
        // Source's actual layout footprint - distance from source's
        // top to the FIRST block AFTER the whole group's top. For a
        // single-block drag this is the next sibling. For a list-
        // subtree drag this skips past every nested child so push
        // amounts and the placeholder size cover the full group's
        // height (otherwise dropped neighbors would sit on top of
        // children that are about to move with the parent).
        const allBlocks = listTopLevelBlocks(editorView);
        const afterGroupBlock = allBlocks.find((b) => b.pos >= groupEndPos);
        const footprintViaNext = afterGroupBlock
          ? afterGroupBlock.rect.top - blockRect.top
          : 0;
        // Naive fallback for single-block / contiguous-subtree drags:
        // sum each member's offsetHeight + own margins. Used only
        // when the group is at the very end of the doc (no following
        // block to measure against).
        let naiveFootprint =
          block.dom.offsetHeight +
          parseFloat(cs.marginTop || "0") +
          parseFloat(cs.marginBottom || "0");
        for (let i = 1; i < groupPositions.length; i++) {
          const dom = editorView.nodeDOM(groupPositions[i]);
          if (!(dom instanceof HTMLElement)) continue;
          const ds = getComputedStyle(dom);
          naiveFootprint +=
            dom.offsetHeight +
            parseFloat(ds.marginTop || "0") +
            parseFloat(ds.marginBottom || "0");
        }
        // For multi-block drag, actualFootprint = the SUM of every
        // selected member's offsetHeight, capped at the same
        // HUGE_BLOCK_MAX_HEIGHT_PX the ghost clips against. Push
        // amount + placeholder size are derived from this so the
        // drop-target gap matches the visible ghost.
        const explicitMultiSelect = sourceInMulti && groupPositions.length > 1;
        // Real vertical footprint of the selected stack = top-of-
        // first-member to top-of-block-after-last-member. This
        // captures margin-collapse between adjacent members instead
        // of summing offsetHeights (which excludes margins).
        let multiSumHeight = 0;
        if (explicitMultiSelect) {
          const firstPos = groupPositions[0];
          const lastEnd = groupPositions[groupPositions.length - 1] +
            (groupNodes[groupNodes.length - 1]?.nodeSize ?? 0);
          const firstDom = editorView.nodeDOM(firstPos);
          const allTopBlocks = listTopLevelBlocks(editorView);
          const afterLast = allTopBlocks.find((b) => b.pos >= lastEnd);
          if (firstDom instanceof HTMLElement && afterLast) {
            multiSumHeight =
              afterLast.rect.top - firstDom.getBoundingClientRect().top;
          } else if (firstDom instanceof HTMLElement) {
            // Last in doc - no after-block to measure against. Fall
            // back to summed offsetHeights.
            for (const p of groupPositions) {
              const d = editorView.nodeDOM(p);
              if (d instanceof HTMLElement) multiSumHeight += d.offsetHeight;
            }
          }
        }
        // For multi: actualFootprint = UNCAPPED sum (so the
        // post-collapse layout shift is modelled correctly in
        // getAdjustedBlocks's cssShift). The placeholder/push uses
        // pushAmount = capped sum (the visible drop-target gap).
        const actualFootprint = explicitMultiSelect
          ? multiSumHeight
          : (footprintViaNext > 0 ? footprintViaNext : naiveFootprint);
        const grabOffset = {
          x: e.clientX - blockRect.left,
          y: e.clientY - blockRect.top,
        };
        // For multi-block, treat as non-compact so no max-height
        // clamps happen on the source. Selected members remain at
        // their natural sizes (just opacity:0 from the decoration);
        // doc layout doesn't compress on drag start.
        const compact = !explicitMultiSelect &&
          actualFootprint > HUGE_BLOCK_MAX_HEIGHT_PX;
        // capContentHeight: chosen so capContentHeight + collapsed-
        // margin-to-next == HUGE. Makes the source's clamped
        // FOOTPRINT (border + content + bottom margin collapsed with
        // next) equal to HUGE - which is what push amounts and
        // placeholder size assume.
        const collapsedMarginToNext = Math.max(
          0,
          actualFootprint - block.dom.offsetHeight,
        );
        // Multi-block: every member collapses to 0. Doc compresses
        // by the full bbox. Placeholder appears at the drop target
        // showing the cap-sized stack preview.
        const capContentHeight = explicitMultiSelect
          ? 0
          : Math.max(0, HUGE_BLOCK_MAX_HEIGHT_PX - collapsedMarginToNext);
        // pushAmount = the actual post-shrink source area for
        // multi-tall, computed by summing each member's
        // min(naturalBox, HUGE/N) plus the boundary margin
        // between last member and after-last (which survives the
        // shrink because after-last's marginTop isn't animated).
        //
        // For mixed-height stacks where some members are
        // individually shorter than HUGE/N, those members don't
        // actually shrink - assuming they did (with pushAmount =
        // HUGE+boundary) made the filler bigger than the actual
        // gap, causing overlap with the block below.
        let boundaryMargin = 0;
        if (
          explicitMultiSelect &&
          actualFootprint > HUGE_BLOCK_MAX_HEIGHT_PX &&
          afterGroupBlock
        ) {
          const afterDom = editorView.nodeDOM(afterGroupBlock.pos);
          if (afterDom instanceof HTMLElement) {
            boundaryMargin = parseFloat(
              getComputedStyle(afterDom).marginTop || "0",
            ) || 0;
          }
        }
        let pushAmount: number;
        if (
          explicitMultiSelect &&
          actualFootprint > HUGE_BLOCK_MAX_HEIGHT_PX
        ) {
          const N = groupPositions.length;
          const perMemberCap = HUGE_BLOCK_MAX_HEIGHT_PX / N;
          let postShrinkTotal = 0;
          for (const p of groupPositions) {
            const dom = editorView.nodeDOM(p);
            if (dom instanceof HTMLElement) {
              postShrinkTotal += Math.min(dom.offsetHeight, perMemberCap);
            }
          }
          pushAmount = postShrinkTotal + boundaryMargin;
        } else {
          pushAmount = Math.min(actualFootprint, HUGE_BLOCK_MAX_HEIGHT_PX);
        }
        dragState = {
          source: block,
          actualFootprint,
          pushAmount,
          placeholderHeight: pushAmount,
          compact,
          capContentHeight,
          grabOffset,
          ghostHeight: 0, // set after buildGhost below
          dropInfo: null,
          cancelled: false,
          pointerId,
          group: {
            positions: groupPositions,
            nodes: groupNodes,
            totalSize: groupTotalSize,
            contiguous: (() => {
              for (let i = 1; i < groupPositions.length; i++) {
                const expected = groupPositions[i - 1] + groupNodes[i - 1].nodeSize;
                if (groupPositions[i] !== expected) return false;
              }
              return true;
            })(),
          },
          collapsedMemberStyles: [],
          collapsedAnimations: [],
        };

        // ── Depth-during-drag setup ──
        //
        // When the source is a `list_item`, the cursor's horizontal
        // position during the drag becomes the destination depth
        // (Notion-style nesting via drag). Tracking is ABSOLUTE: the
        // cursor's column over the editor's depth grid IS the depth.
        // Cursor over column 0 → depth 0; over column 1 → depth 1;
        // etc. So the user just hovers where they want the item to
        // land - no calibration, no dead zone, the placeholder is
        // always under the cursor's column.
        if (block.node.type.name === "list_item") {
          // Resolve `--list-indent` by writing a probe element with
          // `width: var(--list-indent)` and reading its rendered
          // width - handles `4ch`, `1em`, `16px`, etc. uniformly.
          const probe = activeDocument.createElement("div");
          probe.addClass("butter-list-indent-probe");
          editorView.dom.appendChild(probe);
          const indentPx = probe.getBoundingClientRect().width || 32;
          probe.remove();
          // Source's rect.left = editor content edge (column 0)
          // since flat list_items all share the editor's outer left
          // edge (no negative margin in the new layout).
          dragState.listDrag = {
            contentLeftX: blockRect.left,
            indentPx,
            sourceDepth: (block.node.attrs.depth as number) ?? 0,
          };
        }
        // Set the body's drag-active marker FIRST. Other plugins
        // (auto-split-images appendTransaction, etc.) check this
        // class to gate their own transaction handling - anything
        // dispatched between drag-start and drag-end could otherwise
        // mutate the doc and invalidate the cached block rects below.
        activeDocument.body.classList.add("butter-is-dragging");
        handle.classList.remove("is-visible", "is-pressed");

        // Prime the per-drag block cache so getAdjustedBlocks can
        // derive predicted positions from cached + push state.
        // Cache must be taken BEFORE the decoration dispatches
        // it captures pristine pre-collapse rects.
        buildBlockCache();

        // Apply source styling via a PM Decoration. The decoration
        // sets opacity:0 (and overflow:hidden in compact mode); the
        // actual max-height clamp is animated separately via WAAPI
        // on source.dom (next block) so the layout reflow on
        // neighbors below source eases in instead of snapping.
        editorView.dispatch(
          editorView.state.tr.setMeta(key, {
            sourcePos: block.pos,
            sourceSize: block.node.nodeSize,
            capHeight: compact ? capContentHeight : undefined,
            collapsed: explicitMultiSelect,
            groupPositions,
          }),
        );

        // Compact-mode entry animation: ease the source's max-height
        // from `actualOffsetHeight + slack` (effectively no clamp)
        // down to `capContentHeight` over PUSH_DURATION. Browsers
        // can't CSS-transition `none → length`; WAAPI accepts any
        // length pair. Layout-affecting properties animated via
        // WAAPI trigger CSS reflow each frame, so blocks below the
        // source smoothly slide UP as the source's box shrinks.
        // fill:forwards persists max-height: cap after the animation
        // ends so the slot stays clamped through the rest of the drag.
        if (compact) {
          const fromMax = block.dom.offsetHeight + 100;
          sourceCollapseAnim?.cancel();
          sourceCollapseAnim = block.dom.animate(
            [
              { maxHeight: `${fromMax}px` },
              { maxHeight: `${capContentHeight}px` },
            ],
            {
              duration: PUSH_DURATION,
              easing: "ease-out",
              fill: "forwards",
            },
          );
        }
        // Multi-block: collapse every selected member's slot via
        // WAAPI (max-height + margins + padding + border to 0).
        // Ghost shows the actual cloned content (just like long-
        // block) with a "# blocks" badge in the fade region when
        // the stack exceeds the cap.
        if (explicitMultiSelect && dragState) {
          // "Treat as long block" - every selected member gets
          // forced into compact-mode visual: overflow:hidden + max-
          // height clamp so its slot shrinks to ~cap, mirroring
          // what a tall single-block drag does to its source. Set
          // via inline `setProperty(..., 'important')` so the value
          // sits at the highest cascade level a stylesheet author
          // can reach.
          // Total visible footprint of the selected stack should
          // equal the placeholder size - like a long-block drag
          // shrinks the source's slot to the cap. The SOURCE block
          // becomes the placeholder-sized slot (height locked to
          // MULTI_BLOCK_PLACEHOLDER_PX); every other member is
          // removed from layout via display:none. Net: doc loses
          // (sum_of_selected_heights − placeholder) of vertical
          // space, leaving exactly one ghost-sized empty slot at
          // the source position.
          // Multi-block source-slot collapse: WAAPI animates each
          // group member's max-height from natural → 0 over
          // PUSH_DURATION. Same mechanism single tall blocks use in
          // compact mode (just on multiple doms). The decoration's
          // `overflow: hidden` (set when `collapsed` is true) clips
          // content during the shrink so it doesn't paint outside
          // the collapsing box. WAAPI doesn't write to the inline
          // style attribute, so PM's MutationObserver doesn't fire.
          // finishDrag cancels these on drag end so the moved blocks
          // render at their natural sizes.
          // Source-slot shrink for tall multi-stacks. Instant
          // (duration: 0) so cssShift in getAdjustedBlocks is
          // accurate from frame 0 - the previous animated version
          // caused mid-flight drift between predicted post-anim
          // positions and actual visual positions, leading to
          // filler/block overlap. Per-member max-height = HUGE/N,
          // margins/padding to 0; total post-shrink slot ≈ HUGE +
          // afterGroupMarginTop (the boundary margin that
          // collapsed-with after-last's marginTop survives).
          if (multiSumHeight > HUGE_BLOCK_MAX_HEIGHT_PX) {
            const N = groupPositions.length;
            const perMemberCap = HUGE_BLOCK_MAX_HEIGHT_PX / N;
            for (const p of groupPositions) {
              const dom = editorView.nodeDOM(p);
              if (!(dom instanceof HTMLElement)) continue;
              const cs = getComputedStyle(dom);
              const anim = dom.animate(
                [
                  {
                    maxHeight: `${perMemberCap}px`,
                    marginTop: "0px",
                    marginBottom: "0px",
                    paddingTop: "0px",
                    paddingBottom: "0px",
                  },
                ],
                {
                  duration: 0,
                  fill: "forwards",
                },
              );
              dragState.collapsedAnimations.push(anim);
              // Reference cs to keep TS quiet about the unused var
              // when duration is 0 (we don't animate from natural,
              // so cs would otherwise be dead).
              void cs;
            }
          }
        }
        // Resolve every group member's live DOM for the ghost.
        // For a single-block drag this is just [block.dom]. For a
        // list_item subtree the parent + each nested child gets
        // cloned. For multi-block, every selected member is cloned
        // and the ghost gets a "# blocks" badge in the fade region
        // when the stacked content exceeds the cap.
        const groupDoms: HTMLElement[] = [];
        for (const p of groupPositions) {
          const d = p === block.pos
            ? block.dom
            : editorView.nodeDOM(p);
          if (d instanceof HTMLElement) groupDoms.push(d);
        }
        const ghostDepthShift = block.node.type.name === "list_item"
          ? ((block.node.attrs.depth as number) ?? 0)
          : 0;
        ghost = buildGhost(block, blockRect, groupDoms, ghostDepthShift);
        if (explicitMultiSelect && ghost) {
          // Total stacked height - buildGhost only saw blockRect
          // (the grabbed source). Add `.is-clamped` when the FULL
          // stack exceeds the cap so the fade pseudo + "# blocks"
          // badge appear.
          let totalGhostHeight = 0;
          for (const d of groupDoms) totalGhostHeight += d.offsetHeight;
          if (totalGhostHeight > HUGE_BLOCK_MAX_HEIGHT_PX) {
            ghost.classList.add("is-clamped");
          }
          ghost.classList.add("butter-drag-ghost-multi");
          ghost.dataset.butterMultiCount = String(groupPositions.length);
          // CSS pseudo's attr() reads from the element it's attached
          // to (.butter-drag-ghost-inner), so duplicate the data on
          // the inner.
          const inner = ghost.querySelector<HTMLElement>(
            ".butter-drag-ghost-inner");
          if (inner) inner.dataset.butterMultiCount = String(groupPositions.length);
        }
        // Start with is-entering so the shadow is suppressed; remove
        // on the next frame so the CSS transition fires from zero to
        // full shadow - gives a "lift off the page" entrance.
        ghost.classList.add("is-entering");
        activeDocument.body.appendChild(ghost);
        positionGhost(e.clientX, e.clientY);
        // Capture the ghost's rendered height once for the
        // midpoint-trigger math in scheduleDropAnalysis. Reading
        // offsetHeight here forces a layout but only on the freshly
        // appended ghost - cheap, and avoids re-reading on every
        // pointermove.
        dragState.ghostHeight = ghost.offsetHeight;
        const enteringGhost = ghost;
        window.requestAnimationFrame(() => {
          enteringGhost.classList.remove("is-entering");
        });

        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragUp);
        window.addEventListener("keydown", onDragKey);
        // Mobile: while a drag is live, swallow native touch behavior
        // (scroll, selection, taps on other widgets). We position the
        // ghost via pointermove and run our own autoscroll, so the
        // browser's default touch handling is pure noise here.
        // Capture phase + non-passive so `preventDefault` is
        // effective before any other listener sees the event.
        if (Platform.isMobile) {
          window.addEventListener("touchmove", swallowTouchEvent, { passive: false, capture: true });
          window.addEventListener("touchstart", swallowTouchEvent, { passive: false, capture: true });
          window.addEventListener("touchend", swallowTouchEvent, { passive: false, capture: true });
        }
      };

      // Capture-phase touch swallower used during an active drag
      // see startDrag / finishDrag for lifecycle. preventDefault stops
      // the browser from scrolling, selecting text, or firing
      // synthetic mouse events; stopPropagation keeps the event from
      // reaching other plugin listeners while we own the gesture.
      const swallowTouchEvent = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };

      /** Build the drag ghost - a clone of the source block wrapped in
       *  the same editor-view / editor-root / ProseMirror class chain
       *  so Obsidian + PM styling land on it identically. Reflow's
       *  live-preview experience is the only drag style Butter ships,
       *  and the cloned-pickup ghost is what that uses. */
      const buildGhost = (
        block: BlockHit,
        blockRect: DOMRect,
        groupDoms: HTMLElement[] = [block.dom],
        depthShift: number = 0,
      ): HTMLElement => {
        const root = activeDocument.createElement("div");
        root.className = "butter-drag-ghost";
        const inner = activeDocument.createElement("div");
        inner.className = "butter-drag-ghost-inner";

        // Clone every group member so the ghost visually carries the
        // whole subtree (parent + nested children for list_item drags).
        // For non-list drags `groupDoms` is just `[block.dom]`, so this
        // collapses to the original single-clone behavior.
        const clones: HTMLElement[] = groupDoms.map((dom, i) => {
          const c = dom.cloneNode(true) as HTMLElement;
          c.removeAttribute("contenteditable");
          // Strip the inline style properties our decoration set
          // (opacity:0 / max-height / overflow / transition) so the
          // ghost - which is supposed to be fully visible at the
          // cursor - doesn't inherit the source's hidden styling. Use
          // removeProperty rather than clearing the whole `style`
          // attribute so any unrelated inline styles the original
          // carried (theme overrides, PM resize, etc.) survive.
          c.style.removeProperty("opacity");
          c.style.removeProperty("max-height");
          c.style.removeProperty("overflow");
          c.style.removeProperty("transition");
          c.querySelectorAll("*").forEach((el) => {
            (el as HTMLElement).removeAttribute("contenteditable");
            (el as HTMLElement).addClass("butter-drag-clone-no-pointer");
          });
          // Strip outer margins on the FIRST clone so its border-box
          // sits flush against the ghost wrapper's top-left (where the
          // grab-offset math targets). Inner clones keep their natural
          // top margin so spacing between subtree members survives.
          if (i === 0) c.addClass("butter-drag-clone-first");
          if (i === groupDoms.length - 1) c.addClass("butter-drag-clone-last");
          // Shift each clone's `data-depth` down by the source's own
          // depth so the ghost renders with source at depth 0 and
          // children at their RELATIVE depth - drops the phantom
          // parent-nest indent that the original DOM was carrying.
          if (depthShift > 0) {
            const cur = parseInt(c.getAttribute("data-depth") || "0", 10);
            const shifted = Math.max(0, cur - depthShift);
            c.setAttribute("data-depth", String(shifted));
          }
          return c;
        });
        // Every ghost uses the block's column width so the visible
        // card size is consistent across all block types. Earlier we
        // tried shrinking self-framed blocks to their content width
        // (so a narrow image didn't get a wide empty card) - but
        // that made drag visuals feel inconsistent in practice
        // (blocks "jumped" to a smaller width when picked up). Full
        // column width everywhere reads more predictable.
        //
        // Rect captured by startDrag BEFORE any class additions
        // dirtied layout - re-reading here would force a full-doc
        // layout recompute (~85ms on a 5000-line doc).
        inner.style.width = `${blockRect.width}px`;

        // Pass the source block's computed border-radius through to
        // the ghost as a CSS variable. The ghost ring (::after on
        // .butter-drag-ghost) and inner card both consume
        // --butter-ghost-radius, so the ghost visually matches the
        // source block's corner shape regardless of theme
        // dragging a callout themed at 12px gets a 12px ghost,
        // dragging a code block themed at 2px gets a 2px ghost.
        //
        // Per-corner read (NOT the `borderRadius` shorthand): in
        // Chromium, `getComputedStyle(el).borderRadius` returns an
        // empty string when corners differ (e.g. blockquote with
        // squared left + rounded right corners), which silently
        // dropped the ghost back to the symmetric default and made
        // the ghost ring not match the selection ring. Reading each
        // corner separately and rebuilding the four-value shorthand
        // works for both symmetric and asymmetric blocks.
        // Read BEFORE we mutate anything on the clone so we capture
        // the original block's radius, not a descendant's.
        try {
          const cs = window.getComputedStyle(block.dom);
          const tl = cs.borderTopLeftRadius || "0px";
          const tr = cs.borderTopRightRadius || "0px";
          const br = cs.borderBottomRightRadius || "0px";
          const bl = cs.borderBottomLeftRadius || "0px";
          const sourceRadius = `${tl} ${tr} ${br} ${bl}`;
          root.style.setProperty("--butter-ghost-radius", sourceRadius);
        } catch {
          // getComputedStyle can throw on detached elements; fall
          // back to the CSS-default chain.
        }

        // Mark ghosts whose content will be clipped by the 360px
        // max-height cap so the fade-to-background pseudo at the
        // bottom (see .butter-drag-ghost.is-clamped rule in CSS) only
        // shows when there's actually hidden content below the cut.
        // Without this, short blocks (HR, single paragraph, image)
        // got a phantom fade over their visible bottom edge.
        if (blockRect.height > HUGE_BLOCK_MAX_HEIGHT_PX) {
          root.classList.add("is-clamped");
        }

        // Replicate the editor's class chain around the clone so the
        // PM + Obsidian CSS cascades match what the block had in
        // place. Without this the clone sits under body's unscoped
        // styles and looks different from the source (wrong
        // line-height, padding, inline-element styling, etc.). Each
        // wrapper gets its own box-model zeroed so classes that add
        // padding (.butter-editor-view has file-margins), max-width
        // (.butter-editor-root), or scroll overflow don't offset the
        // clone from the ghost wrapper's origin.
        const resetBox = (el: HTMLElement) => {
          // `!important` is required - the wrapper classes
          // (`.butter-editor-view { padding: var(--file-margins)
          // !important }`, etc.) themselves use !important, so
          // non-important inline styles can't override them.
          const s = el.style;
          s.setProperty("padding", "0", "important");
          s.setProperty("margin", "0", "important");
          s.setProperty("max-width", "none", "important");
          s.setProperty("min-width", "0", "important");
          s.setProperty("max-height", "none", "important");
          s.setProperty("min-height", "0", "important");
          s.setProperty("height", "auto", "important");
          s.setProperty("width", "100%", "important");
          s.setProperty("overflow", "visible", "important");
          s.setProperty("background", "transparent", "important");
          s.setProperty("border", "none", "important");
          s.setProperty("box-shadow", "none", "important");
          s.setProperty("display", "block", "important");
        };
        const viewWrap = activeDocument.createElement("div");
        viewWrap.className = "butter-editor-view";
        resetBox(viewWrap);
        const rootWrap = activeDocument.createElement("div");
        rootWrap.className = "butter-editor-root";
        resetBox(rootWrap);
        const pmWrap = activeDocument.createElement("div");
        pmWrap.className = "ProseMirror";
        resetBox(pmWrap);

        // Mirror whatever Reading-mode compat classes the live PM
        // element currently has so theme CSS scoped to those classes
        // (via the experimental theme compat flag) cascades into the
        // ghost too. Without this, turning on the flag styled in-
        // editor blocks correctly but ghosts rendered with Butter's
        // defaults - a visual mismatch at drag time.
        for (const c of ["markdown-rendered", "markdown-preview-view"]) {
          if (editorView.dom.classList.contains(c)) {
            pmWrap.classList.add(c);
          }
        }

        // Append every group member's clone in document order so the
        // ghost reads as the subtree the user is grabbing. Outer
        // margins on the first/last clones were already stripped in
        // the per-clone loop above.
        for (const c of clones) pmWrap.appendChild(c);
        rootWrap.appendChild(pmWrap);
        viewWrap.appendChild(rootWrap);
        inner.appendChild(viewWrap);

        root.appendChild(inner);
        return root;
      };

      // Ghost's inner wrapper has padding (see styles.css) - the
      // positioning math subtracts these so the clone's content box,
      // not the ghost's outer padding edge, lines up with where the
      // source block was. Keep in sync with the CSS padding values
      // for `.butter-drag-ghost .butter-drag-ghost-inner`.
      /** Source blocks taller than this switch to compact mode:
       *  the source's layout slot shrinks to this cap during drag
       *  (instead of staying at full size), so its vacated space is
       *  tight rather than a screen-filling void. The value matches
       *  `.butter-drag-ghost` max-height in styles.css, so the
       *  collapsed source slot, the ghost, and the drop placeholder
       *  all read at the same scale - no visual jump between "what
       *  you're dragging" and "where it will land." On drop, the
       *  source's max-height animates back to full at the new
       *  position, and siblings below it reflow down into place. */
      const HUGE_BLOCK_MAX_HEIGHT_PX = 360;

      const positionGhost = (x: number, y: number) => {
        if (!ghost || !dragState) return;
        const { x: ox, y: oy } = dragState.grabOffset;
        // Ghost's inner wrapper has zero padding now (see styles.css
        // comment on .butter-drag-ghost-inner), so the clone's
        // content-box is flush with the ghost's outer edge and no
        // cursor-offset compensation is needed. Simply honor the
        // grab offset (where the pointer was relative to the source
        // block's top-left at drag start) so the ghost tracks
        // continuously from that spot.
        ghost.style.transform = `translate(${x - ox}px, ${y - oy}px)`;
      };

      let pendingGhostRaf: number | null = null;
      let lastPointerX = 0;
      let lastPointerY = 0;

      const onDragMove = (e: PointerEvent) => {
        if (!dragState) return;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        if (pendingGhostRaf == null) {
          pendingGhostRaf = window.requestAnimationFrame(() => {
            pendingGhostRaf = null;
            positionGhost(lastPointerX, lastPointerY);
          });
        }
        scheduleDropAnalysis(e.clientX, e.clientY);
        updateAutoscroll(e.clientY);
      };

      let lastAnalyzedY = Number.NEGATIVE_INFINITY;

      /** Zone cache - on large docs the full block scan is the bulk
       *  of per-frame drag cost (N getBoundingClientRects for a
       *  potentially 300+ block doc). While the cursor stays within
       *  the previously-resolved zone AND within the same
       *  before/after half of the target, nothing about the drop
       *  state could have changed; we skip the full rescan. On zone
       *  change (cursor crosses a zone boundary) or scroll, the
       *  cache is invalidated and we do a fresh scan. */
      let cachedZone: {
        upperBound: number;
        lowerBound: number;
        targetMid: number;
        res: DropResolution;
        scrollTop: number;
      } | null = null;

      const getScrollTop = () => {
        const scroller =
          cachedScroller ?? scrollHost(editorView.dom) ?? host;
        return scroller.scrollTop;
      };

      /** Per-drag block cache. Populated once at drag start (before
       *  source collapse starts - so rects are pristine baseline),
       *  then reused for every scheduleDropAnalysis rescan. Saves a
       *  full `listTopLevelBlocks` → N × getBoundingClientRect pass
       *  per zone-miss, which on a 10k-line doc (~500 top-level
       *  blocks) was ~500 layout-triggering gBCR calls per rescan
       *  and the dominant cost of drag sluggishness.
       *
       *  The cached rects are the drag-start layout, so any live
       *  visual rect during the drag = cachedRect
       *    − scrollDelta (autoscroll or user scroll)
       *    + collapseShift (if block.pos is after source.pos and the
       *      source's compact-mode height animation has progressed)
       *    + pushShift    (if block is in `pushedByEl`)
       *  `getAdjustedBlocks` computes that and returns a fresh array
       *  with synthetic DOMRects ready for findDropTarget / showReflow
       *  to consume exactly like the old gBCR-based rects.
       *
       *  Trade-off: during transitions - source collapse (first
       *  ≈140ms of a compact drag) and push animations (≈240ms per
       *  target change) - the live visual rect doesn't exactly match
       *  what the adjusted rect says, because WAAPI's CSS easing
       *  curve isn't exactly reproduced by our approximation. Error
       *  is at most a few pixels for short transients and doesn't
       *  linger, so drop-target resolution stays correct in the
       *  steady state (which is where users hover + decide). */
      let blockCache: {
        blocks: BlockEntry[];
        /** Pre-allocated buffer reused by `getAdjustedBlocks`
         *  N entries with their own BlockRect. Saves N×rect + N×entry
         *  object creations per pointermove. Caller must consume
         *  results synchronously; the buffer is mutated on every
         *  call. */
        adjustedBuffer: BlockEntry[];
        baselineScrollTop: number;
        sourcePos: number;
      } | null = null;

      const buildBlockCache = () => {
        if (!dragState) return;
        const sourcePos = dragState.source.pos;
        // Exclude every group member from the candidate set - for a
        // list_item parent drag, that's parent + all nested children.
        // Otherwise the user could drop the parent on top of one of
        // its own children (which would either move it nowhere, or
        // create an impossible nesting).
        const groupSet = new Set(dragState.group.positions);
        const raw = listTopLevelBlocks(editorView).filter(
          (b) => !groupSet.has(b.pos),
        );
        const adjustedBuffer: BlockEntry[] = [];
        for (let i = 0; i < raw.length; i++) {
          adjustedBuffer.push({
            pos: 0,
            node: raw[i].node,
            dom: raw[i].dom,
            rect: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
          });
        }
        blockCache = {
          blocks: raw,
          adjustedBuffer,
          baselineScrollTop: getScrollTop(),
          sourcePos,
        };
      };

      const getAdjustedBlocks = (): BlockEntry[] => {
        if (!dragState) return [];
        if (!blockCache) buildBlockCache();
        if (!blockCache) return [];
        const scrollDelta = getScrollTop() - blockCache.baselineScrollTop;
        // In compact mode the decoration's max-height clamp causes
        // CSS to reflow blocks below source UP by `cssShift`. That
        // shift is real - visible to the user - but it's not in the
        // cached rect (which was captured pristine before the dispatch).
        // Add it here so drop-target detection + placeholder
        // positioning use accurate visual positions.
        // Multi-block: every member fully collapses, so blocks past
        // the LAST group member shift up by the full uncapped sum
        // - captured ONCE at startDrag in `dragState.actualFootprint`
        // so it doesn't drift as WAAPI animates dom.offsetHeight
        // toward 0 (which would make cssShift a moving target and
        // cause jittery reflow).
        const isMulti = dragState.group.positions.length > 1;
        let lastGroupEndPos = 0;
        if (isMulti) {
          const positions = dragState.group.positions;
          const nodes = dragState.group.nodes;
          lastGroupEndPos = positions[positions.length - 1] +
            (nodes[nodes.length - 1]?.nodeSize ?? 0);
        }
        // cssShift = how much blocks past the source-end visually
        // shift UP due to the source-side shrink. Single compact
        // and multi-tall both shrink the source area; the formula
        // (actualFootprint − pushAmount) gives the natural-CSS-
        // reflow amount in both cases.
        const cssShift =
          dragState.actualFootprint > dragState.pushAmount
            ? dragState.actualFootprint - dragState.pushAmount
            : 0;
        const sourcePos = blockCache.sourcePos;
        const cssShiftBoundary = isMulti ? lastGroupEndPos : sourcePos;
        const cached = blockCache.blocks;
        const out = blockCache.adjustedBuffer;
        for (let i = 0; i < cached.length; i++) {
          const b = cached[i];
          let topShift = -scrollDelta;
          if (cssShift && b.pos >= cssShiftBoundary) topShift -= cssShift;
          const pushState = pushedByEl.get(b.dom);
          if (pushState) topShift += pushState.shift;
          const newTop = b.rect.top + topShift;
          const slot = out[i];
          slot.pos = b.pos;
          slot.node = b.node;
          slot.dom = b.dom;
          const r = slot.rect;
          r.top = newTop;
          r.bottom = newTop + b.rect.height;
          r.left = b.rect.left;
          r.right = b.rect.right;
          r.width = b.rect.width;
          r.height = b.rect.height;
        }
        return out;
      };

      const scheduleDropAnalysis = (x: number, y: number) => {
        if (rafHandle != null) return;
        const dy = y - lastAnalyzedY;
        if (Math.abs(dy) < 3) return;
        lastAnalyzedY = y;
        // Direction-aware trigger:
        //   • Moving DOWN  → trigger at ghost midpoint (anchors the
        //     drop to the center of what the user is carrying).
        //   • Moving UP    → trigger at cursor tip (matches the
        //     intuition that you're reaching toward a target above).
        // First analysis defaults to "moving down" (dy = +∞ vs the
        // -∞ sentinel) so initial-grab behavior matches the
        // midpoint-trigger flow.
        const movingDown = dy > 0;
        rafHandle = window.requestAnimationFrame(() => {
          rafHandle = null;
          if (!dragState) return;

          const triggerY = movingDown
            ? y + (dragState.ghostHeight / 2 - dragState.grabOffset.y)
            : y;

          // Compute the destination depth from cursor X and clamp
          // it to a markdown-valid value (depth N requires a prev
          // sibling at depth >= N-1). Used by both the fast path
          // below and the full-scan path further down - keep them
          // identically clamped so the in-memory state can never
          // exceed what the markdown serializer can represent.
          const computeDepth = (
            xCoord: number,
            res: DropResolution,
          ): number | undefined => {
            if (!dragState!.listDrag) return undefined;
            const { contentLeftX, indentPx } = dragState!.listDrag;
            const rawDepth = Math.max(
              0,
              Math.floor((xCoord - contentLeftX) / indentPx),
            );
            // Walk back through doc top-level children to find the
            // last list_item before the drop position (skipping the
            // source itself). Its depth + 1 is the max allowed.
            const dropPos =
              res.where === "before"
                ? res.hit.pos
                : res.hit.pos + res.hit.node.nodeSize;
            const $clamp = editorView.state.doc.resolve(
              Math.max(
                0,
                Math.min(dropPos, editorView.state.doc.content.size),
              ),
            );
            const docNode = editorView.state.doc;
            const idx = $clamp.index(0);
            // Skip every GROUP member (parent + all nested children),
            // not just the parent - those children are moving with us
            // and can't act as the new prev-sibling.
            const groupIdxSet = new Set<number>();
            for (const p of dragState!.group.positions) {
              groupIdxSet.add(docNode.resolve(p).index(0));
            }
            let prevDepth = -1;
            for (let i = idx - 1; i >= 0; i--) {
              const child = docNode.child(i);
              if (child.type.name === "list_item" && !groupIdxSet.has(i)) {
                prevDepth = (child.attrs.depth as number) ?? 0;
                break;
              }
              if (child.type.name !== "list_item" && !groupIdxSet.has(i)) break;
            }
            const maxDepth = prevDepth >= 0 ? prevDepth + 1 : 0;
            return Math.min(rawDepth, maxDepth);
          };

          // Fast path - cursor still in the previously-resolved
          // zone, scroll unchanged. Skip the O(N) block scan and
          // all its getBoundingClientRect calls. For stable
          // hovering on big docs this is the difference between a
          // smooth drag and a sluggish one.
          //
          // EXCEPTION for list_item drags: depth tracks cursor X.
          // Even with no Y change we need to recompute depth +
          // re-position the placeholder horizontally on every
          // pointermove. Recompute depth (clamped) and update the
          // preview INLINE here so we keep the fast-path
          // performance for the Y-axis work but still get smooth
          // horizontal-drag depth feedback.
          const currentScroll = getScrollTop();
          if (
            cachedZone &&
            cachedZone.scrollTop === currentScroll &&
            triggerY >= cachedZone.upperBound &&
            triggerY < cachedZone.lowerBound
          ) {
            const expectedWhere = triggerY < cachedZone.targetMid ? "before" : "after";
            if (expectedWhere === cachedZone.res.where) {
              // Same vertical zone. Update depth (if applicable)
              // and re-position the placeholder, then bail.
              if (dragState.listDrag && dragState.dropInfo) {
                const newDepth = computeDepth(x, cachedZone.res);
                if (
                  newDepth !== undefined &&
                  newDepth !== dragState.dropInfo.depth
                ) {
                  dragState.dropInfo.depth = newDepth;
                  showDropIndicator(cachedZone.res, getAdjustedBlocks());
                }
              }
              return;
            }
            // Same zone but pointer crossed the block's mid - fall
            // through to full scan so the preview's `where` + gapY
            // get recomputed correctly.
          }

          const sourcePos = dragState.source.pos;
          // Use the WHOLE group's total size for no-op detection so a
          // drop inside the parent's nested-children range counts as
          // "dropping back at origin", not as a real move.
          const sourceSize = dragState.group.totalSize;
          const blocks = getAdjustedBlocks();
          const res = findDropTarget(blocks, triggerY);
          if (!res) {
            cachedZone = null;
            dragState.dropInfo = null;
            hideDropIndicator();
            return;
          }

          // Detect no-op drops (target position equals source's own
          // start or end). Matters especially in compact mode where
          // source is height-collapsed and the block immediately
          // after source visually fills source's former slot. We
          // still SHOW the placeholder when the cursor is over the
          // source's own slot - visual continuity feels better than
          // an indicator that flickers off when you drag back to
          // origin. We just clear `dropInfo` so onDragUp doesn't
          // attempt a self-drop (which moveBlock would reject anyway,
          // but skipping it keeps the path clean).
          const noOpTargetPos =
            res.where === "before"
              ? res.hit.pos
              : res.hit.pos + res.hit.node.nodeSize;
          const isNoOpDrop =
            noOpTargetPos >= sourcePos &&
            noOpTargetPos <= sourcePos + sourceSize;

          const blk = blocks[res.targetIdx];
          const prevBottom =
            res.targetIdx > 0
              ? blocks[res.targetIdx - 1].rect.bottom
              : blk.rect.top - 9999;
          const nextTop =
            res.targetIdx < blocks.length - 1
              ? blocks[res.targetIdx + 1].rect.top
              : blk.rect.bottom + 9999;
          cachedZone = {
            upperBound: (prevBottom + blk.rect.top) / 2,
            lowerBound: (blk.rect.bottom + nextTop) / 2,
            targetMid: (blk.rect.top + blk.rect.bottom) / 2,
            res,
            scrollTop: currentScroll,
          };

          // Depth-during-drag: clamped to `[0, prev_sibling_depth +
          // 1]` so the committed depth is always round-trip-valid
          // markdown. Uses the same `computeDepth` helper as the
          // fast path above for consistency.
          const depth = computeDepth(x, res);

          // Keep `dropInfo` populated even when isNoOpDrop is true,
          // IF there's a pending depth change for a list_item drag.
          // Otherwise on drop the depth-only-change branch in
          // onDragUp wouldn't run (it requires a non-null dropInfo).
          // For non-list-item drags or when depth matches the
          // source, isNoOpDrop still nulls out dropInfo so we don't
          // attempt a useless self-positional-move on commit.
          const sourceItemDepth =
            dragState.source.node.type.name === "list_item"
              ? (dragState.source.node.attrs.depth as number)
              : null;
          const wantsDepthCommit =
            sourceItemDepth !== null &&
            depth !== undefined &&
            depth !== sourceItemDepth;
          dragState.dropInfo =
            isNoOpDrop && !wantsDepthCommit
              ? null
              : { hit: res.hit, where: res.where, depth };
          showDropIndicator(res, blocks);
        });
      };

      /** Live-reflow drop preview: the only drag indicator Butter
       *  ships. Delegates entirely to showReflow, which collapses
       *  the source, shifts neighbors via transforms, and places a
       *  placeholder at the drop point. */
      const showDropIndicator = (
        res: DropResolution,
        blocks: BlockEntry[],
      ) => {
        showReflow(res.hit, res.where, blocks, res.targetIdx);
      };

      const hideDropIndicator = () => {
        clearReflow();
      };

      /**
       * Live reflow: collapse the source's slot and shift the target
       * (and everything after it, in doc order) down by sourceHeight
       * via `transform: translateY`. Real blocks move - the browser
       * composits the transforms - so it looks and feels exactly
       * like the block has been slotted in at the drop point. A
       * placeholder positioned in `host` fills the opened gap.
       *
       * Transforms are composited by the GPU and don't affect layout
       * (getBoundingClientRect DOES include transforms visually,
       * which is what we want when placing the placeholder). PM
       * doesn't serialize or rewrite transform inline styles, so we
       * stay safely outside its state-sync logic.
       */
      const showReflow = (
        hit: BlockHit,
        where: "before" | "after",
        blocks: BlockEntry[],
        targetIdx: number,
      ) => {
        if (!dragState) return;

        if (
          reflowState &&
          reflowState.hitPos === hit.pos &&
          reflowState.where === where
        ) {
          positionReflowPlaceholder(hit, where, blocks, targetIdx);
          return;
        }

        // Non-contiguous multi-block (Ctrl-click selection): source
        // slots are scattered through the doc, so the bidirectional-
        // push model below (single source range → one gap moves
        // from source to target) doesn't apply. Instead, every
        // selected source's slot stays reserved (opacity:0 from the
        // decoration), and we push blocks at >= targetPos DOWN by
        // placeholderHeight to open the drop slot. Sum-of-source-
        // heights = placeholderHeight, so the gap is sized for what
        // will land there.
        //
        // We do NOT remove sources from layout via display:none
        // (the previous "negative-gravity" attempt did, and it
        // caused a doc-emptying bug under file-switch save flush).
        // Reserved-source-slots is a small visual cost - three
        // dimmed slots scattered + one new gap at target - but it's
        // safe and the ghost makes the intent clear.
        if (!dragState.group.contiguous) {
          const placeholderHeight = dragState.placeholderHeight;
          const multiTargetPos = where === "before"
            ? hit.pos
            : hit.pos + hit.node.nodeSize;
          const multiPushDelta = placeholderHeight;
          const shouldBePushedSet = new Set<HTMLElement>();
          for (const b of blocks) {
            if (b.pos >= multiTargetPos) shouldBePushedSet.add(b.dom);
          }

          const nextPushed = new Map<
            HTMLElement,
            { anim: Animation; shift: number; pos: number }
          >();
          for (const [el, state] of pushedByEl) {
            const target = shouldBePushedSet.has(el) ? multiPushDelta : 0;
            if (state.shift === target) {
              nextPushed.set(el, state);
              shouldBePushedSet.delete(el);
              continue;
            }
            state.anim.cancel();
            for (const a of el.getAnimations()) a.cancel();
            const anim = el.animate(
              [
                { transform: `translateY(${state.shift}px)` },
                { transform: `translateY(${target}px)` },
              ],
              { duration: PUSH_DURATION, easing: PUSH_EASING, fill: "forwards" },
            );
            if (target !== 0) nextPushed.set(el, { anim, shift: target, pos: state.pos });
            shouldBePushedSet.delete(el);
          }
          for (const el of shouldBePushedSet) {
            const blockEntry = blocks.find((b) => b.dom === el);
            if (!blockEntry) continue;
            for (const a of el.getAnimations()) a.cancel();
            const anim = el.animate(
              [{ transform: "translateY(0)" }, { transform: `translateY(${multiPushDelta}px)` }],
              { duration: PUSH_DURATION, easing: PUSH_EASING, fill: "forwards" },
            );
            nextPushed.set(el, { anim, shift: multiPushDelta, pos: blockEntry.pos });
          }
          pushedByEl = nextPushed;

          if (!reflowPlaceholder) {
            const ph = activeDocument.createElement("div");
            ph.className = "butter-drag-reflow-placeholder";
            ph.style.height = `${placeholderHeight}px`;
            host.appendChild(ph);
            reflowPlaceholder = ph;
          } else {
            reflowPlaceholder.style.height = `${placeholderHeight}px`;
          }
          reflowState = { hitPos: hit.pos, where };
          window.requestAnimationFrame(() =>
            positionReflowPlaceholder(hit, where, blocks, targetIdx),
          );
          return;
        }

        const pushAmount = dragState.pushAmount;

        // Per-block target translateY:
        //   target = ±pushAmount  (if in the shift set)
        //   target = 0             (otherwise)
        // The shift set is the contiguous range of blocks that must
        // visibly slide to close source's slot OR open the drop gap.
        // Direction is inferred from sourceBefore (drag-down = source
        // above target = shift-set goes UP by -pushAmount; drag-up =
        // source below target = shift-set goes DOWN by +pushAmount).
        //
        // pushAmount = HUGE_BLOCK_MAX_HEIGHT_PX in compact mode, full
        // source footprint otherwise. The decoration's max-height
        // clamp makes source's slot visually = pushAmount in compact
        // mode, so push amounts + source slot + placeholder all agree.
        const sourcePos = dragState.source.pos;
        const targetPos = hit.pos;
        const sourceBefore = sourcePos < targetPos;
        const pushDelta = sourceBefore ? -pushAmount : pushAmount;

        // Only push blocks within the visible viewport (plus a
        // generous margin for autoscroll smoothness). Using the
        // scroll CONTAINER's rect here - `editorView.dom` is the
        // PM content element, which spans the full doc height,
        // so its rect "viewport" ended up including all ~1500
        // blocks. The actual scrolling ancestor is the true
        // viewport.
        const scroller = scrollHost(editorView.dom) ?? host;
        const viewportRect = scroller.getBoundingClientRect();
        const marginPx = 400;
        const minTop = viewportRect.top - marginPx;
        const maxBottom = viewportRect.bottom + marginPx;

        // Binary-search to the first in-viewport block. Blocks are in
        // doc order ≈ vertical order, and the existing loop just
        // `continue`s on every above-viewport entry - skipping that
        // prefix outright saves ~N pre-viewport rect-bottom checks per
        // pointermove on long docs scrolled into the middle. The
        // shift-set predicates below are pos-based and orthogonal to
        // viewport position, so they remain correct after the jump
        // (any block we'd have skipped via viewport `continue` is
        // simply not iterated).
        let viewportStart = blocks.length;
        {
          let lo = 0;
          let hi = blocks.length - 1;
          while (lo <= hi) {
            const m = (lo + hi) >>> 1;
            if (blocks[m].rect.bottom < minTop) {
              lo = m + 1;
            } else {
              viewportStart = m;
              hi = m - 1;
            }
          }
        }
        const shouldBePushed = new Set<HTMLElement>();
        for (let i = viewportStart; i < blocks.length; i++) {
          const b = blocks[i];
          const p = b.pos;
          if (sourceBefore) {
            if (p <= sourcePos) continue;
            if (where === "before") {
              if (p >= targetPos) break;
            } else {
              if (p > targetPos) break;
            }
          } else {
            if (p >= sourcePos) break;
            if (where === "before") {
              if (p < targetPos) continue;
            } else {
              if (p <= targetPos) continue;
            }
          }
          if (b.rect.top > maxBottom) break;
          shouldBePushed.add(b.dom);
        }

        // Diff against currently pushed set via WAAPI. We tried CSS
        // transitions here, but transform-via-class gets silently
        // overridden somewhere in the PM / Obsidian layer (same
        // issue that pushed us to WAAPI in the first place).
        // Animations via `element.animate()` sit above all CSS in
        // the cascade and always take effect. With the viewport
        // filter, the push set is ~20-40 blocks - cheap for WAAPI.
        // Build pos lookup so we can derive baseline-vs-shift-set per
        // block without scanning blocks again.
        const posByDom = new Map<HTMLElement, number>();
        for (const b of blocks) posByDom.set(b.dom, b.pos);

        const nextPushed = new Map<
          HTMLElement,
          { anim: Animation; shift: number; pos: number }
        >();
        for (const [el, state] of pushedByEl) {
          const target = shouldBePushed.has(el) ? pushDelta : 0;
          if (state.shift === target) {
            nextPushed.set(el, state);
            shouldBePushed.delete(el);
            continue;
          }
          state.anim.cancel();
          for (const a of el.getAnimations()) a.cancel();
          const anim = el.animate(
            [
              { transform: `translateY(${state.shift}px)` },
              { transform: `translateY(${target}px)` },
            ],
            { duration: PUSH_DURATION, easing: PUSH_EASING, fill: "forwards" },
          );
          if (target !== 0) {
            nextPushed.set(el, { anim, shift: target, pos: state.pos });
          }
          shouldBePushed.delete(el);
        }
        for (const el of shouldBePushed) {
          const pos = posByDom.get(el);
          if (pos == null) continue;
          for (const a of el.getAnimations()) a.cancel();
          const anim = el.animate(
            [
              { transform: "translateY(0)" },
              { transform: `translateY(${pushDelta}px)` },
            ],
            { duration: PUSH_DURATION, easing: PUSH_EASING, fill: "forwards" },
          );
          nextPushed.set(el, { anim, shift: pushDelta, pos });
        }
        pushedByEl = nextPushed;

        if (!reflowPlaceholder) {
          const ph = activeDocument.createElement("div");
          ph.className = "butter-drag-reflow-placeholder";
          ph.style.height = `${dragState.placeholderHeight}px`;
          host.appendChild(ph);
          reflowPlaceholder = ph;
        }
        reflowState = { hitPos: hit.pos, where };
        window.requestAnimationFrame(() =>
          positionReflowPlaceholder(hit, where, blocks, targetIdx),
        );
      };

      /** Collapse the source block for the duration of the drag. Two
       *  modes, picked by dragState.useCompactMode:
       *
       *  1. OPACITY mode (normal blocks, ≤HUGE_BLOCK_MAX_HEIGHT_PX):
       *     opacity → 0, layout slot stays reserved at full size.
       *     Pure composite property → no layout reflow at drag start
       *     (save ~80-100ms on 5000-line docs). Source's still-
       *     reserved slot is visually "closed" by the reflow push
       *     that translates neighbor blocks into it.
       *
       *  2. COMPACT mode (huge blocks, >HUGE_BLOCK_MAX_HEIGHT_PX):
       *     opacity → 0 AND height animates down to the cap so the
       *     source's layout slot shrinks to match the ghost's visual
       *     footprint (≈360px). Layout below the source flows up by
       *     (actualHeight − cap); reflow push then operates on the
       *     capped footprint just like opacity mode. On drop/cancel
       *     the height animates back to full at the new (or original)
       *     position and siblings reflow down around it. Same push +
       *     placeholder math as opacity mode - the cap just keeps the
       *     vacated slot from being a screen-sized void. */
      // Source-collapse styling is applied via a PM Decoration
      // dispatched in startDrag and cleared in finishDrag. See the
      // plugin's `state` + `props.decorations` fields above. The old
      // ensureSourceCollapsed function (direct DOM mutation + WAAPI
      // animation) was deleted - its mutations triggered PM's
      // MutationObserver and caused PM to recreate the source's
      // NodeView on every pointermove, throwing away the styling.

      const positionReflowPlaceholder = (
        hit: BlockHit,
        where: "before" | "after",
        _blocks: BlockEntry[],
        _targetIdx: number,
      ) => {
        if (!reflowPlaceholder || !dragState) return;
        const hostRect = host.getBoundingClientRect();
        // Block-sized reflow placeholder uses dragState.placeholderHeight;
        // thin drop-cursor (multi-block) is 3px from CSS - for that
        // case we want top = gap-center directly, not gap-center -
        // height/2.
        const isCursor = reflowPlaceholder.classList.contains(
          "butter-drop-cursor",
        );
        const height = isCursor ? 0 : dragState.placeholderHeight;

        // Re-derive blocks here rather than trusting the `_blocks`
        // arg - the caller's array was computed BEFORE `showReflow`
        // updated `pushedByEl`, so its rects reflect the previous
        // push state, not the one we're now positioning against.
        // `getAdjustedBlocks` reads the live `pushedByEl` and gives
        // us each block's predicted post-push rect (origin layout
        // rect + final shift). Animations interpolate visually, but
        // the placeholder should land at the FINAL gap center so its
        // own `top` transition slides it cleanly to that spot in
        // sync with the push.
        const blocks = getAdjustedBlocks();
        const targetIdx = blocks.findIndex((b) => b.pos === hit.pos);
        if (targetIdx < 0) return;
        const target = blocks[targetIdx];

        // `blocks` already excludes the source, so neighbors are
        // simply targetIdx ± 1 - no skip-the-invisible-source dance.
        let gapTop: number;
        let gapBottom: number;
        if (where === "before") {
          const prev = targetIdx > 0 ? blocks[targetIdx - 1] : null;
          gapTop = prev ? prev.rect.bottom : target.rect.top - height;
          gapBottom = target.rect.top;
        } else {
          const next =
            targetIdx < blocks.length - 1 ? blocks[targetIdx + 1] : null;
          gapTop = target.rect.bottom;
          gapBottom = next ? next.rect.top : target.rect.bottom + height;
        }

        const gapMid = (gapTop + gapBottom) / 2;
        const top = gapMid - hostRect.top + host.scrollTop - height / 2;
        reflowPlaceholder.style.top = `${top}px`;

        // Depth-during-drag: shift the placeholder horizontally by
        // `depth * --list-indent` so the user sees exactly where
        // the item will land at what depth. Width shrinks by the
        // same amount so the right edge stays anchored.
        const depth =
          dragState.dropInfo?.depth ??
          dragState.listDrag?.sourceDepth ??
          0;
        const indentPx = dragState.listDrag?.indentPx ?? 0;
        const xShift = depth * indentPx;
        reflowPlaceholder.style.left = `${target.rect.left - hostRect.left + xShift}px`;
        reflowPlaceholder.style.width = `${Math.max(40, target.rect.width - xShift)}px`;
      };

      /** Clear the drop preview (placeholder + push animations) but
       *  keep the source collapsed. Called when the cursor drifts
       *  back over the source's own zone, when the target changes
       *  briefly to nothing, or when the indicator style changes
       *  mid-drag. Previously this also cleared the source collapse,
       *  which caused the source to pop back in whenever the cursor
       *  grazed its original position - a visual clash with the
       *  ghost. The source's "gone" state should persist for the
       *  entire drag and only revert on drag end. */
      const clearReflow = () => {
        // Animate every previously-pushed block back to translateY(0)
        // smoothly from its current visual position. We DO NOT cancel
        // the old push animation - cancel snaps to its start value
        // for one frame before the new animation's keyframes take
        // over, producing a flash. Skipping cancel lets WAAPI's
        // later-animation-wins rule handle the handoff: the new
        // animation wins for transform, the old one runs underneath
        // invisibly until WAAPI auto-prunes it.
        for (const [el] of pushedByEl) {
          const t = getComputedStyle(el).transform;
          let currentY = 0;
          if (t && t !== "none") {
            const m = t.match(/matrix\(([^)]+)\)/);
            if (m) {
              const ty = parseFloat(m[1].split(",")[5]);
              if (!isNaN(ty)) currentY = ty;
            } else {
              const m3 = t.match(/matrix3d\(([^)]+)\)/);
              if (m3) {
                const ty = parseFloat(m3[1].split(",")[13]);
                if (!isNaN(ty)) currentY = ty;
              }
            }
          }
          if (currentY !== 0) {
            el.animate(
              [
                { transform: `translateY(${currentY}px)` },
                { transform: "translateY(0)" },
              ],
              { duration: PUSH_DURATION, easing: PUSH_EASING, fill: "forwards" },
            );
          }
        }
        pushedByEl = new Map();

        if (reflowPlaceholder) {
          reflowPlaceholder.remove();
          reflowPlaceholder = null;
        }
        reflowState = null;
      };

      /** Full teardown - preview + source collapse. Called only on
       *  drag end (drop or Esc cancel). When `instant` is true (the
       *  drop fired and PM moved the source), translateY transforms
       *  are cleared with no animation - PM's reorder physically
       *  rearranged the DOM elements into the visual positions the
       *  push transforms had been previewing, so animating the
       *  transforms back to 0 would slide blocks AWAY from where
       *  they already are visually (a jolt of `sourceHeight` size).
       *  When `instant` is false (Esc cancel, no drop target), the
       *  cached layout is still authoritative and we animate the
       *  push back to baseline/0 smoothly. */
      const teardownReflow = (
        instant = false,
        landedPos: number | null = null,
      ) => {
        const compact = dragState?.compact === true;
        const actualFootprint = dragState?.actualFootprint ?? 0;
        const capContentHeight = dragState?.capContentHeight ?? 0;
        // For the source release animation we need the source's
        // CURRENT DOM. On the drop path PM has already moved (and
        // potentially re-rendered) the source - `dragState.source.dom`
        // could be stale or detached. Re-resolve via nodeDOM at the
        // new position. On the cancel path nothing moved, so the
        // cached reference is still valid.
        const resolveSourceDom = (): HTMLElement | null => {
          if (instant && landedPos != null) {
            const fresh = editorView.nodeDOM(landedPos);
            if (fresh instanceof HTMLElement && fresh.isConnected) {
              return fresh;
            }
          }
          const cached = dragState?.source.dom ?? null;
          return cached && cached.isConnected ? cached : null;
        };

        // Push transforms: drop path snaps them, cancel path
        // animates them back to 0.
        if (instant) {
          for (const [el, state] of pushedByEl) {
            state.anim.cancel();
            for (const a of el.getAnimations()) a.cancel();
            el.style.removeProperty("transform");
          }
          pushedByEl = new Map();
          if (reflowPlaceholder) {
            reflowPlaceholder.remove();
            reflowPlaceholder = null;
          }
          reflowState = null;
        } else {
          clearReflow();
        }

        // Source max-height release: WAAPI reverses the entry
        // animation, growing source's box back to natural over
        // PUSH_DURATION. CSS layout reflows neighbors below back to
        // their natural positions in sync. After the animation, the
        // max-height "lock" is no longer needed; cancelling the
        // animation removes its fill:forwards effect and the source
        // returns to having no WAAPI-managed max-height at all.
        //
        // Run release on a freshly-resolved source DOM (via
        // resolveSourceDom). On the drop path PM may have detached
        // or rebuilt the original source.dom when reordering blocks,
        // and an animation on a detached element wouldn't be visible.
        const startRelease = (sourceDom: HTMLElement) => {
          // Animate both max-height AND opacity in the same WAAPI
          // animation. WAAPI sits higher in the cascade than inline
          // `!important`, so the keyframes override the decoration's
          // opacity:0 for the animation's duration - the source
          // visibly fades in while its box grows back to natural
          // size.
          //
          // First keyframe pins max-height: cap and opacity: 0
          // regardless of the element's prior state (entry animation
          // still active vs. PM-rebuilt the NodeView). That gives a
          // consistent "growing out from cap" visual whether the
          // source DOM was kept by PM or recreated.
          //
          // After the animation finishes we dispatch null decoration
          // FIRST so the underlying inline opacity:0 is gone, THEN
          // cancel the animation so its fill:forwards opacity:1
          // releases into the natural opacity:1 without a flicker.
          const releaseTo = actualFootprint + 100;
          const releaseAnim = sourceDom.animate(
            [
              { maxHeight: `${capContentHeight}px`, opacity: 0 },
              { maxHeight: `${releaseTo}px`, opacity: 1 },
            ],
            {
              duration: PUSH_DURATION,
              easing: "ease-in-out",
              fill: "forwards",
            },
          );
          releaseAnim.addEventListener("finish", () => {
            editorView.dispatch(editorView.state.tr.setMeta(key, null));
            sourceCollapseAnim?.cancel();
            releaseAnim.cancel();
            if (sourceCollapseAnim === releaseAnim) {
              sourceCollapseAnim = null;
            }
          });
          sourceCollapseAnim = releaseAnim;
        };
        if (compact) {
          if (instant) {
            // Drop path: defer one rAF so PM's view update has
            // landed and nodeDOM(landedPos) returns the actual
            // post-move DOM (whether PM kept the original element
            // or rebuilt it). Decoration is dispatched null inside
            // startRelease's finish handler - keeping it active
            // through the animation is what holds the source
            // invisible until WAAPI's opacity keyframes fade it in.
            window.requestAnimationFrame(() => {
              const dom = resolveSourceDom();
              if (dom) {
                startRelease(dom);
              } else {
                // Couldn't resolve the source DOM - clear the
                // decoration so the source isn't stuck invisible.
                editorView.dispatch(editorView.state.tr.setMeta(key, null));
              }
            });
          } else {
            // Cancel path: source stayed put, original DOM is fine.
            const dom = resolveSourceDom();
            if (dom) {
              startRelease(dom);
            } else {
              editorView.dispatch(editorView.state.tr.setMeta(key, null));
            }
          }
        } else {
          // Non-compact: no max-height to release.
          // - Drop path (instant=true): onDragUp's rAF tail handles
          //   the deferred clear once the ghost has converged.
          // - Cancel / no-op-drop path (instant=false): the ghost
          //   slides back toward source over ~200ms via finishDrag's
          //   converge animation. Defer the deco clear so the source
          //   stays hidden through the slide, then add the brief
          //   fade-in class so the reveal isn't a hard pop.
          if (!instant) {
            const cancelHidePos = dragState?.source.pos ?? null;
            window.setTimeout(() => {
              if (cancelHidePos != null) {
                const dom = editorView.nodeDOM(cancelHidePos);
                if (dom instanceof HTMLElement) {
                  dom.classList.add("butter-drop-fading-in");
                  window.setTimeout(
                    () => dom.classList.remove("butter-drop-fading-in"),
                    120,
                  );
                }
              }
              editorView.dispatch(editorView.state.tr.setMeta(key, null));
            }, 200);
          }
        }
      };

      // ── Autoscroll ────────────────────────────────────────────

      const updateAutoscroll = (clientY: number) => {
        // Use the drag-start cache to avoid re-querying layout each
        // pointermove; fall back to one fresh query only if the
        // cache hasn't been primed.
        const scroller =
          cachedScroller ?? scrollHost(editorView.dom) ?? host;
        const r = cachedScrollerRect ?? scroller.getBoundingClientRect();
        const edge = 70;
        const topDist = clientY - r.top;
        const botDist = r.bottom - clientY;
        let speed = 0;
        if (topDist < edge) {
          speed = -Math.pow(1 - topDist / edge, 2) * 16;
        } else if (botDist < edge) {
          speed = Math.pow(1 - botDist / edge, 2) * 16;
        }
        autoscrollSpeed = speed;

        if (speed !== 0) {
          if (autoscrollHandle == null) {
            const tick = () => {
              if (autoscrollSpeed === 0) {
                autoscrollHandle = null;
                return;
              }
              scroller.scrollTop += autoscrollSpeed;
              autoscrollHandle = window.requestAnimationFrame(tick);
            };
            autoscrollHandle = window.requestAnimationFrame(tick);
          }
        } else if (autoscrollHandle != null) {
          cancelAnimationFrame(autoscrollHandle);
          autoscrollHandle = null;
        }
      };

      // ── Drag: cancel / commit ─────────────────────────────────

      const onDragKey = (e: KeyboardEvent) => {
        if (e.key === "Escape" && dragState) {
          dragState.cancelled = true;
          finishDrag();
        }
      };

      const onDragUp = () => {
        if (!dragState) return;

        // Determine whether a reorder should happen; compute the
        // landed position but DO NOT read layout here. All
        // layout-dependent work (getBoundingClientRect on the landed
        // block, ghost converge animation) is deferred to rAF so
        // the forced synchronous layout recompute doesn't stack on
        // top of PM's dispatch inside this pointerup frame. On a
        // 5000-line doc that read alone was ~77ms.
        let landedPos: number | null = null;
        if (!dragState.cancelled && dragState.dropInfo) {
          const { source, dropInfo, group } = dragState;
          const from = source.pos;
          const targetPos =
            dropInfo.where === "before"
              ? dropInfo.hit.pos
              : dropInfo.hit.pos + dropInfo.hit.node.nodeSize;
          // Allow same-position drops when ONLY the depth changes
          // (in-place indent / outdent via horizontal drag without
          // moving the item up/down). Otherwise require an actual
          // move out of the source's range. For contiguous groups
          // (subtree / scope) the source's range is one span. For
          // non-contiguous multi-block drags, drop targets exclude
          // every group member already (block-cache filter), so any
          // resolved drop position is necessarily a real move.
          const isPositionalMove = group.contiguous
            ? targetPos < from || targetPos > from + group.totalSize
            : true;
          const sourceDepthAttr = source.node.attrs.depth as number;
          const isDepthOnlyChange =
            !isPositionalMove &&
            dropInfo.depth !== undefined &&
            source.node.type.name === "list_item" &&
            // Compare ROUNDED depth so a tiny float drift (e.g. 0.001
            // during a microscopic horizontal jitter) doesn't trigger
            // a no-op commit.
            Math.max(0, Math.round(dropInfo.depth)) !== sourceDepthAttr;
          // Snap the float depth to an integer at commit time.
          // (During the drag the placeholder slides continuously
          // from the float value; the doc only stores integers.)
          const finalDepth =
            dropInfo.depth !== undefined
              ? Math.max(0, Math.round(dropInfo.depth))
              : undefined;
          // Apply a depth delta to the whole group while clamping each
          // child's depth to `prev_emitted.depth + 1` - so even if the
          // captured snapshot had a broken invariant (e.g. a child at
          // the same depth as its parent from a prior buggy edit), the
          // emitted group is always a well-formed depth sequence that
          // round-trips through the markdown serializer. Returns the
          // depth that ended up on the parent for record-keeping.
          const applyGroupDepths = (
            startPos: number,
            depthDelta: number,
          ) => {
            let cursor = startPos;
            let prevEmittedDepth = -1;
            for (let i = 0; i < group.nodes.length; i++) {
              const n = group.nodes[i];
              if (n.type.name === "list_item") {
                const captured = (n.attrs.depth as number) ?? 0;
                const requested = Math.max(0, captured + depthDelta);
                const cap = i === 0 ? requested : prevEmittedDepth + 1;
                const newDepth = Math.min(requested, cap);
                applyListItemDepth(editorView, cursor, newDepth);
                prevEmittedDepth = newDepth;
              }
              cursor += n.nodeSize;
            }
          };

          if (isPositionalMove) {
            const items = group.positions.map((pos, i) => ({
              pos,
              node: group.nodes[i],
            }));
            const result = moveBlocks(editorView, items, targetPos);
            if (result) {
              landedPos = result.newPos;
              if (
                finalDepth !== undefined &&
                source.node.type.name === "list_item"
              ) {
                applyGroupDepths(landedPos, finalDepth - sourceDepthAttr);
              }
            }
          } else if (isDepthOnlyChange && finalDepth !== undefined) {
            applyGroupDepths(from, finalDepth - sourceDepthAttr);
            landedPos = from;
          }
        }

        // Detach ghost from finishDrag's teardown - we'll handle its
        // converge + fade in the deferred rAF callback below. If no
        // reorder happened, let finishDrag handle the ghost normally.
        let handoffGhost: HTMLElement | null = null;
        if (landedPos != null && ghost) {
          handoffGhost = ghost;
          ghost = null;
        }

        // Capture group nodes from dragState BEFORE finishDrag
        // clears dragState - used by both the decoration re-anchor
        // (synchronous, below) and the rAF tail.
        const groupNodesForDrop = dragState.group.nodes;
        const landedDoms: HTMLElement[] = [];

        // Re-anchor the source decoration to the LANDED positions so
        // its `opacity:0 !important` keeps the just-inserted block
        // hidden through the ghost converge. The decoration's
        // automatic position mapping for delete+insert puts sourcePos
        // at the deletion gap (no block there), so without this
        // explicit re-dispatch the inserted block is unstyled and
        // visible at full opacity from the next paint. Letting PM
        // apply the hide (instead of an inline class/style we set
        // ourselves) avoids the race where PM's decoration cleanup
        // wipes our inline marker.
        //
        // teardownReflow's non-compact branch normally fires
        // setMeta(key, null) immediately, which would undo this. The
        // rAF tail below schedules the actual clear after the ghost
        // converge - see SLIDE_MS reveal block.
        if (landedPos != null) {
          const newGroupPositions: number[] = [];
          let cursor = landedPos;
          for (const n of groupNodesForDrop) {
            newGroupPositions.push(cursor);
            cursor += n.nodeSize;
          }
          editorView.dispatch(
            editorView.state.tr
              .setMeta(key, {
                sourcePos: landedPos,
                sourceSize: dragState.group.totalSize,
                groupPositions: newGroupPositions,
              })
              .setMeta("addToHistory", false),
          );
          for (const p of newGroupPositions) {
            const d = editorView.nodeDOM(p);
            if (d instanceof HTMLElement) landedDoms.push(d);
          }
        }

        // landedPos != null means PM moved the source - snap reflow
        // transforms instantly (the post-dispatch DOM positions
        // already match the mid-drag preview). Otherwise (cancel or
        // no valid drop target), animate back to baseline/0 normally.
        // Pass landedPos through so teardownReflow can resolve the
        // source's new DOM for the un-clamp release animation.
        finishDrag(null, landedPos != null, landedPos);

        if (landedPos != null) {
          const pos = landedPos;
          const SLIDE_MS = 200;
          const FADE_MS = 80;
          // Schedule the decoration clear + fade reveal once the
          // ghost has converged on the landed position. The
          // decoration's `opacity:0 !important` keeps the block
          // hidden until then; on clear, the class-based fade-in
          // animation takes over so the reveal isn't a hard pop.
          window.setTimeout(() => {
            // Refetch in case PM rebuilt the desc.
            const fadeDoms: HTMLElement[] = [];
            for (const d of landedDoms) {
              if (d.isConnected) fadeDoms.push(d);
            }
            if (fadeDoms.length === 0) {
              const fresh = editorView.nodeDOM(pos);
              if (fresh instanceof HTMLElement) fadeDoms.push(fresh);
            }
            for (const d of fadeDoms) d.classList.add("butter-drop-fading-in");
            // Clearing the decoration removes opacity:0 !important;
            // the .butter-drop-fading-in class then drives a 0→1 ease.
            editorView.dispatch(editorView.state.tr.setMeta(key, null));
            window.setTimeout(() => {
              for (const d of fadeDoms) d.classList.remove("butter-drop-fading-in");
            }, FADE_MS + 40);
          }, SLIDE_MS);

          window.requestAnimationFrame(() => {
            const dom = editorView.nodeDOM(pos);
            if (!(dom instanceof HTMLElement)) {
              handoffGhost?.remove();
              return;
            }
            const rect = dom.getBoundingClientRect();
            // Slide the ghost first; the deco's opacity:0 hides the
            // landed block until the ghost arrives.
            if (handoffGhost) {
              handoffGhost.classList.add("is-leaving");
              const currentTransform = handoffGhost.style.transform || "none";
              const targetTransform = `translate(${rect.left}px, ${rect.top}px)`;
              handoffGhost.animate(
                [
                  { transform: currentTransform },
                  { transform: targetTransform },
                ],
                {
                  duration: SLIDE_MS,
                  easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
                  fill: "forwards",
                },
              );
              const leaving = handoffGhost;
              window.setTimeout(() => leaving.remove(), SLIDE_MS + 20);
            }
            // Just-dropped accent flash. Delayed so it lights up when
            // the block actually appears (not while still hidden).
            window.setTimeout(() => {
              dom.classList.add("butter-drag-just-dropped");
              window.setTimeout(
                () => dom.classList.remove("butter-drag-just-dropped"),
                700,
              );
            }, SLIDE_MS);
          });
        }
      };

      const finishDrag = (
        convergeRect: DOMRect | null = null,
        droppedToNewPos = false,
        landedPos: number | null = null,
      ) => {
        cachedScroller = null;
        cachedScrollerRect = null;
        // Only compute a fallback converge rect when there's still a
        // ghost to animate to it. On the drop path we hand the ghost
        // off before calling finishDrag, so `ghost` is null and we
        // skip this read - important because getBoundingClientRect
        // right after PM's dispatch forces a full-doc layout
        // recompute (~73ms on a 5000-line doc).
        if (!convergeRect && dragState && ghost) {
          const sourceDom = editorView.nodeDOM(dragState.source.pos);
          if (sourceDom instanceof HTMLElement) {
            convergeRect = sourceDom.getBoundingClientRect();
          }
        }
        cachedZone = null;
        blockCache = null;
        // `droppedToNewPos = true` when PM has already moved the
        // source. The DOM elements are now at their new natural
        // positions (which match the mid-drag preview) and any push
        // transforms still on them would visually shift them AWAY
        // from where they should be - animate-back-to-0 would mean
        // sliding blocks by sourceHeight to "settle" them where
        // they're already supposed to be. Snap transforms instead.
        teardownReflow(droppedToNewPos, landedPos);
        if (pendingGhostRaf != null) {
          cancelAnimationFrame(pendingGhostRaf);
          pendingGhostRaf = null;
        }
        // Cancel every WAAPI animation we started for the multi-
        // block member collapse. Without this, fill:forwards keeps
        // max-height/margins/padding/border at 0 even after the
        // dom moves to its new doc position - so dropped blocks
        // stay invisible / overlapping at the landed location.
        if (dragState?.collapsedAnimations) {
          for (const a of dragState.collapsedAnimations) {
            try { a.cancel(); } catch { /* noop */ }
          }
        }
        // Belt-and-suspenders: any leftover marker tag goes too.
        editorView.dom
          .querySelectorAll<HTMLElement>("[data-butter-multi-collapsed]")
          .forEach((el) => {
            el.removeAttribute("data-butter-multi-collapsed");
            // Clear the inline display:none that the WAAPI
            // animation's finish handler may have applied.
            el.style.removeProperty("display");
          });
        // The "butter-drag-source" class is now applied by the
        // plugin's decoration (cleared above by `teardownReflow` ->
        // setMeta(key, null)), so no DOM class to remove here.
        dragState = null;
        autoscrollSpeed = 0;
        if (autoscrollHandle != null) {
          cancelAnimationFrame(autoscrollHandle);
          autoscrollHandle = null;
        }
        if (rafHandle != null) {
          cancelAnimationFrame(rafHandle);
          rafHandle = null;
        }
        if (ghost) {
          const leaving = ghost;
          leaving.classList.add("is-leaving");
          // If we know where the real block landed, glide the ghost
          // to that position while it fades. Bridges the otherwise-
          // jarring gap between "ghost at cursor" and "real block
          // at drop position."
          if (convergeRect) {
            const targetTransform = `translate(${convergeRect.left}px, ${convergeRect.top}px)`;
            const currentTransform = leaving.style.transform || "none";
            leaving.animate(
              [
                { transform: currentTransform },
                { transform: targetTransform },
              ],
              {
                duration: 200,
                easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
                fill: "forwards",
              },
            );
            window.setTimeout(() => leaving.remove(), 220);
          } else {
            window.setTimeout(() => leaving.remove(), 180);
          }
          ghost = null;
        }
        activeDocument.body.classList.remove("butter-is-dragging");
        hideDropIndicator();
        handle.classList.remove("is-visible", "is-pressed");
        currentHit = null;
        window.removeEventListener("pointermove", onDragMove);
        window.removeEventListener("pointerup", onDragUp);
        window.removeEventListener("keydown", onDragKey);
        window.removeEventListener("touchmove", swallowTouchEvent, { capture: true });
        window.removeEventListener("touchstart", swallowTouchEvent, { capture: true });
        window.removeEventListener("touchend", swallowTouchEvent, { capture: true });
      };

      return {
        update() {
          if (dragState) return;
          // Re-pin the handle to a NodeSelection on every state apply
          // so it follows the selected block as the doc shifts under
          // it (keystrokes elsewhere, decorations, etc.). Without
          // this, the handle's left/top gets stale relative to the
          // block's new viewport position.
          const pinned = nodeSelectionHit();
          if (pinned) {
            currentHit = pinned;
            showHandleAt(pinned);
            return;
          }
          handle.classList.remove("is-visible");
          currentHit = null;
        },
        destroy() {
          activeDocument.removeEventListener("mousemove", onDocMouseMove);
          window.removeEventListener("pointermove", onArmMove);
          window.removeEventListener("pointerup", onArmUp);
          window.removeEventListener("pointermove", onDragMove);
          window.removeEventListener("pointerup", onDragUp);
          window.removeEventListener("keydown", onDragKey);
          editorView.dom.removeEventListener("pointerdown", onMobilePointerDown);
          window.removeEventListener("pointermove", onMobilePointerMove);
          window.removeEventListener("pointerup", onMobilePointerUp);
          window.removeEventListener("pointercancel", onMobilePointerUp);
          window.removeEventListener("touchmove", swallowTouchEvent, { capture: true });
          window.removeEventListener("touchstart", swallowTouchEvent, { capture: true });
          window.removeEventListener("touchend", swallowTouchEvent, { capture: true });
          if (lpTimer !== null) window.clearTimeout(lpTimer);
          if (rafHandle != null) cancelAnimationFrame(rafHandle);
          if (autoscrollHandle != null) cancelAnimationFrame(autoscrollHandle);
          handle.remove();
          ghost?.remove();
          reflowPlaceholder?.remove();
          activeDocument.body.classList.remove("butter-is-dragging");
        },
      };
    },
  });
}
