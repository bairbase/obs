/**
 * Inline-atom edit UI.
 *
 * Right-click an inline atom (wikilink, tag, embed, inline math,
 * footnote ref, inline footnote) to open a native Obsidian Menu
 * with an "Edit source" item. Selecting it opens a small floating
 * edit panel near the atom with:
 *   - A type label ("Wikilink", "Tag", …)
 *   - An input prefilled with the atom's raw markdown source
 *   - Save / Cancel buttons (Lucide icons)
 *
 * Enter commits the edit (replaces the atom via a PM transaction
 * after parsing the new source through a per-type regex). Esc
 * cancels without modification. Clicks outside the panel also
 * cancel. If the input doesn't match the expected source pattern
 * for the atom type, save does nothing (silent reject; keeps panel
 * open with a red-flash so user can fix).
 *
 * Why right-click vs. double-click: single-click on wikilinks and
 * tags has real nav semantics (open link, jump to tag search);
 * introducing a debounce to support double-click-to-edit would make
 * the click feel laggy. Right-click context menu has no collision
 * with nav and maps to the user's mental model ("right-click for
 * options on this thing").
 *
 * Styling: panel reuses the .butter-table-toolbar CSS chrome (same
 * border, shadow, rounded corners, button sizing) for a consistent
 * floating-toolbar language across the editor.
 */

import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { App, Menu, Platform, setIcon } from "obsidian";
import { SPECS, type AtomSpec, type AtomField } from "./inline-atom-specs";
import { applyBlockContextMenuChrome } from "./block-menu-spec";
import { openRichContextMenu } from "../ui/link-context-menu";
import { applyVaultFilesSuggest } from "../ui/vault-files-suggest";
import { sanitizeHref } from "../util/safe-url";

/** Class selector matching every editable atom's root DOM. Used by
 *  the DOM-event handler to quickly reject clicks outside editable
 *  regions. */
const ATOM_DOM_SELECTOR = [
  ".butter-wikilink",
  ".butter-tag",
  ".butter-obsidian-embed",
  ".butter-inline-math",
  ".butter-footnote-ref",
  ".butter-inline-footnote",
].join(", ");

// ─── Plugin state ────────────────────────────────────────────────

interface EditingState {
  /** PM position of the atom being edited (node start). */
  pos: number;
  /** DOM element of the floating panel - kept to tear down on close. */
  panel: HTMLElement;
  /** Cleanup function that removes panel + listeners. Plugin view's
   *  destroy and the cancel path both call this. */
  close: () => void;
}

/** Result of buildPanel - `inputs` is keyed by field name (or
 *  "source" when the spec is in legacy single-input mode). */
interface BuiltPanel {
  dom: HTMLElement;
  inputs: Record<string, HTMLInputElement>;
  primary: HTMLInputElement;
  saveBtn: HTMLElement;
  cancelBtn: HTMLElement;
}

const key = new PluginKey<EditingState | null>("butter-inline-atom-edit");

// ─── UI construction ─────────────────────────────────────────────

/** Trim a header sub-text to a sensible width. The block-context-menu
 *  CSS already ellipsizes overflow, but we cap at 40 chars first so
 *  long URLs / TeX strings don't push the layout into the ellipsis
 *  before the visually-meaningful portion is shown. */
