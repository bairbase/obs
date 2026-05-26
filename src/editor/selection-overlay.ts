/**
 * Selected-block highlight ring, rendered as a fixed-position overlay
 * in `document.body` so it can't be clipped by the editor's
 * `overflow-y: auto` (which per CSS spec also clips horizontal
 * overflow). Replaces the previous `.ProseMirror-selectednode`
 * outline approach, which extended 9px past the block's box and got
 * clipped on themes with narrow `--file-margins`.
 *
 * Mechanics:
 *   • PluginView listens for state.selection changes via the standard
 *     `update()` lifecycle hook.
 *   • When the selection is a NodeSelection, look up the selected
 *     node's DOM via `view.nodeDOM(pos)` and read its
 *     `getBoundingClientRect()`. Position the overlay div at the
 *     same rect (expanded by `--butter-selection-offset` on each
 *     side for the breathing-room ring). Copy the block's computed
 *     `border-radius` so the overlay's corners match the block's.
 *   • When the selection isn't a NodeSelection, hide the overlay.
 *   • Reposition on any scroll bubbling through the document
 *     (capture-phase listener so internal scrollers fire it) and on
 *     window resize. Both rAF-throttled to keep it cheap during
 *     fast scroll.
 *
 * Visual matches the original outline 1:1 (3px stroke at 6px offset,
 * accent color at 0.3 alpha) so users see the same ring they're
 * used to - just rendered from outside the editor's clip box.
 */
import { Plugin as PMPlugin, PluginKey, NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { getMultiBlockSelection } from "./multi-block-select";

class SelectionOverlayView {
  view: EditorView;
  /** Pool of overlay elements. Index 0 is the primary (NodeSelection),
   *  1..N are the multi-block siblings. Reused across renders so we
   *  don't churn the DOM on every selection change. */
  overlays: HTMLElement[] = [];
  scrollListener: () => void;
  resizeListener: () => void;
  rafHandle: number | null = null;

  constructor(view: EditorView) {
    this.view = view;

    this.scrollListener = () => this.scheduleUpdate();
    this.resizeListener = () => this.scheduleUpdate();
    // Capture-phase scroll listener so internal scrollers (the
    // editor itself, modals, etc.) trigger the recompute even
    // though scroll events don't bubble.
    window.addEventListener("scroll", this.scrollListener, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", this.resizeListener);

    this.update();
  }

  /** Get an overlay element from the pool, creating one if needed. */
  private acquireOverlay(idx: number): HTMLElement {
    while (this.overlays.length <= idx) {
      const el = activeDocument.createElement("div");
      el.className = "butter-selection-overlay";
      activeDocument.body.appendChild(el);
      this.overlays.push(el);
    }
    return this.overlays[idx];
  }

  /** Hide overlays at index >= idx. */
  private hideFrom(idx: number): void {
    for (let i = idx; i < this.overlays.length; i++) {
      this.overlays[i].classList.remove("is-visible");
    }
  }

  scheduleUpdate(): void {
    if (this.rafHandle != null) return;
    this.rafHandle = window.requestAnimationFrame(() => {
      this.rafHandle = null;
      this.repaint();
    });
  }

  update(): void {
    // PluginView.update is called after every state apply. The
    // selection may have changed; recompute. Doc-content edits that
    // didn't change selection still hit this - cheap to re-check.
    this.repaint();
  }

  /** Position a single overlay at the union of the bounding rects of
   *  the blocks in `positions` (which must be a contiguous run in doc
   *  order). Returns true if at least one block resolved, false
   *  otherwise. The merged shape uses a flat 9px corner radius for
   *  multi-block groups (per-block radii would clash on the joint
   *  edges); single-block groups keep the block's own radius for
   *  visual continuity with that block. */
  private positionGroupAt(
    overlay: HTMLElement,
    positions: number[],
  ): boolean {
    let minTop = Infinity;
    let maxBottom = -Infinity;
    let minLeft = Infinity;
    let maxRight = -Infinity;
    let firstDom: HTMLElement | null = null;
    for (const pos of positions) {
      const dom = this.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) continue;
      if (!firstDom) firstDom = dom;
      const rect = dom.getBoundingClientRect();
      if (rect.top < minTop) minTop = rect.top;
      if (rect.bottom > maxBottom) maxBottom = rect.bottom;
      if (rect.left < minLeft) minLeft = rect.left;
      if (rect.right > maxRight) maxRight = rect.right;
    }
    if (!firstDom || !isFinite(minTop)) return false;

    const inset = 9;
    overlay.style.left = `${minLeft - inset}px`;
    overlay.style.top = `${minTop - inset}px`;
    overlay.style.width = `${maxRight - minLeft + inset * 2}px`;
    overlay.style.height = `${maxBottom - minTop + inset * 2}px`;
    if (positions.length === 1) {
      const computed = getComputedStyle(firstDom);
      if (computed.borderRadius && computed.borderRadius !== "0px") {
        overlay.style.borderRadius = `calc(${computed.borderRadius} + ${inset}px)`;
      } else {
        overlay.style.borderRadius = `${inset}px`;
      }
    } else {
      overlay.style.borderRadius = `${inset}px`;
    }
    overlay.classList.add("is-visible");
    return true;
  }

  /** Group sorted positions into runs of doc-adjacent siblings.
   *  Two top-level positions `a` and `b` (a < b) are adjacent iff
   *  the block at `a` ends exactly where `b` begins
   *  (a + nodeAt(a).nodeSize === b). Anything else opens a new run. */
  private groupAdjacent(sorted: number[]): number[][] {
    const groups: number[][] = [];
    let current: number[] = [];
    for (const pos of sorted) {
      if (current.length === 0) {
        current.push(pos);
        continue;
      }
      const prev = current[current.length - 1];
      const prevNode = this.view.state.doc.nodeAt(prev);
      if (prevNode && prev + prevNode.nodeSize === pos) {
        current.push(pos);
      } else {
        groups.push(current);
        current = [pos];
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private repaint(): void {
    // Build the set of positions to highlight: the multi-block
    // selection set + the current NodeSelection (if any). Dedup so
    // we don't paint the same block twice when both are active and
    // refer to the same block.
    const positions = new Set<number>();
    const multi = getMultiBlockSelection(this.view.state);
    for (const p of multi.positions) positions.add(p);
    const sel = this.view.state.selection;
    if (sel instanceof NodeSelection) positions.add(sel.from);

    if (positions.size === 0) {
      this.hideFrom(0);
      return;
    }

    // Sort + group into contiguous runs so neighboring selected
    // blocks render as a single merged shape (instead of stacked
    // identical rings hugging each other).
    const sorted = [...positions].sort((a, b) => a - b);
    const groups = this.groupAdjacent(sorted);

    let i = 0;
    for (const group of groups) {
      const overlay = this.acquireOverlay(i);
      if (this.positionGroupAt(overlay, group)) {
        i++;
      } else {
        // Couldn't resolve - hide this slot.
        overlay.classList.remove("is-visible");
      }
    }
    // Hide any extra overlays from a previous larger selection.
    this.hideFrom(i);
  }

  destroy(): void {
    for (const o of this.overlays) o.remove();
    this.overlays = [];
    window.removeEventListener("scroll", this.scrollListener, {
      capture: true,
    });
    window.removeEventListener("resize", this.resizeListener);
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
  }
}

export function selectionOverlayPlugin(): PMPlugin {
  return new PMPlugin({
    key: new PluginKey("butter-selection-overlay"),
    view(view) {
      return new SelectionOverlayView(view);
    },
  });
}