function truncateForHeader(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/** Header sub-text for the right-click menu on an inline atom - a
 *  short identifier the user can recognize at a glance (target name
 *  for a wikilink, `#tag` for a tag, etc.). Falls back to the atom's
 *  serialized source when the spec doesn't have a more concise form. */
function atomHeaderSub(node: PMNode, spec: AtomSpec): string {
  switch (node.type.name) {
    case "wikilink": {
      const target = (node.attrs.target as string) || "";
      const alias = (node.attrs.alias as string) || "";
      return alias ? `${target} · "${alias}"` : target;
    }
    case "obsidian_tag":
      return `#${node.attrs.tag as string}`;
    case "obsidian_embed":
    case "obsidian_embed_inline":
      return (node.attrs.target as string) || "";
    case "footnote_ref":
      return `^${node.attrs.label as string}`;
    case "inline_math":
      return truncateForHeader(spec.toSource(node));
    case "inline_footnote":
      return truncateForHeader(node.textContent || spec.toSource(node));
    default:
      return truncateForHeader(spec.toSource(node));
  }
}

/** Right-click on a wikilink → unified rich popover. Header (link
 *  icon + "Wikilink" + target preview) + inline Note / Name inputs
 *  (mirrors the spec.fields the floating edit panel used to surface)
 *  + the nav action rows that used to sit in the Obsidian Menu. No
 *  separate "Edit wikilink" submenu - editing is the menu now. */
function openWikilinkContextMenu(
  app: App,
  editorView: EditorView,
  pos: number,
  node: PMNode,
  event: MouseEvent,
  anchor: HTMLElement,
): void {
  const spec = SPECS.wikilink;
  if (!spec || !spec.fields || !spec.toFields || !spec.fromFields) return;
  const initial = spec.toFields(node);
  const target = (node.attrs.target as string) || "";
  const alias = (node.attrs.alias as string) || "";
  const subText = alias ? `${target} · "${alias}"` : target;

  // Each commit re-resolves the node by position so a stale reference
  // (after another tr) doesn't blow up. Returns true if the doc was
  // mutated, so we can avoid spurious dispatches.
  const commit = (values: Record<string, string>): boolean => {
    if (
      values.target === initial.target &&
      values.alias === initial.alias
    ) {
      return false;
    }
    const next = spec.fromFields!(values, editorView.state.schema);
    if (!next) return false;
    const live = editorView.state.doc.nodeAt(pos);
    if (!live || live.type.name !== "wikilink") return false;
    const tr = editorView.state.tr.replaceWith(pos, pos + live.nodeSize, next);
    editorView.dispatch(tr);
    return true;
  };

  // Nav actions reuse the LIVE input target - that way "Open in new
  // tab" with a freshly-edited target name lands at the user's
  // intended target, not the original.
  const openIn = (values: Record<string, string>, where: "tab" | "window" | "split") => {
    commit(values);
    editorView.focus();
    const t = (values.target || target).trim();
    if (!t) return;
    void app.workspace.openLinkText(t, "", where);
  };

  openRichContextMenu({
    app,
    anchor,
    event,
    autoFocusFirstField: false,
    chrome: {
      icon: "link",
      title: "Wikilink",
      sub: subText,
    },
    fields: spec.fields.map((f: AtomField) => ({
      id: f.name,
      label: f.label,
      icon: f.icon,
      initial: initial[f.name] || "",
      placeholder:
        typeof f.placeholder === "function"
          ? f.placeholder(initial)
          : f.placeholder,
      autocomplete: f.autocomplete,
    })),
    actions: [
      {
        label: "Open in new tab",
        icon: "file-plus",
        onClick: (v) => openIn(v, "tab"),
      },
      {
        label: "Open in new window",
        icon: "monitor",
        onClick: (v) => openIn(v, "window"),
      },
      {
        label: "Open to the right",
        icon: "separator-vertical",
        onClick: (v) => openIn(v, "split"),
      },
      {
        label: "Clear link",
        icon: "eraser",
        warning: true,
        separatorBefore: true,
        receivesValues: false,
        onClick: () => {
          const live = editorView.state.doc.nodeAt(pos);
          if (!live || live.type.name !== "wikilink") return;
          const text =
            (live.attrs.alias as string) ||
            (live.attrs.target as string) ||
            "";
          if (!text) return;
          const tr = editorView.state.tr.replaceWith(
            pos,
            pos + live.nodeSize,
            editorView.state.schema.text(text),
          );
          editorView.dispatch(tr);
          editorView.focus();
        },
      },
    ],
    onCommit: (values) => {
      commit(values);
      editorView.focus();
    },
  });
}

/** Per-atom-type icon for the input row. Nice-to-have visual cue
 *  matching the toolbar link popover's icon-driven chrome. Wikilinks
 *  use Lucide `link` to match the toolbar's primary Link button so
 *  the menu chrome and the toolbar speak the same visual language. */
const ATOM_ICONS: Record<string, string> = {
  wikilink: "link",
  obsidian_tag: "hash",
  obsidian_embed: "image",
  obsidian_embed_inline: "image",
  inline_math: "sigma",
  footnote_ref: "asterisk",
  inline_footnote: "asterisk",
};

function buildPanel(
  app: App,
  spec: AtomSpec,
  node: PMNode,
): BuiltPanel {
  const dom = activeDocument.createElement("div");
  // Borrow Obsidian's `.menu` chrome (so the panel sits in the same
  // visual register as the right-click context menu it spawned from).
  dom.className = "menu butter-inline-atom-edit";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", `Edit ${spec.label.toLowerCase()}`);
  dom.addClass("butter-pos-absolute");
  // Don't blur the editor on clicks inside the panel - PM's blur
  // logic would tear down our state. Inputs need pointer events to
  // pass through normally for text-selection.
  dom.addEventListener("mousedown", (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });

  const inputs: Record<string, HTMLInputElement> = {};
  let primary: HTMLInputElement | null = null;

  if (spec.fields && spec.toFields) {
    // ── Multi-field structured form (wikilink etc.) ──
    const initialValues = spec.toFields(node);

    const fieldInputs: Array<{ field: AtomField; input: HTMLInputElement }> = [];
    for (const field of spec.fields) {
      const fieldEl = dom.createDiv({ cls: "butter-inline-atom-edit-field" });
      fieldEl.createDiv({
        cls: "butter-inline-atom-edit-field-label",
        text: field.label,
      });
      const row = fieldEl.createDiv({ cls: "butter-inline-atom-edit-row" });
      if (field.icon) {
        const iconEl = row.createDiv({ cls: "butter-inline-atom-edit-icon" });
        setIcon(iconEl, field.icon);
      }
      const inputEl = row.createEl("input", {
        cls: "butter-inline-atom-edit-input",
        attr: { type: "text", spellcheck: "false" },
      });
      inputEl.value = initialValues[field.name] ?? "";
      if (field.autocomplete === "vault-files") {
        applyVaultFilesSuggest(app, inputEl, {
          onSelect: (file) => {
            inputEl.value = file.basename;
            inputEl.dispatchEvent(new Event("input"));
          },
        });
      }
      inputs[field.name] = inputEl;
      fieldInputs.push({ field, input: inputEl });
      if (!primary) primary = inputEl;
    }

    // Wire dynamic placeholders. Each field whose placeholder is a
    // function recomputes whenever ANY input changes - so the alias
    // field's "defaults to <target>" hint tracks the target input
    // live.
    const refreshPlaceholders = () => {
      const values: Record<string, string> = {};
      for (const { field, input } of fieldInputs) {
        values[field.name] = input.value;
      }
      for (const { field, input } of fieldInputs) {
        const ph = field.placeholder;
        const resolved =
          typeof ph === "function" ? ph(values) : ph ?? "";
        input.placeholder = resolved;
      }
    };
    refreshPlaceholders();
    for (const { input } of fieldInputs) {
      input.addEventListener("input", refreshPlaceholders);
    }
  } else {
    // ── Legacy single-source input (tags, embeds, math, footnotes) ──
    const inputRow = dom.createDiv({ cls: "butter-inline-atom-edit-row" });
    const iconWrap = inputRow.createDiv({ cls: "butter-inline-atom-edit-icon" });
    const iconName = ATOM_ICONS[spec.typeName] ?? "pencil";
    setIcon(iconWrap, iconName);
    const sourceInput = inputRow.createEl("input", {
      cls: "butter-inline-atom-edit-input",
      attr: { type: "text", spellcheck: "false", placeholder: spec.label },
    });
    sourceInput.value = spec.toSource(node);
    inputs.source = sourceInput;
    primary = sourceInput;
  }

  // ── Separator + action rows. Use Obsidian's native `.menu-item`
  // markup so the rows match the spawning context menu visually. ──
  dom.createDiv({ cls: "menu-separator" });

  const buildAction = (icon: string, label: string, kbd: string) => {
    const item = dom.createDiv({
      cls: "menu-item tappable butter-inline-atom-edit-action",
    });
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", `${label} (${kbd})`);
    const iconEl = item.createDiv({ cls: "menu-item-icon" });
    setIcon(iconEl, icon);
    item.createDiv({ cls: "menu-item-title", text: label });
    return item;
  };

  const saveBtn = buildAction("check", "Save", "Enter");
  const cancelBtn = buildAction("x", "Cancel", "Esc");

  if (!primary) {
    // Defensive - shouldn't happen since both branches assign primary.
    primary = dom.querySelector<HTMLInputElement>("input");
  }
  if (!primary) {
    // Last-ditch fallback - return an empty hidden input rather than
    // crashing the panel setup.
    primary = activeDocument.createElement("input");
  }
  return { dom, inputs, primary, saveBtn, cancelBtn };
}

function positionPanel(
  panel: HTMLElement,
  atomDOM: Element,
  parent: HTMLElement,
) {
  const atomRect = atomDOM.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  panel.style.top = `${atomRect.bottom - parentRect.top + 4}px`;
  panel.style.left = `${atomRect.left - parentRect.left}px`;
  // If there's no room below (atom near bottom of viewport), flip above.
  const panelHeight = panel.offsetHeight;
  const roomBelow = window.innerHeight - atomRect.bottom;
  if (roomBelow < panelHeight + 12) {
    panel.style.top = `${atomRect.top - parentRect.top - panelHeight - 4}px`;
  }
}

// ─── Open / close editor ─────────────────────────────────────────

function openEditor(
  app: App,
  view: EditorView,
  pos: number,
  node: PMNode,
  atomDOM: Element,
): void {
  const spec = SPECS[node.type.name];
  if (!spec) return;

  const parent = view.dom.parentElement;
  if (!parent) return;

  const built = buildPanel(app, spec, node);
  const { dom, inputs, primary, saveBtn, cancelBtn } = built;
  parent.appendChild(dom);
  positionPanel(dom, atomDOM, parent);

  // Focus + select the primary input content so the user can
  // immediately overwrite or position the cursor via keyboard nav.
  window.setTimeout(() => {
    primary.focus();
    primary.select();
  }, 0);

  // Wire up outside-click dismiss. We install a document-level
  // listener; teardown removes it.
  const onDocumentMouseDown = (ev: MouseEvent) => {
    if (ev.target instanceof Node && dom.contains(ev.target)) return;
    cancel();
  };

  const flashError = () => {
    primary.classList.add("butter-inline-atom-edit-input-error");
    window.setTimeout(() => {
      primary.classList.remove("butter-inline-atom-edit-input-error");
    }, 500);
  };

  const commit = () => {
    let newNode: PMNode | null = null;
    if (spec.fields && spec.fromFields) {
      const values: Record<string, string> = {};
      for (const f of spec.fields) values[f.name] = inputs[f.name]?.value ?? "";
      newNode = spec.fromFields(values, view.state.schema);
    } else {
      const src = inputs.source?.value ?? "";
      newNode = spec.fromSource(src, view.state.schema);
    }
    if (!newNode) {
      flashError();
      return;
    }
    // Re-resolve the atom's position in case the doc changed between
    // open and commit. Range is the single-atom slice at `pos`.
    const currentNode = view.state.doc.nodeAt(pos);
    if (!currentNode || currentNode.type.name !== node.type.name) {
      cancel();
      return;
    }
    const tr = view.state.tr.replaceWith(pos, pos + currentNode.nodeSize, newNode);
    tr.setMeta(key, { kind: "clear" });
    view.dispatch(tr);
    close();
    view.focus();
  };

  const cancel = () => {
    close();
    view.focus();
  };

  const close = () => {
    activeDocument.removeEventListener("mousedown", onDocumentMouseDown, true);
    dom.remove();
    view.dispatch(view.state.tr.setMeta(key, { kind: "clear" }));
  };

  saveBtn.addEventListener("click", (e) => {
    e.preventDefault();
    commit();
  });
  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    cancel();
  });
  // Wire Enter / Esc on every input so the keyboard works whichever
  // field has focus.
  for (const input of Object.values(inputs)) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  }
  activeDocument.addEventListener("mousedown", onDocumentMouseDown, true);

  view.dispatch(
    view.state.tr.setMeta(key, { kind: "set", pos, panel: dom, close }),
  );
}

// ─── External link (link mark) helpers ───────────────────────────

/** Find the contiguous range in the click's parent textblock that
 *  carries the same link-mark instance. Used by the external-link
 *  context menu so Edit / Clear operate on the entire link, not the
 *  one character under the cursor.
 *
 *  Walks the parent's children directly - character-by-character
 *  position walks are unreliable at text-node boundaries because
 *  PM's `ResolvedPos.marks()` returns different sets depending on
 *  whether you ask "marks active at this boundary" vs "marks of the
 *  next character", which differ at the start/end of a marked run
 *  and would leave one character behind on Clear. */
function findLinkMarkRange(
  view: EditorView,
  pos: number,
): { from: number; to: number; href: string; text: string } | null {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return null;
  const doc = view.state.doc;
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;

  const parent = $pos.parent;
  const parentStart = $pos.start();
  const offset = $pos.parentOffset;

  // Find the child whose range contains `offset`. Children are text
  // / inline nodes; PM merges adjacent text nodes that share the
  // same mark set, so a normal link is one text node. Boundary clicks
  // (offset exactly on a child edge) prefer the child whose mark set
  // has the link.
  let foundIdx = -1;
  let acc = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const start = acc;
    const end = start + child.nodeSize;
    const inside = offset > start && offset < end;
    const onBoundary = offset === start || offset === end;
    if (
      (inside || onBoundary) &&
      child.marks.some((m) => m.type === linkType)
    ) {
      foundIdx = i;
      // Prefer non-boundary match if we already have one - but
      // since we break on first hit, the iteration order resolves
      // ambiguity by preferring the earlier child on a shared edge.
      if (inside) break;
    }
    acc = end;
  }
  if (foundIdx < 0) return null;

  const mark = parent
    .child(foundIdx)
    .marks.find((m) => m.type === linkType)!;

  // Extend left + right through neighbor children that carry the
  // same mark instance. Defensive - PM normally merges these.
  let startIdx = foundIdx;
  let endIdx = foundIdx;
  while (
    startIdx > 0 &&
    parent
      .child(startIdx - 1)
      .marks.some((m) => m.type === linkType && m.eq(mark))
  ) {
    startIdx -= 1;
  }
  while (
    endIdx < parent.childCount - 1 &&
    parent
      .child(endIdx + 1)
      .marks.some((m) => m.type === linkType && m.eq(mark))
  ) {
    endIdx += 1;
  }

  // Compute the doc-absolute from/to from accumulated child sizes.
  let from = parentStart;
  let to = parentStart;
  let cur = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (i === startIdx) from = parentStart + cur;
    if (i === endIdx) to = parentStart + cur + c.nodeSize;
    cur += c.nodeSize;
  }

  return {
    from,
    to,
    href: (mark.attrs as { href?: string }).href ?? "",
    text: doc.textBetween(from, to),
  };
}


function showExternalLinkMenu(
  app: App,
  view: EditorView,
  event: MouseEvent,
  anchor: HTMLAnchorElement,
): void {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return;
  const posInfo = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  if (!posInfo) return;
  const range = findLinkMarkRange(view, posInfo.pos);
  if (!range) return;

  // Commit the URL + Display-text edits as a single tr - replaces the
  // marked range with new text + new mark when changed, no-ops when
  // unchanged. Re-resolves the range against the live doc each call
  // so a stale capture doesn't blow up.
  const commit = (values: Record<string, string>): boolean => {
    const newUrl = (values.url || "").trim();
    if (!newUrl) return false;
    const newText = values.text || newUrl;
    if (newUrl === range.href && newText === range.text) return false;
    const fresh = findLinkMarkRange(view, range.from);
    if (!fresh) return false;
    const replacement = view.state.schema.text(newText, [
      linkType.create({ href: newUrl }),
    ]);
    view.dispatch(view.state.tr.replaceWith(fresh.from, fresh.to, replacement));
    return true;
  };

  openRichContextMenu({
    app,
    anchor,
    event,
    autoFocusFirstField: false,
    chrome: {
      icon: "link",
      title: "External link",
      sub: truncateForHeader(range.href),
    },
    fields: [
      {
        id: "url",
        label: "URL",
        icon: "globe",
        initial: range.href,
        placeholder: "https://…",
      },
      {
        id: "text",
        label: "Display text",
        icon: "type",
        initial: range.text,
        placeholder: range.href || "Display text",
      },
    ],
    actions: [
      {
        label: "Open in default browser",
        icon: "external-link",
        onClick: (v) => {
          commit(v);
          const raw = (v.url || range.href).trim();
          if (!raw) return;
          const safe = sanitizeHref(raw);
          if (safe === "#") return;
          const win = window as unknown as { open: typeof window.open };
          win.open(safe, "_blank");
        },
      },
      {
        label: "Copy URL",
        icon: "copy",
        onClick: (v) => {
          const url = (v.url || range.href).trim();
          if (!url) return;
          void navigator.clipboard.writeText(url).catch(() => {
            /* clipboard may be unavailable; silently no-op */
          });
        },
      },
      {
        label: "Clear link",
        icon: "eraser",
        warning: true,
        separatorBefore: true,
        receivesValues: false,
        onClick: () => {
          const fresh = findLinkMarkRange(view, range.from);
          if (!fresh) return;
          const tr = view.state.tr.removeMark(fresh.from, fresh.to, linkType);
          view.dispatch(tr);
          view.focus();
        },
      },
    ],
    onCommit: (values) => {
      commit(values);
      view.focus();
    },
  });
}

// ─── Plugin ──────────────────────────────────────────────────────

type Meta =
  | { kind: "set"; pos: number; panel: HTMLElement; close: () => void }
  | { kind: "clear" };

export function inlineAtomEditPlugin(app: App): Plugin<EditingState | null> {
  return new Plugin<EditingState | null>({
    key,
    state: {
      init: () => null,
      apply: (tr, prev) => {
        const meta = tr.getMeta(key) as Meta | undefined;
        if (meta) {
          if (meta.kind === "clear") return null;
          if (meta.kind === "set") {
            return {
              pos: meta.pos,
              panel: meta.panel,
              close: meta.close,
            };
          }
        }
        return prev;
      },
    },
    view(editorView) {
      // Attach the contextmenu listener at the editor-DOM level in
      // CAPTURE phase rather than through PM's `handleDOMEvents.
      // contextmenu`. Why: each atom NodeView (wikilink, tag, embed,
      // …) uses `stopEvent: () => true` to keep PM from trying to
      // cursor-position inside the atom. That same stopEvent return
      // value also suppresses PM's plugin-level handleDOMEvents
      // dispatch for events originating inside the NodeView, which
      // means a plugin-level `handleDOMEvents.contextmenu` would
      // NEVER fire for right-clicks on atoms.
      //
      // A capture-phase DOM listener runs before any bubble-phase
      // handlers (including PM's internal dispatch) and sees every
      // contextmenu event in the editor, regardless of stopEvent.
      const onContextMenu = (event: MouseEvent) => {
        // Mobile long-press fires `contextmenu` mid-selection - skip
        // and let the platform handle the gesture natively.
        if (Platform.isMobile) return;
        // Read-only license gate: inline-atom edit panels mutate the
        // doc, so they're disabled when PM is non-editable.
        if (!editorView.editable) return;
        const target = event.target;
        if (!(target instanceof Element)) return;

        // External link mark - separate detection path from the
        // atom selector since the link mark renders as a plain
        // `<a>` (not a special node type). Handles its own menu +
        // edit panel below.
        const linkAnchor = target.closest<HTMLAnchorElement>(
          ".butter-external-link",
        );
        if (linkAnchor) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          showExternalLinkMenu(app, editorView, event, linkAnchor);
          return;
        }

        const atomDOM = target.closest(ATOM_DOM_SELECTOR);
        if (!atomDOM) return;

        const posInfo = editorView.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!posInfo) return;
        // Atoms have nodeSize 1, so doc.nodeAt(pos) returns the atom
        // when pos is at the atom's start. posAtCoords sometimes
        // returns JUST BEFORE or JUST AFTER the atom - check both
        // neighbors.
        let pos = posInfo.pos;
        let node = editorView.state.doc.nodeAt(pos);
        if (!node || !(node.type.name in SPECS)) {
          const before = pos > 0 ? editorView.state.doc.nodeAt(pos - 1) : null;
          const after = editorView.state.doc.nodeAt(pos + 1);
          if (before && before.type.name in SPECS) {
            pos = pos - 1;
            node = before;
          } else if (after && after.type.name in SPECS) {
            pos = pos + 1;
            node = after;
          }
        }
        if (!node || !(node.type.name in SPECS)) return;

        const spec = SPECS[node.type.name];
        // Block the default browser menu + any other PM plugin's
        // contextmenu handler (the core formatting menu) - we're
        // handling this click.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const capturedNode = node;
        const capturedPos = pos;
        const capturedAtomDOM = atomDOM;

        // Wikilinks use the unified rich-context-menu (header + inline
        // Note/Name inputs + nav actions + Clear link). Editing is the
        // menu - no separate "Edit wikilink" submenu / floating panel.
        if (capturedNode.type.name === "wikilink") {
          openWikilinkContextMenu(
            app,
            editorView,
            capturedPos,
            capturedNode,
            event,
            capturedAtomDOM as HTMLElement,
          );
          return;
        }

        // Other inline atoms still use the legacy "menu with Edit
        // <atom> item that opens a separate floating panel" - those
        // types haven't been migrated yet (tag / embed / math /
        // footnote ref / inline footnote).
        const menu = new Menu();
        applyBlockContextMenuChrome(menu, {
          icon: ATOM_ICONS[capturedNode.type.name] || "type",
          title: spec.label,
          sub: atomHeaderSub(capturedNode, spec),
        });

        menu.addItem((item) =>
          item
            .setTitle(`Edit ${spec.label.toLowerCase()}`)
            .setIcon("pencil")
            .onClick(() => {
              openEditor(
                app,
                editorView,
                capturedPos,
                capturedNode,
                capturedAtomDOM,
              );
            }),
        );

        menu.showAtMouseEvent(event);
      };

      editorView.dom.addEventListener("contextmenu", onContextMenu, true);

      return {
        destroy() {
          editorView.dom.removeEventListener(
            "contextmenu",
            onContextMenu,
            true,
          );
          // If the editor tears down while an edit panel is open,
          // invoke its close() so the document-mousedown capture-phase
          // listener installed at open time gets unbound. Just removing
          // the DOM leaves that listener leaked, accumulating one per
          // panel-then-view-close cycle.
          const state = key.getState(editorView.state);
          if (state?.close) {
            try { state.close(); } catch { /* swallowed */ }
          }
          // Belt-and-braces: yank any orphan DOM as well.
          activeDocument.querySelectorAll(".butter-inline-atom-edit").forEach((el) => {
            if (el.instanceOf(HTMLElement)) el.remove();
          });
        },
      };
    },
  });
}

// Re-exports for tests + debug.
export const inlineAtomEditKey = key;
