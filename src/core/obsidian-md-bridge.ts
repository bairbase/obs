/**
 * obsidian-md-bridge.ts
 *
 * Purpose-built ProseMirror ↔ markdown-it bridge for Obsidian.
 * Replaces prosemirror-markdown with a single module that owns:
 *
 *   - Parser: markdown-it tokens → PM tree, with source ranges
 *     attached to every block + inline-atom node during the walk.
 *   - Serializer: PM tree → markdown, canonical synthesis for all
 *     schema constructs without bracket/escape workarounds.
 *   - Source preservation: serializeWithSourcePreservation splices
 *     original bytes for unedited nodes (reference identity against
 *     the parse-time doc) and synthesizes only the rest.
 *   - Error recovery: parse failures + byte-coverage gaps fall
 *     through to a whole-file raw_block so bytes are never lost.
 *   - Incremental parse: in-block edits reparse only the affected
 *     block, preserving sibling references.
 *   - Extension wiring: reads the registry in ./extensions via a
 *     late-apply hook that lands runtime additions in the live
 *     handler tables.
 *
 * See EXTENSIONS.md + the invariant / benchmark / preservation
 * tests under ../ for end-to-end coverage.
 */

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/** Token.meta is typed `any` in markdown-it. We attach our own
 *  Obsidian-syntax data to it via the syntax plugins, so the read
 *  side narrows through this helper. */
function metaStr(t: Token, key: string): string {
  const m = t.meta as Record<string, unknown> | null | undefined;
  const v = m ? m[key] : undefined;
  return typeof v === "string" ? v : "";
}
import {
  Node as PMNode,
  Fragment,
  Mark,
  MarkType,
  NodeType,
} from "prosemirror-model";
import { schema } from "./schema";
import { installObsidianPlugins } from "./syntax-obsidian";
import {
  setBridgeLateApplyHandler,
  type ButterSyntaxExtension,
} from "../integration/extensions";
import { debug } from "../integration/debug";

// ═══════════════════════════════════════════════
//  Shared markdown-it instance
// ═══════════════════════════════════════════════

const md = new MarkdownIt("commonmark", { html: false })
  .enable("strikethrough")
  .enable("table");
installObsidianPlugins(md);
export const __mdit = md;
// Extension markdown-it rules are applied via the late-apply hook
// below (both for pre-registered extensions at bridge-init AND for
// any extensions registered at runtime after the bridge loads).

// ═══════════════════════════════════════════════
//  PARSER: markdown-it tokens -> ProseMirror doc
// ═══════════════════════════════════════════════

interface StackFrame {
  type: NodeType;
  attrs: Record<string, unknown>;
  content: PMNode[];
}

type TokenHandler = (state: ParseState, tok: Token) => void;

class ParseState {
  stack: StackFrame[];
  marks: readonly Mark[];

  // ── Source-preservation context (optional; null in plain parse) ──
  // When the parser is driven with source-map context, these fields
  // let push()/addNode() auto-attach a sourceRange attr to each
  // created node based on the token being processed. The main loop
  // keeps `currentTokIdx` pointing at the active token so handlers
  // don't need to know about source ranges - the ParseState threads
  // it through on their behalf.
  tokens: Token[] | null = null;
  lineStarts: number[] | null = null;
  totalLen = 0;
  currentTokIdx = -1;

  // ── Flat-list context ──
  // Tracks the markdown-it bullet_list/ordered_list nesting we're
  // currently inside, so list_item_open can stamp the right `kind`,
  // `depth`, `tight`, and `start` attrs on each emitted list_item PM
  // node. The container nodes themselves are NEVER pushed onto the PM
  // build stack - list_items live as siblings at top level (or inside
  // any "block" container), with depth carried as an attr.
  //
  // `listItemOpen` mirrors whether a list_item is currently the top
  // of the build stack. Set true on list_item_open, false on
  // list_item_close - and ALSO false when a nested bullet_list /
  // ordered_list opens inside an item (which auto-closes the item so
  // the nested-deeper list_items become flat siblings rather than
  // structural children).
  listStack: Array<{
    kind: "bullet" | "ordered";
    depth: number;
    start: number;
    firstEmitted: boolean;
  }> = [];
  listItemOpen = false;
  // Saves of (listStack, listItemOpen) pairs pushed when entering a
  // "block container" that's not itself a list (callout, blockquote,
  // and structurally any other `block+` host). Restored on the
  // matching close. Lists inside such a container start fresh at
  // depth=0, independent of the outer list nesting.
  listStackSaves: Array<{
    stack: ParseState["listStack"];
    itemOpen: boolean;
  }> = [];

  constructor() {
    this.stack = [{ type: schema.nodes.doc, attrs: {}, content: [] }];
    this.marks = Mark.none;
  }

  top(): StackFrame {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Source range of the *currently-processing* token.
   *
   * - For an "open" token (nesting === 1), walk forward until the
   *   matching close at the same level and take the close's endLine.
   * - For a self-closing block token (nesting === 0), use tok.map
   *   directly - markdown-it already gives the full line range.
   * - For any token without .map (including inline sub-tokens walked
   *   via the `inline` container), return null - we don't synthesize
   *   positions, we only preserve ones the tokenizer gave us.
   */
  private currentRange(): { start: number; end: number } | null {
    if (!this.tokens || !this.lineStarts || this.currentTokIdx < 0) return null;
    const tok = this.tokens[this.currentTokIdx];
    if (!tok?.map) return null;

    const lineToOffset = (line: number): number =>
      line < this.lineStarts!.length ? this.lineStarts![line] : this.totalLen;

    if (tok.nesting === 0) {
      return { start: lineToOffset(tok.map[0]), end: lineToOffset(tok.map[1]) };
    }
    if (tok.nesting === 1) {
      // Scan forward at the same nesting level for the matching close.
      //
      // Special case: for `list_item_open`, the flat-list parser
      // emits the OUTER item as a top-level sibling of any nested
      // list_items inside it. The outer item's source range must
      // therefore END before the nested list begins, otherwise the
      // outer item's range OVERLAPS the nested items' ranges, the
      // coverage check trips on backward gaps, and parseWithSourceMap
      // bails to raw_block. Stop at the first nested
      // `bullet_list_open` / `ordered_list_open` we encounter inside
      // the item - its `tok.map[0]` becomes our end line.
      const isListItem = tok.type === "list_item_open";
      let depth = 1;
      let endLine = tok.map[1];
      for (let j = this.currentTokIdx + 1; j < this.tokens.length; j++) {
        const t = this.tokens[j];
        if (
          isListItem &&
          (t.type === "bullet_list_open" || t.type === "ordered_list_open") &&
          t.map
        ) {
          // Check we're still inside the item (not in a nested
          // callout/blockquote that's already opened a separate
          // list - those don't auto-promote to siblings).
          // The simple `level` heuristic: nested-list-inside-item
          // tokens are at level+2 (item level + paragraph_close +
          // bullet_list_open) - actually markdown-it's `level` is
          // structural. The first nested ul/ol at a level > tok.level
          // before the matching close is what we want.
          if (t.level > tok.level) {
            endLine = t.map[0];
            break;
          }
        }
        if (t.level !== tok.level) continue;
        if (t.nesting === 1) depth++;
        else if (t.nesting === -1) {
          depth--;
          if (depth === 0) {
            endLine = t.map?.[1] ?? endLine;
            break;
          }
        }
      }
      return { start: lineToOffset(tok.map[0]), end: lineToOffset(endLine) };
    }
    return null;
  }

  /** Merge the current token's sourceRange into attrs (if any). */
  private withRange(attrs: Record<string, unknown>): Record<string, unknown> {
    const r = this.currentRange();
    return r ? { ...attrs, sourceRange: r } : attrs;
  }

  push(type: NodeType, attrs: Record<string, unknown> = {}) {
    this.stack.push({ type, attrs: this.withRange(attrs), content: [] });
  }

  pop(): PMNode {
    const { type, attrs, content } = this.stack.pop()!;
    const node = this.buildNode(type, attrs, content);
    if (this.stack.length) this.top().content.push(node);
    return node;
  }

  addNode(type: NodeType, attrs: Record<string, unknown> = {}) {
    const finalAttrs = this.withRange(attrs);
    const node = this.buildNode(type, finalAttrs, []);
    // Apply active marks (set by inline mark open tokens) to the
    // created node. Without this, an inline atom (wikilink, tag,
    // math, embed, footnote ref/inline, block id, image) inside an
    // emphasis / strong / highlight range loses the surrounding
    // mark. The serializer then opens-then-closes the mark across
    // the atom - emitting `*foo *[[link]]* bar*` instead of `*foo
    // [[link]] bar*` - and the round-trip diverges.
    //
    // For block-level addNode calls (math_block, block_comment,
    // obsidian_embed, footnote_def), `this.marks` is empty (marks
    // are only opened inside `inline` token walks), so this is a
    // no-op for blocks. Only inline atoms inside marked ranges see
    // any change.
    const marked = this.marks.length > 0 ? node.mark(this.marks) : node;
    this.top().content.push(marked);
  }

  /**
   * Create a PM node with the given type / attrs / provided content.
   *
   * PM's `createAndFill` invokes `ContentMatch.fillBefore` under the
   * hood to satisfy the type's content spec when the provided content
   * is insufficient. On a schema with ~30 block types like ours, the
   * recursive search can blow the Electron stack (smaller than Node's)
   * for certain shapes - typically empty containers whose spec is
   * `block+`. The ordinary stack trace looks like:
   *
   *   RangeError: Maximum call stack size exceeded
   *     at ContentMatch.matchFragment
   *     at search
   *     at ContentMatch.fillBefore
   *     at NodeType.createAndFill
   *     at eval (map)
   *     at search (recursive)
   *     ...
   *
   * Defensive strategy:
   *   1. Try `createAndFill` normally - the common case.
   *   2. If it throws (stack overflow) or returns null (spec not
   *      satisfiable with the given content), fall back to injecting
   *      a single empty paragraph and retrying. Nearly every block
   *      container in our schema accepts `paragraph` as a valid first
   *      child, and `paragraph` content spec `inline*` satisfies
   *      without recursion.
   *   3. Last resort: `type.create()` with whatever content we have.
   *      May produce a schema-invalid node that the renderer can
   *      still mount; better than crashing the parse entirely and
   *      dropping the user's whole file into a raw_block fallback.
   */
  private buildNode(
    type: NodeType,
    attrs: Record<string, unknown>,
    content: PMNode[],
  ): PMNode {
    const fragment = Fragment.fromArray(content);
    const paraType = schema.nodes.paragraph;

    // Empty-content fast path. We split by whether the type's
    // content spec accepts an empty fragment as a valid end state
    // (e.g., `block*`, `text*`, `inline*` - true; `block+` - false):
    //   • Accepts empty: just create with empty content. Avoids
    //     fillBefore's recursive search entirely. Required for
    //     `obsidian_callout` (now `block*`) where an empty body
    //     is the legitimate "title-only" state - paragraph fill
    //     would actively introduce wrong content.
    //   • Doesn't accept empty: pre-emptive paragraph fill. PM's
    //     `createAndFill` would otherwise call `ContentMatch
    //     .fillBefore`, whose search recurses through block types
    //     and on a schema with many `block+` containers blows the
    //     Electron stack. Injecting a paragraph upfront short-
    //     circuits the search.
    if (content.length === 0) {
      const acceptsEmpty = type.contentMatch.validEnd;
      if (acceptsEmpty) {
        const node = type.create(attrs, Fragment.empty);
        return node;
      }
      if (paraType && type !== paraType) {
        try {
          const node = type.createAndFill(
            attrs,
            Fragment.fromArray([paraType.create(null)]),
          );
          if (node) return node;
        } catch { /* fall through to standard createAndFill */ }
      }
    }

    try {
      const node = type.createAndFill(attrs, fragment);
      if (node) return node;
    } catch (err) {
      debug(
        "parse",
        `buildNode: createAndFill threw on ${type.name}, trying paragraph fill`,
        err,
      );
    }
    if (content.length === 0 && paraType) {
      try {
        const node = type.createAndFill(
          attrs,
          Fragment.fromArray([paraType.create(null)]),
        );
        if (node) {
          debug("parse", `buildNode: recovered ${type.name} via paragraph fill`);
          return node;
        }
      } catch (err) {
        debug(
          "parse",
          `buildNode: paragraph fill also threw on ${type.name}`,
          err,
        );
      }
    }
    debug(
      "parse",
      `buildNode: last-resort type.create on ${type.name} (may be schema-invalid)`,
    );
    return type.create(attrs, fragment);
  }

  addText(text: string) {
    if (!text) return;
    const nodes = this.top().content;
    const last = nodes[nodes.length - 1];
    if (last?.isText && Mark.sameSet(last.marks, this.marks)) {
      nodes[nodes.length - 1] = schema.text(last.text! + text, this.marks);
    } else {
      nodes.push(schema.text(text, this.marks));
    }
  }

  openMark(type: MarkType, attrs: Record<string, unknown> = {}) {
    this.marks = type.create(attrs).addToSet(this.marks);
  }

  closeMark(type: MarkType) {
    this.marks = type.removeFromSet(this.marks);
  }
}

// ── helpers ──

function stripTrailingNL(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

function cellAlign(tok: Token): string | null {
  const m = (tok.attrGet("style") || "").match(/text-align:\s*(\w+)/);
  return m ? m[1] : null;
}

// ── token handler table ──

function buildHandlers(): Record<string, TokenHandler> {
  const h: Record<string, TokenHandler> = {};

  // ── Flat-list helpers ──
  //
  // `autoCloseDirectItem` - pop the open list_item if it's the
  // current PM stack top. Called when a sibling list_item or a
  // sibling/nested ul/ol opens, OR when a containing block (like a
  // callout) closes. The "directly on stack top" check matters: if
  // the item has a sub-container (callout, blockquote) inside, the
  // top is THAT, not the item, and we must not pop the wrong node.
  //
  // `enterBlockContainer` / `leaveBlockContainer` - save and reset
  // the flat-list parsing context so any list that opens INSIDE a
  // block container (callout, blockquote, table cell) starts at
  // depth=0. Without this, a list inside a callout that's inside an
  // outer item would inherit depth=1 and produce visually-wrong
  // indentation when serialized.
  const autoCloseDirectItem = (s: ParseState) => {
    if (s.listItemOpen && s.top().type.name === "list_item") {
      s.pop();
      s.listItemOpen = false;
    }
  };
  const enterBlockContainer = (s: ParseState) => {
    s.listStackSaves.push({ stack: s.listStack, itemOpen: s.listItemOpen });
    s.listStack = [];
    s.listItemOpen = false;
  };
  const leaveBlockContainer = (s: ParseState) => {
    const saved = s.listStackSaves.pop();
    if (saved) {
      s.listStack = saved.stack;
      s.listItemOpen = saved.itemOpen;
    }
  };

  // Block open/close pairs
  h.blockquote_open = (s) => {
    s.push(schema.nodes.blockquote);
    enterBlockContainer(s);
  };
  h.blockquote_close = (s) => {
    autoCloseDirectItem(s);
    leaveBlockContainer(s);
    s.pop();
  };
  h.paragraph_open = (s) => s.push(schema.nodes.paragraph);
  h.paragraph_close = (s) => s.pop();
  h.heading_open = (s, t) =>
    s.push(schema.nodes.heading, { level: +t.tag.slice(1) });
  h.heading_close = (s) => s.pop();
  // ── Flat list handlers ──
  //
  // markdown-it produces standard nested ul/ol/li tokens. We collapse
  // those into a flat sequence of `list_item` PM nodes carrying `kind`
  // + `depth` attrs - Notion's model. The containers leave NO nodes in
  // the doc; they only push a context onto `s.listStack` so the next
  // list_item_open can stamp the right attrs.
  //
  // Auto-close: when a nested ul/ol opens DIRECTLY inside an open
  // list_item (PM stack top IS the item), we pop the parent item
  // before pushing the nested list's context. The parent's content
  // (paragraph + any non-list blocks before the nested list) is
  // committed; the nested items become flat siblings at higher depth.
  //
  // The "directly inside" check matters: if the nested list opens
  // inside a callout or blockquote that's inside the item, the item
  // is NOT the stack top (the callout/blockquote is), and we MUST
  // NOT auto-close - the nested list belongs to the callout's body,
  // not as a sibling of the outer item. The callout/blockquote
  // handlers separately save and reset `listStack` so depth restarts
  // at 0 inside the new container.
  h.bullet_list_open = (s) => {
    autoCloseDirectItem(s);
    s.listStack.push({
      kind: "bullet",
      depth: s.listStack.length,
      start: 1,
      firstEmitted: false,
    });
  };
  h.bullet_list_close = (s) => {
    autoCloseDirectItem(s);
    s.listStack.pop();
  };
  h.ordered_list_open = (s, t) => {
    autoCloseDirectItem(s);
    s.listStack.push({
      kind: "ordered",
      depth: s.listStack.length,
      start: +(t.attrGet("start") || 1),
      firstEmitted: false,
    });
  };
  h.ordered_list_close = (s) => {
    autoCloseDirectItem(s);
    s.listStack.pop();
  };
  h.list_item_open = (s) => {
    // Close any sibling list_item still open before opening a new one.
    autoCloseDirectItem(s);
    const ctx = s.listStack[s.listStack.length - 1];
    if (!ctx) {
      // Defensive: list_item without a containing list. Push with
      // defaults so the doc stays well-formed.
      s.push(schema.nodes.list_item, {});
      s.listItemOpen = true;
      return;
    }
    // Only the FIRST item in an ordered run with a non-default start
    // carries the explicit `start` attr; subsequent items count up.
    const isFirst = !ctx.firstEmitted;
    ctx.firstEmitted = true;
    s.push(schema.nodes.list_item, {
      kind: ctx.kind,
      depth: ctx.depth,
      tight: true,
      start:
        isFirst && ctx.kind === "ordered" && ctx.start !== 1
          ? ctx.start
          : null,
    });
    s.listItemOpen = true;
  };
  h.list_item_close = (s) => {
    if (s.listItemOpen) {
      s.pop();
      s.listItemOpen = false;
    }
  };
  h.table_open = (s) => s.push(schema.nodes.table);
  h.table_close = (s) => s.pop();
  h.tr_open = (s) => s.push(schema.nodes.table_row);
  h.tr_close = (s) => s.pop();
  h.th_open = (s, t) =>
    s.push(schema.nodes.table_header, { alignment: cellAlign(t) });
  h.th_close = (s) => s.pop();
  h.td_open = (s, t) =>
    s.push(schema.nodes.table_cell, { alignment: cellAlign(t) });
  h.td_close = (s) => s.pop();

  // Ignored wrappers
  h.thead_open = h.thead_close = h.tbody_open = h.tbody_close = () => {};

  // Callouts - block container; lists inside start fresh.
  h.obsidian_callout_open = (s, t) => {
    s.push(schema.nodes.obsidian_callout, {
      calloutType: metaStr(t, "calloutType") || "note",
      title: metaStr(t, "title") || "",
      foldState: metaStr(t, "foldState") || "",
    });
    enterBlockContainer(s);
  };
  h.obsidian_callout_close = (s) => {
    autoCloseDirectItem(s);
    leaveBlockContainer(s);
    s.pop();
  };

  // Self-closing blocks
  h.fence = (s, t) => {
    s.push(schema.nodes.code_block, { language: t.info || "" });
    s.addText(stripTrailingNL(t.content));
    s.pop();
  };
  h.code_block = (s, t) => {
    s.push(schema.nodes.code_block);
    s.addText(stripTrailingNL(t.content));
    s.pop();
  };
  h.hr = (s) => s.addNode(schema.nodes.horizontal_rule);

  // Leaf block nodes
  h.math_block = (s, t) =>
    s.addNode(schema.nodes.math_block, { value: t.content });
  h.block_comment = (s, t) =>
    s.addNode(schema.nodes.block_comment, { value: t.content });
  h.obsidian_embed = (s, t) =>
    s.addNode(schema.nodes.obsidian_embed, { src: t.content });
  h.footnote_def = (s, t) =>
    s.addNode(schema.nodes.footnote_def, {
      label: metaStr(t, "label"),
      content: t.content,
    });

  // Inline container.
  //
  // markdown-it's "inline" token wraps the entire inline content of
  // a block. It has a line-range `.map` pointing at the block's
  // entire source span. If we let that range leak through to inline
  // children during the handler iteration, every softbreak / embed /
  // inline atom added via `addNode` would inherit `sourceRange =
  // {start: block.start, end: block.end}` via the usual
  // `withRange` merge - and the preservation hook in SerState would
  // later emit the WHOLE paragraph's bytes every time it encountered
  // one of those atoms. Nasty source-duplication bug.
  //
  // Suppress the outer range while iterating inline children by
  // stashing currentTokIdx to -1 (which makes currentRange() return
  // null). Atoms that need a specific sourceRange (wikilinks, tags,
  // inline math, etc.) still get one later via
  // populateInlineSourceRanges's pattern search. Atoms that don't
  // have a source pattern (softbreak, hardbreak) correctly end up
  // with `sourceRange: null` and the preservation hook skips them.
  h.inline = (s, t) => {
    if (!t.children) return;
    const savedIdx = s.currentTokIdx;
    s.currentTokIdx = -1;
    try {
      for (const c of t.children) {
        const fn = handlers[c.type];
        if (fn) fn(s, c);
      }
    } finally {
      s.currentTokIdx = savedIdx;
    }
  };

  // Inline marks (open/close)
  h.strong_open = (s) => s.openMark(schema.marks.strong);
  h.strong_close = (s) => s.closeMark(schema.marks.strong);
  h.em_open = (s) => s.openMark(schema.marks.em);
  h.em_close = (s) => s.closeMark(schema.marks.em);
  h.s_open = (s) => s.openMark(schema.marks.strikethrough);
  h.s_close = (s) => s.closeMark(schema.marks.strikethrough);
  h.highlight_open = (s) => s.openMark(schema.marks.highlight);
  h.highlight_close = (s) => s.closeMark(schema.marks.highlight);
  h.obsidian_comment_open = (s) => s.openMark(schema.marks.comment);
  h.obsidian_comment_close = (s) => s.closeMark(schema.marks.comment);

  // Common inline HTML tags. Each becomes a PM mark; <font> carries
  // attrs (color/face/size). <mark> aliases to the existing highlight
  // mark - visually equivalent, serializes back as `<mark>` since
  // that's how it was authored.
  h.html_font_open = (s, t) => {
    const attrs: Record<string, string> = { color: "", face: "", size: "" };
    for (const [name, value] of (t.attrs) ?? []) {
      if (name === "color" || name === "face" || name === "size") {
        attrs[name] = value;
      }
    }
    s.openMark(schema.marks.font, attrs);
  };
  h.html_font_close = (s) => s.closeMark(schema.marks.font);
  h.html_underline_open = (s) => s.openMark(schema.marks.underline);
  h.html_underline_close = (s) => s.closeMark(schema.marks.underline);
  h.html_sup_open = (s) => s.openMark(schema.marks.superscript);
  h.html_sup_close = (s) => s.closeMark(schema.marks.superscript);
  h.html_sub_open = (s) => s.openMark(schema.marks.subscript);
  h.html_sub_close = (s) => s.closeMark(schema.marks.subscript);
  h.html_kbd_open = (s) => s.openMark(schema.marks.kbd);
  h.html_kbd_close = (s) => s.closeMark(schema.marks.kbd);
  // <mark> opens the highlight mark. We deliberately DON'T set the
  // `html: true` attr here - the form choice is cosmetic, and keeping
  // the attr breaks round-trip when overlap forces HTML form:
  // a doc with `==` highlight (html=false) serializes as `<mark>`,
  // re-parses as html=true, mark.eq() fails, save guard fires.
  // Dropping the flag means a user-authored `<mark>` source normalizes
  // to `==` on first save - one-time, same shape as Butter's other
  // first-save normalizations.
  h.html_mark_open = (s, t) => {
    // `<mark>` opens highlight. When the tag carries `style="background-
    // color: …"`, capture that color so the user's custom highlight
    // colour survives round-trip. Whitespace + casing on the property
    // name are normalised; both `background` and `background-color`
    // are accepted because Obsidian's own MarkdownRenderer treats the
    // shorthand as the highlight colour.
    let color: string | null = null;
    for (const [name, value] of (t.attrs) ?? []) {
      if (name === "style") {
        const m = /background(?:-color)?\s*:\s*([^;]+)/i.exec(value);
        if (m) color = m[1].trim();
      }
    }
    // We deliberately DON'T set the `html: true` attr (form choice is
    // cosmetic for plain highlights; see longer rationale in the
    // serializer notes). Color, when present, forces HTML form on
    // serialize regardless.
    s.openMark(schema.marks.highlight, color ? { color } : undefined);
  };
  h.html_mark_close = (s) => s.closeMark(schema.marks.highlight);
  // <strong> / <em> map to the same PM marks as `**` / `*`. The
  // serializer emits these HTML forms only when a mark instance
  // overlaps another mark in the same paragraph (CommonMark emphasis
  // pairs require strict nesting; HTML tags survive cross-overlap via
  // the any-match close rule in htmlInlineTagsPlugin). On parse, both
  // forms produce identical PM marks - there's no `html` attr because
  // the serializer recomputes overlap each time, so the form choice
  // re-emerges from the doc structure rather than being persisted.
  h.html_strong_open = (s) => s.openMark(schema.marks.strong);
  h.html_strong_close = (s) => s.closeMark(schema.marks.strong);
  h.html_em_open = (s) => s.openMark(schema.marks.em);
  h.html_em_close = (s) => s.closeMark(schema.marks.em);
  // <s> and <del> both open the strikethrough mark (HTML5 treats
  // them with subtly different semantics, but we collapse to one
  // PM mark for simplicity - the serializer always emits <s> on
  // overlap). Without these handlers, a serialized `<s>...</s>`
  // round-trips as literal text inside whatever surrounded it.
  h.html_s_open = (s) => s.openMark(schema.marks.strikethrough);
  h.html_s_close = (s) => s.closeMark(schema.marks.strikethrough);
  h.html_del_open = (s) => s.openMark(schema.marks.strikethrough);
  h.html_del_close = (s) => s.closeMark(schema.marks.strikethrough);
  h.link_open = (s, t) =>
    s.openMark(schema.marks.link, {
      href: t.attrGet("href"),
      title: t.attrGet("title") || null,
    });
  h.link_close = (s) => s.closeMark(schema.marks.link);

  // code_inline: single token -> open mark, add text, close mark
  h.code_inline = (s, t) => {
    s.openMark(schema.marks.code);
    s.addText(t.content);
    s.closeMark(schema.marks.code);
  };

  // Inline leaf nodes
  // Heading-internal hard/soft breaks (from setext-style multi-line
  // headings like `text\ntext\n---`) collapse to a single space.
  // Multi-line heading content otherwise re-parses as a heading + a
  // paragraph after one save cycle and trips the round-trip guard:
  // ATX serialization (`## ` + inline) emits the embedded newline
  // verbatim, then `## first\nsecond` re-parses as h2 + paragraph.
  // Collapsing at parse time keeps the doc's inline shape stable.
  h.hardbreak = (s) => {
    if (s.top().type.name === "heading") s.addText(" ");
    else s.addNode(schema.nodes.hard_break);
  };
  h.softbreak = (s) => {
    if (s.top().type.name === "heading") s.addText(" ");
    else s.addNode(schema.nodes.softbreak);
  };
  h.text = (s, t) => {
    // Inside a table cell, GFM convention encodes a cell-internal
    // line break as `<br>` (LP and Reading mode use this; our cell
    // serializer also emits `<br>` for softbreaks/hardbreaks). Our
    // markdown-it instance is configured `html: false` so `<br>`
    // doesn't tokenize as `html_inline` - it stays as part of a
    // `text` token. Detect it here when we're parsing inline
    // content inside a `table_header` / `table_cell` and split on
    // the `<br>` markers, inserting softbreak nodes between
    // segments. Round-trip then preserves the user's Shift+Enter.
    const topName = s.top().type.name;
    const inCell = topName === "table_cell" || topName === "table_header";
    if (inCell && /<br\s*\/?>/i.test(t.content)) {
      const parts = t.content.split(/<br\s*\/?>/i);
      parts.forEach((part, i) => {
        if (i > 0) s.addNode(schema.nodes.softbreak);
        if (part) s.addText(part);
      });
      return;
    }
    s.addText(t.content);
  };

  h.image = (s, t) => {
    const rawAlt: string = t.children?.[0]?.content ?? "";
    // `|full` (case-insensitive) marks Butter's full-column-width
    // display mode. Lives in the same alt-suffix slot as `|WIDTH`
    // so it survives round-trip through any Obsidian-aware parser.
    // Non-Butter renderers see "alt|full" as alt text - image still
    // shows, just at natural size.
    const fullMatch = rawAlt.match(/^(.*?)\|full$/i);
    if (fullMatch) {
      s.addNode(schema.nodes.image, {
        src: t.attrGet("src"),
        alt: fullMatch[1] || null,
        title: t.attrGet("title") || null,
        width: null,
        height: null,
        displayMode: "full",
      });
      return;
    }
    const m = rawAlt.match(/^(.*?)\|(\d+)(?:x(\d+))?$/);
    s.addNode(schema.nodes.image, m
      ? {
          src: t.attrGet("src"), alt: m[1] || null,
          title: t.attrGet("title") || null,
          width: parseInt(m[2], 10),
          height: m[3] ? parseInt(m[3], 10) : null,
          displayMode: null,
        }
      : {
          src: t.attrGet("src"), alt: rawAlt || null,
          title: t.attrGet("title") || null,
          width: null, height: null,
          displayMode: null,
        });
  };

  h.wikilink = (s, t) =>
    s.addNode(schema.nodes.wikilink, {
      target: metaStr(t, "target") || t.content,
      alias: metaStr(t, "alias"),
    });
  h.obsidian_tag = (s, t) =>
    s.addNode(schema.nodes.obsidian_tag, { tag: t.content });
  h.inline_math = (s, t) =>
    s.addNode(schema.nodes.inline_math, { value: t.content });
  h.obsidian_embed_inline = (s, t) =>
    s.addNode(schema.nodes.obsidian_embed_inline, { src: t.content });
  h.inline_footnote = (s, t) =>
    s.addNode(schema.nodes.inline_footnote, { content: t.content });
  h.footnote_ref = (s, t) =>
    s.addNode(schema.nodes.footnote_ref, { label: t.content });
  h.block_id = (s, t) =>
    s.addNode(schema.nodes.block_id, { id: t.content });

  return h;
}

// Mutable handler table - extension handlers are added via the
// late-apply hook registered below, which fires both for
// pre-bridge-init registrations (catchup) and for runtime ones.
const handlers: Record<string, TokenHandler> = { ...buildHandlers() };

// ── Task-list post-processing ──

// Matches the task-item marker at the start of a list item's first
// paragraph. Accepts EITHER `[X] content` (the GFM-canonical form
// with whitespace after the bracket-pair) OR `[X]` at end of string
// (an EMPTY task item - common when the user just toggled a list
// to tasks via `- [ ]` and hasn't typed anything yet). Without the
// `|$` alternative, an empty task item round-trips as a regular
// bullet with literal text `[ ]`, which the fingerprint check
// catches as structural drift and the save guard refuses.
// `m[0]` consumes both the bracket-pair AND the trailing whitespace
// run so removePrefixFromParagraph trims them as a single chunk.
const TASK_RE = /^\[([ xX])\](\s+|$)/;

function removePrefixFromParagraph(para: PMNode, n: number): PMNode {
  const children: PMNode[] = [];
  let remaining = n;
  para.forEach((child) => {
    if (remaining <= 0) { children.push(child); return; }
    if (child.isText) {
      const text = child.text ?? "";
      if (text.length <= remaining) { remaining -= text.length; return; }
      children.push(schema.text(text.slice(remaining), child.marks));
      remaining = 0;
      return;
    }
    children.push(child);
    remaining = 0;
  });
  return para.type.create(para.attrs, Fragment.fromArray(children), para.marks);
}

function transformTaskItems(node: PMNode): PMNode {
  let changed = false;
  const mapped: PMNode[] = [];
  node.forEach((child) => {
    const next = transformTaskItems(child);
    if (next !== child) changed = true;
    mapped.push(next);
  });
  const base = changed
    ? node.type.create(node.attrs, Fragment.fromArray(mapped), node.marks)
    : node;
  if (base.type.name !== "list_item") return base;
  const first = base.firstChild;
  if (!first || first.type.name !== "paragraph") return base;
  const m = first.textContent.match(TASK_RE);
  if (!m) return base;
  const checked = m[1].toLowerCase() === "x";
  const newFirst = removePrefixFromParagraph(first, m[0].length);
  const newChildren: PMNode[] = [newFirst];
  for (let i = 1; i < base.childCount; i++) newChildren.push(base.child(i));
  // Promote bullet → task when we detect the `[ ]` / `[x]` prefix.
  // (markdown-it parses task list items as plain bullet items; the
  // bracket prefix tells us they're really tasks.)
  return base.type.create(
    { ...base.attrs, kind: "task", checked },
    Fragment.fromArray(newChildren),
    base.marks,
  );
}

// ── Public parse ──

function parse(markdown: string): PMNode | null {
  const tokens = md.parse(markdown, {});
  const state = new ParseState();
  // No source-map context - nodes get no sourceRange attrs.
  for (let i = 0; i < tokens.length; i++) {
    state.currentTokIdx = i;
    const tok = tokens[i];
    const fn = handlers[tok.type];
    if (fn) fn(state, tok);
  }
  while (state.stack.length > 1) state.pop();
  const doc = state.pop();
  return transformTaskItems(doc);
}

/**
 * Source-preserving parse: returns the PM doc AND character-offset
 * ranges for every top-level block - captured in a single pass over
 * the token stream, not bolted on after.
 *
 * Each range is extended to cover the inter-block whitespace that
 * follows it, so `originalBody.slice(range.start, range.end)` for
 * every range concatenates back to the full body. The first range
 * absorbs any leading content; the last absorbs everything to EOF.
 *
 * `blockRanges.length === doc.childCount` when the parse is clean.
 * Callers should verify this and disable preservation on mismatch.
 */
interface SourceMapResult {
  doc: PMNode;
  blockRanges: Array<{ start: number; end: number }>;
}

/**
 * Wrap a source string in a single raw_block doc so unparseable
 * content still round-trips byte-identically. Used as the error-
 * recovery fallback when parsing throws or produces structural
 * garbage the schema rejects.
 */
function rawBlockFallback(
  markdown: string,
  reason: string,
): SourceMapResult {
  const rawNode = schema.nodes.raw_block.create({
    raw: markdown,
    reason,
    sourceRange: { start: 0, end: markdown.length },
  });
  const doc = schema.nodes.doc.create(null, [rawNode]);
  return { doc, blockRanges: [{ start: 0, end: markdown.length }] };
}

function parseWithSourceMap(markdown: string): SourceMapResult | null {
  try {
    const result = parseWithSourceMapInner(markdown);
    if (result) {
      // Post-parse byte-coverage check: reconstruct the input from the
      // content-only block ranges + the inter-block gap bytes. Any
      // missed byte means the parse lost structural info (common
      // cases: pure-whitespace input yielding an empty paragraph
      // without a token map; HTML blocks emitted in a token shape we
      // don't fully cover). Rather than silently corrupt on save, fall
      // back to a whole-file raw_block - source preservation holds.
      //
      // Reconstruction = leading-whitespace + block[0].content +
      // gap[0,1] + block[1].content + ... + block[n-1].content +
      // trailing-whitespace.
      //   leading  = markdown.slice(0, firstBlock.start)
      //   gap[i,j] = markdown.slice(block[i].end, block[j].start)
      //   trailing = markdown.slice(lastBlock.end, markdown.length)
      let covered = "";
      let coverageOk = true;
      const n = result.doc.childCount;
      if (n === 0) {
        coverageOk = markdown.length === 0;
      } else {
        for (let i = 0; i < n; i++) {
          const r = result.doc.child(i).attrs.sourceRange as
            | { start: number; end: number }
            | null;
          if (!r || r.start < 0 || r.end < r.start || r.end > markdown.length) {
            coverageOk = false;
            break;
          }
          if (i === 0) covered += markdown.slice(0, r.start); // leading
          covered += markdown.slice(r.start, r.end); // content
          if (i < n - 1) {
            const nextR = result.doc.child(i + 1).attrs.sourceRange as
              | { start: number; end: number }
              | null;
            if (!nextR || nextR.start < r.end) {
              coverageOk = false;
              break;
            }
            covered += markdown.slice(r.end, nextR.start); // gap
          } else {
            covered += markdown.slice(r.end, markdown.length); // trailing
          }
        }
      }
      if (!coverageOk || covered !== markdown) {
        console.warn(
          "[butter-pmx] parse did not cover every byte of input",
          {
            inputBytes: markdown.length,
            childCount: result.doc.childCount,
            firstUncoveredIndex: covered.length,
          },
        );
        return rawBlockFallback(
          markdown,
          "parse did not cover every byte of the input",
        );
      }
    }
    return result;
  } catch (err) {
    // Any parse-time exception - markdown-it tokenizer throwing, a
    // handler throwing on a malformed token shape, schema validation
    // refusing to create a node - falls through to a full-file raw
    // block. Bytes preserve verbatim on save; user sees a diagnostic.
    //
    // Log the full stack to the console so the dev can see WHERE the
    // failure happened. Without this, the diagnostic banner only
    // shows name + message, which is rarely enough to debug.
    const errObj = err instanceof Error ? err : new Error(String(err));
    console.error(
      "[butter-pmx] parseWithSourceMap threw - falling back to raw_block. Input length:",
      markdown.length,
    );
    console.error(errObj);
    const reason = `${errObj.name}: ${errObj.message}`;
    return rawBlockFallback(markdown, reason);
  }
}

/**
 * Expected source pattern for an inline atom node. When the atom's
 * attrs match its canonical markdown form (which they do for every
 * construct in Butter's schema - proven by 92/92 round-trip tests),
 * this pattern appears verbatim in the parent block's source bytes.
 * We search for it to recover the atom's byte range for byte-level
 * preservation within edited blocks.
 */
// Extension-registered inline-atom source patterns. Ordered list so
// multiple extensions can contribute patterns for the same node type
// (e.g., two extensions that both render variations of a `mention`
// atom). The lookup iterates in registration order; the first pattern
// that returns a non-null string wins. Falls through to the built-in
// switch after all extensions abstain.
const extensionSourcePatterns: Array<{
  name: string;
  fn: (node: unknown) => string | null;
}> = [];

function inlineAtomPattern(node: PMNode): string | null {
  // Try extension patterns. Each pattern is gated on its registered
  // node type so an extension's pattern fn isn't called for unrelated
  // nodes (which could return a misleading truthy default).
  for (const { name, fn } of extensionSourcePatterns) {
    if (node.type.name !== name) continue;
    try {
      const p = fn(node);
      if (p) return p;
    } catch { /* skip and try the next */ }
  }
  switch (node.type.name) {
    case "wikilink": {
      const target = (node.attrs.target as string) || "";
      const alias = (node.attrs.alias as string) || "";
      return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
    }
    case "obsidian_tag":
      return `#${node.attrs.tag as string}`;
    case "inline_math":
      return `$${node.attrs.value as string}$`;
    case "obsidian_embed_inline":
      return `![[${node.attrs.src as string}]]`;
    case "inline_footnote":
      return `^[${node.attrs.content as string}]`;
    case "footnote_ref":
      return `[^${node.attrs.label as string}]`;
    case "block_id":
      return `^${node.attrs.id as string}`;
    case "image": {
      const src = (node.attrs.src as string) || "";
      const alt = (node.attrs.alt as string) || "";
      const title = (node.attrs.title as string) || "";
      const width = node.attrs.width as number | null;
      const height = node.attrs.height as number | null;
      const displayMode = node.attrs.displayMode as string | null;
      let altStr = alt;
      if (displayMode === "full") {
        altStr = altStr ? `${altStr}|full` : "|full";
      } else if (width) {
        const sizeSuffix = height ? `|${width}x${height}` : `|${width}`;
        altStr = altStr ? `${altStr}${sizeSuffix}` : sizeSuffix;
      }
      return `![${altStr}](${src}${title ? ` "${title}"` : ""})`;
    }
    default:
      return null;
  }
}

/**
 * Post-parse walk: for each inline atom in the doc, find its
 * expected source pattern in the containing block's source bytes
 * and store the character range on the atom's `sourceRange` attr.
 *
 * Order-preserving: advances a cursor through the block's source
 * so two identical patterns (`#tag` + `#tag`) map to their correct
 * positions by appearance order. Falls through gracefully if the
 * pattern isn't found (atom keeps sourceRange: null).
 *
 * Recurses through block containers (callouts, lists, blockquotes,
 * list_items). Each inner textblock is searched within ITS OWN
 * source range, scoped to the block - so an atom in a nested
 * paragraph inside a callout gets the correct absolute byte range.
 */
function populateInlineSourceRanges(
  doc: PMNode,
  originalBody: string,
): PMNode {
  return rebuildForInlineRanges(doc, originalBody);
}

function rebuildForInlineRanges(
  node: PMNode,
  originalBody: string,
): PMNode {
  if (node.isText) return node;

  if (node.isTextblock) {
    return rebuildTextblock(node, originalBody);
  }

  // Container - recurse into children and rebuild if any changed.
  let changed = false;
  const newChildren: PMNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    const next = rebuildForInlineRanges(c, originalBody);
    if (next !== c) changed = true;
    newChildren.push(next);
  }
  if (!changed) return node;
  return node.type.create(
    node.attrs,
    Fragment.fromArray(newChildren),
    node.marks,
  );
}

function rebuildTextblock(
  block: PMNode,
  originalBody: string,
): PMNode {
  const blockRange = block.attrs.sourceRange as
    | { start: number; end: number }
    | null;
  if (!blockRange || blockRange.start < 0 || blockRange.end < blockRange.start)
    return block;

  const blockSource = originalBody.slice(blockRange.start, blockRange.end);
  let cursor = 0;
  let anyChanged = false;
  const newChildren: PMNode[] = [];

  block.forEach((child) => {
    // Text nodes are inline AND `isAtom`-true in PM's model (they're
    // leaves), but their attrs are immutable and `type.create()` on
    // them throws. Filter them out explicitly even though the pattern
    // lookup below should also return null for them.
    if (child.isText || !(child.isInline && child.isAtom)) {
      newChildren.push(child);
      return;
    }
    const pattern = inlineAtomPattern(child);
    if (!pattern) {
      newChildren.push(child);
      return;
    }
    const idx = blockSource.indexOf(pattern, cursor);
    if (idx < 0) {
      newChildren.push(child);
      return;
    }
    const absStart = blockRange.start + idx;
    const absEnd = absStart + pattern.length;
    const prev = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (prev && prev.start === absStart && prev.end === absEnd) {
      newChildren.push(child);
    } else {
      anyChanged = true;
      newChildren.push(
        child.type.create(
          { ...child.attrs, sourceRange: { start: absStart, end: absEnd } },
          child.content,
          child.marks,
        ),
      );
    }
    cursor = idx + pattern.length;
  });

  if (!anyChanged) return block;
  return block.type.create(
    block.attrs,
    Fragment.fromArray(newChildren),
    block.marks,
  );
}

function parseWithSourceMapInner(markdown: string): SourceMapResult | null {
  // Empty / whitespace-only fast path. If we let the ordinary flow
  // run on these inputs, markdown-it produces no tokens ⇒
  // state.stack stays at just the doc frame ⇒ state.pop() calls
  // doc.createAndFill with empty content, which triggers PM's
  // ContentMatch.fillBefore to search for a filling sequence that
  // satisfies `block+`. Against our ~30 block node types that search
  // can recurse until it blows the stack (observed in Electron on
  // new / blank notes). Our buildNode catch recovers, but the
  // synthetic paragraph it inserts has null sourceRange, which the
  // downstream coverage check rejects → whole-file raw_block
  // fallback for what should be a trivial parse.
  //
  // Build the minimal valid doc directly - one empty paragraph with
  // sourceRange {0, length} - no createAndFill recursion possible,
  // coverage check passes trivially. Covers empty, "\n", "\n\n\n",
  // and any pure-whitespace content. Semantically equivalent to the
  // full parse result; serialize path treats the sourceRange as the
  // original whitespace bytes for preservation.
  if (markdown.length === 0 || /^\s*$/.test(markdown)) {
    const emptyPara = schema.nodes.paragraph.create({
      sourceRange: { start: 0, end: markdown.length },
    });
    const doc = schema.nodes.doc.create(null, [emptyPara]);
    return {
      doc,
      blockRanges: [{ start: 0, end: markdown.length }],
    };
  }

  const tokens = md.parse(markdown, {});

  // Pre-compute line-start byte offsets so ParseState can convert
  // markdown-it's 0-indexed line numbers to character positions in
  // O(1) during the token walk.
  const lineStarts: number[] = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOffset = (line: number) =>
    line < lineStarts.length ? lineStarts[line] : markdown.length;

  // Drive the walk with source-map context so push/addNode auto-
  // attach sourceRange attrs to created nodes.
  const state = new ParseState();
  state.tokens = tokens;
  state.lineStarts = lineStarts;
  state.totalLen = markdown.length;

  for (let i = 0; i < tokens.length; i++) {
    state.currentTokIdx = i;
    const tok = tokens[i];
    const fn = handlers[tok.type];
    if (fn) fn(state, tok);
  }

  while (state.stack.length > 1) state.pop();
  const doc = transformTaskItems(state.pop());

  // ── Populate inline-atom sourceRanges via pattern search ──
  // markdown-it's inline tokens don't carry character positions, so
  // we post-process: for each inline atom (wikilink, tag, math,
  // embed, footnote ref, etc.), compute its expected source pattern
  // and search for it in the containing block's source bytes. This
  // is the byte-level preservation story for WITHIN an edited block.
  const docWithInlineRanges = populateInlineSourceRanges(doc, markdown);

  // ── Collect top-level block ranges (content-only) ──
  // Each block's sourceRange is [contentStart, contentEnd) as
  // reported by ParseState.currentRange() - the actual block bytes
  // including the content's line-ending \n, exclusive of any
  // inter-block blank lines.
  //
  // This is the CONTENT-ONLY model (contrast: earlier versions widened
  // each range to absorb trailing whitespace up to the next block's
  // start). The serializer reconstructs the full file by interleaving
  // content with computed inter-block gaps (see serializeWithSource-
  // Preservation). Keeping content and gaps separate means dragged
  // blocks don't carry their original neighbors' whitespace with them
  // - gaps are a property of the block-PAIR, not the block.
  const blockRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < docWithInlineRanges.childCount; i++) {
    const r = docWithInlineRanges.child(i).attrs.sourceRange as
      | { start: number; end: number }
      | null;
    blockRanges.push(r ?? { start: -1, end: -1 });
  }

  // Silence unused-helper warning - lineOffset is kept around in case
  // callers want to do their own line math.
  void lineOffset;

  return { doc: docWithInlineRanges, blockRanges };
}

// ═══════════════════════════════════════════════
//  SERIALIZER: ProseMirror doc -> markdown
// ═══════════════════════════════════════════════

// ── Mark specs ──

interface MarkSpec {
  open: string | ((mark: Mark, parent: PMNode, index: number) => string);
  close: string | ((mark: Mark, parent: PMNode, index: number) => string);
  escape?: boolean;  // default true - escape text inside this mark?
  expel?: boolean;   // default false - expel enclosing whitespace?
  /** Lower rank = opens FIRST (outer mark wrapping everything else).
   *  HTML wrapping marks (font, underline, etc.) want to open
   *  outside markdown content marks (strong, em) so the source reads
   *  `<font>**bold**</font>`, not `**<font>bold**</font>`. Default 100. */
  rank?: number;
}

const markSpecs: Record<string, MarkSpec> = {
  strong:        { open: "**", close: "**", expel: true },
  em:            { open: "*",  close: "*",  expel: true },
  strikethrough: { open: "~~", close: "~~", expel: true },
  highlight: {
    // A custom `color` attr forces HTML form so the
    // background-color survives the round-trip. Plain (no color)
    // highlights honour `html` for the markdown vs HTML shape choice.
    open: (mark) => {
      if (mark.attrs.color) {
        return `<mark style="background-color: ${mark.attrs.color}">`;
      }
      return mark.attrs.html ? "<mark>" : "==";
    },
    close: (mark) =>
      mark.attrs.color || mark.attrs.html ? "</mark>" : "==",
    expel: true,
    // `escape: false` - the highlight plugin's `==…==` rule consumes
    // the inner content as a single raw text token (no inline-rule
    // re-tokenization), and the parser side doesn't de-escape `\…`
    // sequences inside that span. Escaping markdown syntax inside
    // would create an escape-loop on round-trip: each save adds
    // another layer of backslashes because re-parse keeps the literal
    // `\[` text-content and re-emit escapes the backslash. Tradeoff:
    // a user who authors `==**bold inside**==` won't get nested bold
    // recognized - but that's already the parser's current behavior
    // (highlight is opaque to inner inline rules). escape:false just
    // makes the serializer match the parser's opacity.
    escape: false,
  },
  // `escape: false` - the comment span's content is treated as opaque
  // by the obsidian comment plugin (no inner inline rules fire on it).
  // Escaping markdown syntax inside would create an escape-loop on
  // round-trip: each save adds another layer of backslashes, because
  // re-parse keeps the literal `\*` text-content (the comment plugin
  // doesn't de-escape) and re-emit escapes the backslash. Opaque
  // content with no inner tokenization should never be escaped.
  comment:       { open: "%%", close: "%%", escape: false },
  // Common inline HTML tags. expel:true so adjacent whitespace is
  // pushed outside the tag (markdown convention; matches how strong/
  // em/highlight already behave). rank:0 so they open OUTSIDE
  // markdown content marks (strong, em, etc.) - produces
  // `<font>**bold**</font>` rather than the malformed
  // `**<font>bold**</font>`.
  underline:   { open: "<u>",   close: "</u>",   expel: true, rank: 0 },
  superscript: { open: "<sup>", close: "</sup>", expel: true, rank: 0 },
  subscript:   { open: "<sub>", close: "</sub>", expel: true, rank: 0 },
  kbd:         { open: "<kbd>", close: "</kbd>", expel: true, rank: 0 },
  font: {
    open: (mark) => {
      const parts: string[] = [];
      if (mark.attrs.color) parts.push(`color="${mark.attrs.color}"`);
      if (mark.attrs.face) parts.push(`face="${mark.attrs.face}"`);
      if (mark.attrs.size) parts.push(`size="${mark.attrs.size}"`);
      return parts.length ? `<font ${parts.join(" ")}>` : "<font>";
    },
    close: () => "</font>",
    expel: true,
    rank: 0,
  },
  code: {
    open:   (_m, parent, idx) => backticksFor(parent.child(idx), -1),
    close:  (_m, parent, idx) => backticksFor(parent.child(idx - 1), 1),
    escape: false,
  },
  link: {
    open: "[",
    close: (mark) => {
      // href: CommonMark allows two forms: `(href)` (plain) and
      // `(<href>)` (angle-bracketed, allows whitespace and parens).
      // Plain form must escape `(` `)` and disallow whitespace.
      // Angle form must escape `<` `>` `\` and disallow line breaks.
      // Pick angle form when href contains whitespace or unbalanced
      // parens; otherwise plain (which is the common case and matches
      // what users authored).
      const rawHref = (mark.attrs.href ?? "") as string;
      const needsAngle = /[\s)<>]/.test(rawHref);
      const href = needsAngle
        ? `<${rawHref.replace(/([<>\\])/g, "\\$1")}>`
        : rawHref;
      // title: `"..."`. Inner `"` and `\` need backslash-escaping so
      // the title parses back as a single string. Without this, a
      // title like `she said "hi"` round-trips as broken markdown.
      const rawTitle = (mark.attrs.title ?? "") as string;
      const t = rawTitle
        ? ` "${rawTitle.replace(/(["\\])/g, "\\$1")}"`
        : "";
      return `](${href}${t})`;
    },
  },
};

function backticksFor(node: PMNode, side: number): string {
  const re = /`+/g;
  let m, len = 0;
  if (node.isText) while ((m = re.exec(node.text!))) len = Math.max(len, m[0].length);
  let result = len > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (len > 0 && side < 0) result += " ";
  return result;
}

// ── Canonical-form preferences ──
//
// User-configurable serializer marker choices. All optional; falsy
// fields fall back to the canonical defaults below. Applied at
// emit time inside SerState - mark specs stay constant; renderers
// override per-state when an option is provided.

export interface CanonicalFormOptions {
  /** Bullet marker for unordered lists. Default: `-`. */
  bullet?: "-" | "*" | "+";
  /** Italic (em) marker. Default: `*`. */
  italic?: "*" | "_";
  /** Bold (strong) marker. Default: `**`. */
  bold?: "**" | "__";
  /** Code-block fence character. Default: triple backtick. */
  codeFence?: "```" | "~~~";
  /** Horizontal rule string. Default: `---`. */
  horizontalRule?: "---" | "***" | "___";
}

const CANONICAL_DEFAULTS: Required<CanonicalFormOptions> = {
  bullet: "-",
  italic: "*",
  bold: "**",
  codeFence: "```",
  horizontalRule: "---",
};

// ── Escape helpers ──

function esc(str: string, startOfLine = false): string {
  str = str.replace(/[`*\\~[\]_]/g, "\\$&");
  if (startOfLine)
    str = str.replace(/^[#\-*+>]/, "\\$&").replace(/^(\s*\d+)\./, "$1\\.");
  return str;
}

// True when the LAST LINE of `out` consists only of block-level
// prefix tokens - continuation delim chars (`>`, whitespace), list
// markers (`-`, `*`, `+`, `N.`), task markers (`[ ]`, `[x]`, `[X]`).
// In that state the next char written is effectively at the start
// of inner content (after the prefix), and SOL escape rules apply
// - even though `out` doesn't literally end with `\n`. Used by the
// SerState.text() escape-decision to extend SOL handling into
// wrapped contexts (blockquote / list_item / callout body) without
// requiring those serializers to thread an explicit "next is SOL"
// flag through every call site.
function isInnerLineStart(out: string): boolean {
  const lastNL = out.lastIndexOf("\n");
  const lastLine = lastNL >= 0 ? out.slice(lastNL + 1) : out;
  // Only-prefix means: any combination of whitespace, `>` markers,
  // and at most one list marker followed by optional task marker.
  // The regex is permissive - false positives (treating non-prefix
  // text as SOL) only ADD a backslash escape, which is benign on
  // round-trip; false negatives (missing a real SOL) are the bug
  // we're trying to avoid.
  return /^[ \t>]*(?:[-*+]\s+|\d+\.\s+)?(?:\[[ xX]\]\s+)?$/.test(lastLine);
}

// ── Serializer state ──

type NodeSer = (state: SerState, node: PMNode, parent?: PMNode, index?: number) => void;

/** Compute keys of marks whose ranges interleave (overlap-but-not-nest)
 *  another mark's range within the given inline parent. Returns the
 *  set of "type::JSON(attrs)" keys for marks needing HTML-form emit.
 *
 *  Range = [first child index where mark appears, last child index + 1).
 *  Marks of the same type+attrs across non-contiguous text runs are
 *  collapsed into a single range - rare in practice and harmless even
 *  when it happens (the collapsed range can only be MORE conservatively
 *  flagged as overlapping, not less). */
function computeOverlapKeys(parent: PMNode): Set<string> {
  type Range = { start: number; end: number };
  // Track ALL contiguous ranges per mark key (not a single merged
  // range). When the overlap-resolver plugin smart-splits a previously
  // overlapping mark, both em and strong end up with multiple non-
  // contiguous runs separated by unmarked whitespace. Merging those
  // runs into a single range incorrectly re-flags overlap; the
  // serializer would emit HTML form even though the doc is now
  // pure-markdown-representable.
  const allRanges = new Map<string, Range[]>();
  const open = new Map<string, Range>();
  let i = 0;
  parent.forEach((child) => {
    const childKeys = new Set<string>();
    if (child.isText && child.marks.length) {
      for (const mark of child.marks) {
        childKeys.add(SerState.markKey(mark));
      }
    }
    // Close any open run whose mark isn't present on this child.
    for (const [key, range] of open) {
      if (!childKeys.has(key)) {
        const list = allRanges.get(key) ?? [];
        list.push(range);
        allRanges.set(key, list);
        open.delete(key);
      }
    }
    // Open or extend a run for each mark on this child.
    for (const key of childKeys) {
      const r = open.get(key);
      if (r) r.end = i + 1;
      else open.set(key, { start: i, end: i + 1 });
    }
    i++;
  });
  // Flush remaining open runs.
  for (const [key, range] of open) {
    const list = allRanges.get(key) ?? [];
    list.push(range);
    allRanges.set(key, list);
  }

  const overlap = new Set<string>();

  // CRITERION 1 - non-whitespace-separated non-contiguous runs.
  //
  // A mark with multiple contiguous runs in the same inline parent
  // can be serialized in markdown form ONLY if the gaps between its
  // runs contain whitespace (so the close-delim sits next to a
  // non-letter char, satisfying CommonMark right-flanking). When the
  // gap is just letter-only text (e.g., `[em]45[strong]67[em]89`),
  // emitting markdown produces `*45*67*89*` and markdown-it can't
  // correctly re-pair the alternating `*`s - the inner content's
  // delim becomes unpaired and the outer surface produces `<em>`-
  // less reparse + literal `*` text, breaking round-trip.
  //
  // Flag this mark for HTML form (`<em>` / `<strong>`) so each
  // non-contig run gets a clean tag pair that markdown-it accepts
  // independently.
  for (const [key, runs] of allRanges) {
    if (runs.length < 2) continue;
    let needsHtml = false;
    for (let r = 0; r < runs.length - 1; r++) {
      const gapStart = runs[r].end;
      const gapEnd = runs[r + 1].start;
      let gapHasWhitespace = false;
      for (let j = gapStart; j < gapEnd; j++) {
        const child = parent.maybeChild(j);
        if (!child) continue;
        if (child.isText && /\s/.test(child.text ?? "")) {
          gapHasWhitespace = true;
          break;
        }
      }
      if (!gapHasWhitespace) {
        needsHtml = true;
        break;
      }
    }
    if (needsHtml) overlap.add(key);
  }

  if (allRanges.size < 2) return overlap;

  // CRITERION 2 - strict interleave (the original detection).
  const entries = [...allRanges.entries()];
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const [keyA, listA] = entries[a];
      const [keyB, listB] = entries[b];
      outer: for (const A of listA) {
        for (const B of listB) {
          const interleave =
            (A.start < B.start && B.start < A.end && A.end < B.end) ||
            (B.start < A.start && A.start < B.end && B.end < A.end);
          if (interleave) {
            overlap.add(keyA);
            overlap.add(keyB);
            break outer;
          }
        }
      }
    }
  }

  // CRITERION 4 - close-and-reopen detection.
  //
  // When the renderInline mark stack needs to close a mark M that's
  // BELOW other marks N in the open order, the serializer closes the
  // Ns first (top-down), closes M, then reopens the Ns. If any of
  // the Ns are markdown-form (em/strong), their REOPEN delimiter
  // lands right after M's close - typically against an HTML tag
  // (`</font>**`) where flanking rules say `**` can't open. Re-parse
  // then treats it as literal text.
  //
  // Simulate active stack progression. Any mark that would be in the
  // reopen position (an N above a closing M) gets flagged for HTML
  // form so the reopen delimiter is `<strong>`/`<em>` instead of
  // `**`/`*` - HTML opens have no flanking constraint.
  //
  // Also flag the closing mark M when its close would land between
  // the original close-of-N and the reopen-of-N - same reasoning.
  // Conservatively flagging both sides of the close-and-reopen event
  // produces correct, round-trippable output.
  {
    const stack: string[] = [];
    const childKeySets = ((): Set<string>[] => {
      const sets: Set<string>[] = [];
      parent.forEach((child) => {
        const s = new Set<string>();
        if (child.isText && child.marks.length) {
          // Match the rank-sort renderInline applies. The stack
          // order is determined by open ORDER (rank-sorted within
          // each text-node's mark set), so simulating with rank-sort
          // matches reality.
          const sorted = child.marks.slice().sort((a, b) => {
            const ra = markSpecs[a.type.name]?.rank ?? 100;
            const rb = markSpecs[b.type.name]?.rank ?? 100;
            return ra - rb;
          });
          for (const m of sorted) s.add(SerState.markKey(m));
        }
        sets.push(s);
      });
      return sets;
    })();
    for (const targetSet of childKeySets) {
      // Close pass - mirror renderInline's close-and-reopen logic.
      for (let j = stack.length - 1; j >= 0; j--) {
        if (targetSet.has(stack[j])) continue;
        // Inners above j that should stay (in target) get reopened
        // around the close - flag them and the closing mark.
        for (let k = stack.length - 1; k > j; k--) {
          if (targetSet.has(stack[k])) {
            overlap.add(stack[k]);
            overlap.add(stack[j]);
          }
        }
        stack.splice(j, 1);
        j = stack.length;
      }
      // Open pass - push new marks (in target sort order, matching
      // renderInline's open loop).
      for (const key of targetSet) {
        if (!stack.includes(key)) stack.push(key);
      }
    }
  }

  // CRITERION 3 - flag-propagation. When CRITERION 1 forces a mark
  // (typically em) to HTML form because its non-contig runs aren't
  // whitespace-separated, a sibling mark (typically strong) whose
  // markdown delimiter would land at a non-flanking position
  // ALSO needs HTML form. Concretely: serializing
  // `**<em>45</em>67<em>89</em>**` fails because the outer `**`
  // delims are preceded/followed by punctuation `<`/`>` and a
  // non-ws non-punct char (the `3` and end-of-input edge), which
  // breaks CommonMark right/left-flanking rules. With both marks in
  // HTML form (`<strong><em>45</em>67<em>89</em></strong>`), no
  // flanking concerns apply.
  //
  // Propagation rule: any mark whose ANY contig run overlaps with
  // an already-flagged mark's range gets flagged too. Conservative
  // and idempotent - only marks that ALREADY share boundary issues
  // with a flagged mark get pulled in.
  if (overlap.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const flaggedKey of [...overlap]) {
        const flaggedRuns = allRanges.get(flaggedKey)!;
        for (const [otherKey, otherRuns] of allRanges) {
          if (overlap.has(otherKey)) continue;
          let touches = false;
          for (const fr of flaggedRuns) {
            for (const or of otherRuns) {
              if (or.start < fr.end && fr.start < or.end) {
                touches = true;
                break;
              }
            }
            if (touches) break;
          }
          if (touches) {
            overlap.add(otherKey);
            changed = true;
          }
        }
      }
    }
  }
  return overlap;
}

class SerState {
  out = "";
  closed: PMNode | false = false;
  delim = "";
  canonicalForm: Required<CanonicalFormOptions>;

  /** Marks (by type+attrs key) whose range overlaps another mark's
   *  range in the current inline-render parent. CommonMark emphasis
   *  pairs require strict nesting, so `**` / `*` can't represent
   *  overlap; for these marks we emit `<strong>` / `<em>` HTML form
   *  instead, which my htmlInlineTagsPlugin handles via any-match
   *  close. Set is repopulated per renderInline() call. */
  overlapKeys: Set<string> = new Set();

  constructor(options?: CanonicalFormOptions) {
    this.canonicalForm = { ...CANONICAL_DEFAULTS, ...(options ?? {}) };
  }

  /** Stable per-instance key for a mark - type + attrs JSON. Two
   *  marks with the same key are considered "the same instance" for
   *  range-tracking; PM normalizes mark equality this way too. */
  static markKey(mark: Mark): string {
    return mark.type.name + "::" + JSON.stringify(mark.attrs);
  }

  isOverlap(mark: Mark): boolean {
    return this.overlapKeys.has(SerState.markKey(mark));
  }

  /** Resolve a mark's open string, honoring user canonical preferences
   *  for `strong` / `em` while leaving other marks at their spec
   *  defaults. Returns the same string the spec would have produced
   *  unless the option overrides it.
   *
   *  When a mark is in `overlapKeys` (set by `computeOverlapKeys`),
   *  we route every markdown-form delimited mark to its HTML form
   *  so the close-and-reopen pattern doesn't land delimiters at
   *  non-flanking positions on re-parse. Marks covered:
   *    strong (`**` → `<strong>`)
   *    em (`*` → `<em>`)
   *    strikethrough (`~~` → `<s>`)
   *    highlight (`==` → `<mark>`)
   *  Marks already in HTML form (font, underline, sup, sub, kbd)
   *  don't need this branch - their spec.open IS the HTML tag. */
  markOpen(mark: Mark, parent: PMNode, index: number): string {
    const name = mark.type.name;
    if (this.isOverlap(mark)) {
      if (name === "strong") return "<strong>";
      if (name === "em") return "<em>";
      if (name === "strikethrough") return "<s>";
      if (name === "highlight") {
        return mark.attrs.color
          ? `<mark style="background-color: ${mark.attrs.color}">`
          : "<mark>";
      }
    }
    if (name === "strong") return this.canonicalForm.bold;
    if (name === "em") return this.canonicalForm.italic;
    const spec = markSpecs[name];
    return typeof spec.open === "function"
      ? spec.open(mark, parent, index)
      : spec.open;
  }

  markClose(mark: Mark, parent: PMNode, index: number): string {
    const name = mark.type.name;
    if (this.isOverlap(mark)) {
      if (name === "strong") return "</strong>";
      if (name === "em") return "</em>";
      if (name === "strikethrough") return "</s>";
      if (name === "highlight") return "</mark>";
    }
    if (name === "strong") return this.canonicalForm.bold;
    if (name === "em") return this.canonicalForm.italic;
    const spec = markSpecs[name];
    return typeof spec.close === "function"
      ? spec.close(mark, parent, index)
      : spec.close;
  }

  // ── primitives ──

  atBlank(): boolean { return /(^|\n)$/.test(this.out); }

  flushClose(size = 2) {
    if (!this.closed) return;
    if (!this.atBlank()) this.out += "\n";
    for (let i = 1; i < size; i++) this.out += this.delim + "\n";
    this.closed = false;
  }

  /** Write raw content. Prepends delim if at line start. */
  write(s: string) {
    this.flushClose();
    if (this.delim && this.atBlank()) this.out += this.delim;
    this.out += s;
  }

  /** Write text with optional escaping and per-line delim. */
  text(text: string, escape = true) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Start-of-line is true for `i > 0` (after explicit newline)
      // OR output ends with `\n` OR a block just closed OR the last
      // line of output is composed only of MARKDOWN BLOCK PREFIXES
      // (continuation delim like `> `, list markers like `- ` /
      // `1. `, task markers `[ ]` / `[x]`, all interleaved with
      // whitespace). The last clause is what makes text-escape work
      // INSIDE wrapped containers - blockquote prepends `> ` on each
      // inner line; list_item writes a marker `- ` before the
      // paragraph's text; in both cases the next char IS at start-
      // of-inner-content even though `\n` isn't the very last byte
      // in `this.out`. Pre-fix, text-looks-like-block patterns
      // (`## title`, `- list`, `> quote`, `---`) round-tripped
      // wrong inside lists / blockquotes because SOL escape didn't
      // fire there.
      const sol =
        i > 0 ||
        this.atBlank() ||
        !!this.closed ||
        isInnerLineStart(this.out);
      this.flushClose();
      if (i > 0) {
        this.out += "\n";
        if (this.delim) this.out += this.delim;
      } else if (this.delim && this.atBlank()) {
        this.out += this.delim;
      }
      this.out += escape ? esc(lines[i], sol) : lines[i];
    }
  }

  closeBlock(node: PMNode) { this.closed = node; }

  wrapBlock(delim: string, firstDelim: string | null, node: PMNode, fn: () => void) {
    const old = this.delim;
    this.write(firstDelim ?? delim);
    this.delim += delim;
    fn();
    this.delim = old;
    this.closeBlock(node);
  }

  // ── source-preservation context (optional) ──
  // Set by serializeWithSourcePreservation when re-serializing an
  // edited top-level block. If a rendered inline atom is in the
  // original set AND has a valid sourceRange, we bypass its handler
  // and emit the original bytes verbatim - byte-level preservation
  // for atoms even when their containing block is being synthesized.
  sourcePresBody: string | null = null;
  sourcePresOriginalAtoms: Set<PMNode> | null = null;

  // ── rendering ──

  renderNode(node: PMNode, parent?: PMNode, index?: number) {
    // Inline-atom byte-preservation hook. Only fires inside an
    // edited-block synthesis path that set sourcePresBody +
    // sourcePresOriginalAtoms. The check is cheap (Set.has +
    // attribute lookup) and falls through to the normal handler
    // when preservation isn't available or applicable.
    if (
      node.isInline &&
      node.isAtom &&
      this.sourcePresBody != null &&
      this.sourcePresOriginalAtoms?.has(node)
    ) {
      const r = node.attrs.sourceRange as
        | { start: number; end: number }
        | null;
      if (
        r &&
        r.start >= 0 &&
        r.end >= r.start &&
        r.end <= this.sourcePresBody.length
      ) {
        this.write(this.sourcePresBody.slice(r.start, r.end));
        return;
      }
    }
    const handler = nodeSer[node.type.name];
    if (!handler) throw new Error(`No serializer for: ${node.type.name}`);
    handler(this, node, parent, index);
  }

  renderContent(parent: PMNode) {
    parent.forEach((child, _, i) => this.renderNode(child, parent, i));
  }

  renderInline(parent: PMNode) {
    // Pre-pass: compute which mark instances overlap others within
    // this inline parent. A mark "overlaps" another when their text
    // ranges interleave but don't nest (e.g. `*two **three* four**`
    // - em starts inside strong but ends outside it). CommonMark
    // emphasis pairs require strict nesting; for overlapping em /
    // strong we emit `<em>` / `<strong>` HTML form instead, which
    // round-trips via the any-match close in htmlInlineTagsPlugin.
    // Other marks (font etc.) are already HTML-form so they handle
    // overlap natively.
    this.overlapKeys = computeOverlapKeys(parent);

    let active: Mark[] = [];
    let trailing = "";

    const progress = (child: PMNode | null, _off: number, index: number) => {
      let marks = child
        ? child.marks.filter((m) => markSpecs[m.type.name])
        : [];

      // Sort by explicit serialization rank (lower opens first / outer).
      // Marks without an explicit rank fall back to 100, which keeps
      // their relative order vs schema declaration. HTML wrapping marks
      // declare rank: 0 so they wrap markdown content marks like bold
      // (e.g. <font>**fun**</font>, not **<font>fun**</font>).
      if (marks.length > 1) {
        marks = marks.slice().sort((a, b) => {
          const ra = markSpecs[a.type.name]?.rank ?? 100;
          const rb = markSpecs[b.type.name]?.rank ?? 100;
          return ra - rb;
        });
      }

      // Whitespace expelling
      let leading = trailing;
      trailing = "";
      if (child?.isText && child.text) {
        if (marks.some((m) => markSpecs[m.type.name]?.expel)) {
          const match = /^(\s*)(.*?)(\s*)$/s.exec(child.text);
          if (match && (match[1] || match[3])) {
            leading += match[1];
            trailing = match[3];
            child = match[2]
              ? schema.text(match[2], child.marks)
              : null;
            // When the expelled text has NO inner content (pure
            // whitespace), keep `marks` as the child's original mark
            // set - NOT active.slice(). The previous logic perpetuated
            // active marks across the whitespace, which is wrong when
            // the whitespace text node's actual mark set is NARROWER
            // than what's currently active. That happens when the
            // PM doc structure is e.g. `text[em,strong] · text[em] ·
            // wikilink[em]` - the middle whitespace deliberately drops
            // strong. Keeping strong open through the whitespace
            // produces `**Note **[[link]]` where the closing `**` is
            // preceded by whitespace and can't pair as right-flanking,
            // so markdown-it can't re-pair the strong on reparse.
            //
            // With marks = child.marks, the close-marks loop below
            // closes strong before the whitespace, producing
            // `**Note** [[link]]` - clean and round-tripping.
          }
        }
      }

      // Close marks NOT in the target set. Uses set-membership, not
      // positional prefix, so marks that appear in both sets stay
      // open even if their schema-rank position differs (e.g.
      // [em] → [strong, em] keeps em open).
      //
      // When the to-close mark sits BELOW marks that should stay
      // (e.g., active=[strong, font], target=[font] - strong is
      // outer in the open stack, font is inner), HTML / markdown
      // well-formedness requires closing the inners first, closing
      // the target, then reopening the inners. Without this, naive
      // close-and-splice produces invalid `<strong>two <font>three
      // </strong>` style crossings - markdown-it's HTML pass either
      // strips the orphan or normalizes nesting on re-parse, dropping
      // text content and breaking save round-trip.
      //
      // The fix is the close-and-reopen pattern below: when an
      // unwanted mark is found at index j, close every inner above
      // (top-down), close the target, then reopen the inners that
      // should still be active. Inners that ALSO need to close (i.e.,
      // not in target) get filtered out of the reopen list - they
      // close as a side effect of the inner-close pass.
      for (let j = active.length - 1; j >= 0; j--) {
        if (active[j].isInSet(marks)) continue;
        const reopenList = active
          .slice(j + 1)
          .filter((m) => m.isInSet(marks));
        // Close inners (top-down) so the HTML/markdown stack stays
        // well-formed when we close the target below.
        for (let k = active.length - 1; k > j; k--) {
          this.write(this.markClose(active[k], parent, index));
        }
        // Close the unwanted mark.
        this.write(this.markClose(active[j], parent, index));
        // Replace active[j..end] with the kept inners. Marks that
        // were above j and aren't in target are simply gone - they
        // already closed in the inner-pass above.
        active.splice(j, active.length - j, ...reopenList);
        // Reopen the kept inners (preserve original opening order).
        for (const m of reopenList) {
          this.write(this.markOpen(m, parent, index));
        }
        // Restart from new top - `j--` will fire and land at
        // active.length - 1 next iteration.
        j = active.length;
      }

      // Leading whitespace (between close and open)
      if (leading) this.write(leading);

      // Open marks NOT currently active
      for (let j = 0; j < marks.length; j++) {
        if (!marks[j].isInSet(active)) {
          this.write(this.markOpen(marks[j], parent, index));
          active.push(marks[j]);
        }
      }
      if (!child) return;

      if (child.isText) {
        const noEsc = active.some(
          (m) => markSpecs[m.type.name]?.escape === false,
        );
        this.text(child.text!, !noEsc);
      } else {
        this.renderNode(child, parent, index);
      }
    };

    const startLen = this.out.length;
    parent.forEach((child, off, idx) => progress(child, off, idx));
    progress(null, 0, parent.childCount);
    if (trailing) this.write(trailing);

    // Defensive: text content that ends with `^[A-Za-z0-9_-]+` at the
    // end of a textblock parses back as a `block_id` atom under the
    // markdown-it block-id rule (which fires when the rest-of-line
    // after the id is whitespace-only). Round-trip then drops the
    // characters of the would-be id from textContent - typically how
    // a user typing `^foo` at the end of a line gets a save-failure
    // round-trip rejection. Escape the `^` with a leading backslash
    // so reparse treats it as plain text.
    //
    // Skip this when the parent's last inline child is an actual
    // block_id node - that atom ALSO emits `^id` but we want it to
    // round-trip as a block_id, not be turned into escaped text.
    const lastChild = parent.lastChild;
    if (!lastChild || lastChild.type.name !== "block_id") {
      const tail = this.out.slice(startLen);
      const m = /\^[A-Za-z0-9_-]+$/.exec(tail);
      if (m) {
        const insertAt = startLen + tail.length - m[0].length;
        this.out = this.out.slice(0, insertAt) + "\\" + this.out.slice(insertAt);
      }
    }
  }

  renderList(
    node: PMNode,
    indent: string,
    getMarker: (i: number) => string,
    parent?: PMNode,
  ) {
    // Separate consecutive same-type lists with an invisible
    // block_comment block. Without a non-list block between them,
    // CommonMark merges adjacent same-marker lists into ONE on
    // reparse - losing the user's intent of "two separate lists."
    // Blank lines alone don't break the adjacency by spec; only a
    // different-kind block does. We use Obsidian's `%%\n\n%%`
    // block-comment syntax because:
    //   1. It renders invisibly via blockCommentView's display:none.
    //   2. It's Obsidian-native (better than HTML `<!-- -->` for an
    //      Obsidian plugin's source).
    //   3. Our parser produces a `block_comment` PM node for it,
    //      which is a non-list block - exactly what CommonMark
    //      requires to terminate a list.
    // Round-trip is clean: editor shows two lists with an invisible
    // separator between them; source has the comment; reparse
    // reconstructs the same shape.
    if (this.closed && (this.closed as { type: unknown }).type === node.type) {
      this.flushClose(2);
      // Emit a self-documenting list-break separator: `%%list-break%%`
      // followed by a blank line before the next list. The parser
      // recognizes this exact sentinel as an empty `block_comment`
      // (display:none NodeView), so it's invisible in the editor but
      // explains itself when someone reads the raw markdown source.
      // Each line gets the current delim so the marker renders
      // correctly inside blockquotes / callouts.
      this.out += this.delim + "%%list-break%%\n";
      this.out += this.delim + "\n";
    }

    // Spacing rule for the FIRST item depends on context:
    //   - Nested in a `list_item` (the "- item\n  - sub" case) - the
    //     list's `tight` attr decides whether to emit a blank line
    //     between the parent's content and this nested list. Tight
    //     gives `\n` only; loose gives a blank line. Matches what
    //     Obsidian's source view shows.
    //   - At the top level (or any non-list-item parent: doc,
    //     blockquote, callout body), the previous block is unrelated
    //     to this list and should ALWAYS get standard block spacing
    //     (a blank line). Otherwise a tight list squishes against
    //     whatever came before it - paragraph, heading, separator
    //     comment, blockquote, etc.
    //
    // For SUBSEQUENT items (i > 0), the list's tight attr always
    // applies - that's inter-item spacing within this list, which is
    // exactly what tight/loose is meant to control.
    const nestedInListItem = parent?.type.name === "list_item";
    const listTight = Boolean((node.attrs as { tight?: unknown }).tight);
    node.forEach((child, _, i) => {
      if (this.closed) {
        const isFirst = i === 0;
        const useTight = isFirst
          ? nestedInListItem && listTight
          : listTight;
        this.flushClose(useTight ? 1 : 2);
      }
      const old = this.delim;
      this.write(getMarker(i));
      this.delim += indent;
      // Dispatch to list_item handler - correctly emits task markers
      this.renderNode(child, node, i);
      this.delim = old;
    });
  }
}

// ── list_item helpers ──

/**
 * Compute the indent prefix for a flat list_item - sum of the marker
 * widths of all ancestor items. For an item at depth=2 nested under
 * "1. foo" → "1. nested-parent" → "    - me", the indent is the
 * marker width of "1. " (3) PLUS the marker width of "1. " again (3)
 * = 6 spaces.
 *
 * Walks back through siblings to find the closest ancestor at each
 * shallower depth. Skips items at greater depth (they're cousins,
 * not ancestors).
 */
function computeDepthIndent(
  node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
  bulletChar: string,
): string {
  const depthRaw = (node.attrs as { depth?: unknown }).depth;
  const depth = typeof depthRaw === "number" ? depthRaw : 0;
  if (depth === 0 || !parent || index === undefined) return "";
  let prefix = "";
  for (let d = depth - 1; d >= 0; d--) {
    let ancestor: PMNode | null = null;
    let ancestorIdx = -1;
    for (let i = index - 1; i >= 0; i--) {
      const p = parent.child(i);
      if (p.type.name !== "list_item") break;
      if (p.attrs.depth < d) break;
      if (p.attrs.depth === d) {
        ancestor = p;
        ancestorIdx = i;
        break;
      }
    }
    if (ancestor) {
      // Use the BARE marker width (`- ` or `1. `, etc.) - NOT the
      // full task marker (`- [ ] `). Task brackets are content; the
      // continuation/nesting indent only needs to clear the bullet
      // or number prefix. Without this distinction, a child of a
      // task would get 6-space indent (matching `- [ ] `) and
      // markdown-it would treat the line as a 4+ space-indented
      // code block.
      prefix += " ".repeat(bareMarkerWidth(ancestor, parent, ancestorIdx));
    } else {
      // No ancestor at this depth (orphan nesting). Conservative
      // fallback: use 2 spaces, the bullet-marker width.
      prefix += "  ";
    }
  }
  return prefix;
}

/**
 * Width (in characters) of just the bullet/number marker for an
 * item, NOT including any task brackets. Used to compute the indent
 * for nested children - child indent only needs to clear the bullet
 * or number prefix, since CommonMark treats task brackets as content.
 *   - bullet: `- ` → 2
 *   - task:   `- ` (the bullet part of `- [ ] `) → 2
 *   - ordered: depends on rendered number - `1. ` → 3, `10. ` → 4
 */
function bareMarkerWidth(
  node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
): number {
  const kind = node.attrs.kind as "bullet" | "ordered" | "task";
  if (kind === "bullet" || kind === "task") return 2;
  // Ordered: compute the rendered number and return its serialized width.
  let firstIdx = index ?? 0;
  if (parent && index !== undefined) {
    let i = index - 1;
    while (i >= 0) {
      const p = parent.child(i);
      if (p.type.name !== "list_item") break;
      if (p.attrs.depth > node.attrs.depth) {
        i--;
        continue;
      }
      if (p.attrs.depth < node.attrs.depth) break;
      if (p.attrs.kind !== "ordered") break;
      firstIdx = i;
      i--;
    }
  }
  const firstStart = (parent?.child(firstIdx).attrs.start as number | null) ?? 1;
  let count = 0;
  if (parent && index !== undefined) {
    for (let j = firstIdx; j <= index; j++) {
      const p = parent.child(j);
      if (
        p.type.name === "list_item" &&
        p.attrs.kind === "ordered" &&
        p.attrs.depth === node.attrs.depth
      ) {
        count++;
      }
    }
  } else {
    count = 1;
  }
  const number = firstStart + count - 1;
  return `${number}. `.length;
}

/**
 * Compute the markdown marker for a flat list_item (`- `, `1. `,
 * `- [ ] `, etc.). For ordered items, walks back through siblings
 * (skipping deeper-nested ones) to determine our 1-based position
 * in the contiguous run, anchored at the run's first item's `start`
 * attr (default 1).
 */
function computeListMarker(
  node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
  bulletChar: string = "-",
): string {
  const kind = node.attrs.kind as "bullet" | "ordered" | "task";
  if (kind === "task") {
    // Task uses canonical `-` (per GFM convention) regardless of the
    // bullet-character canonical option. Mixed bullets + tasks should
    // not have task items rendering as `* [x]` if the user picked `*`
    // for plain bullets - GFM task syntax is anchored to `-`.
    return node.attrs.checked ? "- [x] " : "- [ ] ";
  }
  if (kind === "bullet") {
    return `${bulletChar} `;
  }
  // Ordered: count my position in the run.
  let firstIdx = index ?? 0;
  if (parent && index !== undefined) {
    let i = index - 1;
    while (i >= 0) {
      const p = parent.child(i);
      if (p.type.name !== "list_item") break;
      if (p.attrs.depth > node.attrs.depth) {
        i--;
        continue;
      }
      if (p.attrs.depth < node.attrs.depth) break;
      if (p.attrs.kind !== "ordered") break;
      firstIdx = i;
      i--;
    }
  }
  const firstStart = (parent?.child(firstIdx).attrs.start as number | null) ?? 1;
  let count = 0;
  if (parent && index !== undefined) {
    for (let j = firstIdx; j <= index; j++) {
      const p = parent.child(j);
      if (
        p.type.name === "list_item" &&
        p.attrs.kind === "ordered" &&
        p.attrs.depth === node.attrs.depth
      ) {
        count++;
      }
    }
  } else {
    count = 1;
  }
  return `${firstStart + count - 1}. `;
}

// ── Node serializer table ──

const nodeSer: Record<string, NodeSer> = {
  // Standard blocks
  paragraph(state, node) {
    state.renderInline(node);
    state.closeBlock(node);
  },
  heading(state, node) {
    // Setext headings (`text\n---` / `text\n===`) parse to a heading
    // node whose inline content carries a softbreak - i.e. multi-line
    // text. ATX-style serialization (`## ` + inline) would emit the
    // newline verbatim, and re-parse splits the second line into a
    // paragraph. Collapse internal soft/hard breaks to spaces so the
    // heading always lands on a single line, regardless of whether
    // markdown-it produced it from setext or ATX form. Also clamp
    // level into 1..6 so a malformed `level: 0 / NaN` (which would
    // emit zero `#` chars and re-parse as a paragraph) still produces
    // a valid `#`-prefixed heading.
    const level = Math.max(
      1,
      Math.min(6, Math.floor(Number(node.attrs.level) || 1)),
    );
    state.write("#".repeat(level) + " ");
    // Capture the inline render output so we can scrub line breaks
    // before flushing it into the main state buffer. `.out` is the
    // internal accumulator on SerializerState — not in PM's public
    // d.ts but stable in practice.
    const stateAny = state as unknown as { out: string };
    const before = stateAny.out.length;
    state.renderInline(node);
    const after = stateAny.out.length;
    const inline: string = stateAny.out.slice(before, after);
    const collapsed = inline.replace(/[ \t]*\n[ \t]*/g, " ");
    if (collapsed !== inline) {
      stateAny.out = stateAny.out.slice(0, before) + collapsed;
    }
    state.closeBlock(node);
  },
  blockquote(state, node) {
    state.wrapBlock("> ", null, node, () => state.renderContent(node));
  },
  // ── Flat list_item serializer ──
  //
  // Each list_item is a top-level block (no `bullet_list` /
  // `ordered_list` containers). We emit standard markdown - `- `,
  // `1. `, `- [ ] ` - with `depth * 2` spaces of indent, so the
  // output reparses through markdown-it's normal nested ul/ol/li
  // tokens and back through OUR parser into the same flat
  // list_item sequence.
  //
  // Inter-item spacing:
  //   • Continuation (previous sibling is a list_item at same kind +
  //     depth, possibly with deeper-nested items in between): use the
  //     current item's `tight` attr - tight = single \n, loose = blank
  //     line.
  //   • Nested under (previous sibling is a list_item at SHALLOWER
  //     depth): same tight/loose rule based on this item's tight.
  //   • Otherwise (different kind at same depth, after non-list block,
  //     or first block of doc): standard 2-newline block separator.
  //
  // The walk-back skips DEEPER siblings (those are children of an
  // earlier shallower item) so a list like `- foo\n  - nested\n- bar`
  // correctly identifies "bar" as a continuation of "foo" despite the
  // intervening "nested" sibling at depth 1.
  list_item(state, node, parent, index) {
    let isContinuation = false;
    let isNested = false;
    if (parent && index !== undefined && index > 0) {
      let i = index - 1;
      while (i >= 0) {
        const p = parent.child(i);
        if (p.type.name !== "list_item") break;
        if (p.attrs.depth > node.attrs.depth) {
          // Deeper-nested children of an earlier sibling - skip past.
          i--;
          continue;
        }
        if (p.attrs.depth < node.attrs.depth) {
          isNested = true;
          break;
        }
        // Same depth - continuation iff same kind.
        if (p.attrs.kind === node.attrs.kind) isContinuation = true;
        break;
      }
    }

    if (state.closed) {
      const tight =
        (isContinuation || isNested) && node.attrs.tight !== false;
      state.flushClose(tight ? 1 : 2);
    }

    // Sum marker widths of ancestor items so the indent matches what
    // CommonMark requires for nesting (≥ parent marker width). For a
    // bullet/task parent that's 2 chars (`- ` / `* `); for an ordered
    // parent it depends on its rendered number ("1. " → 3, "10. " →
    // 4, etc.). Without this an item nested under "1. foo" would
    // serialize with 2-space indent, which markdown-it reads as a
    // sibling at depth 0, not a nested child - breaking round-trip.
    const depthIndent = computeDepthIndent(
      node,
      parent,
      index,
      state.canonicalForm.bullet,
    );
    const marker = computeListMarker(node, parent, index, state.canonicalForm.bullet);
    state.write(depthIndent + marker);

    // Continuation indent = depth indent + BARE marker width (just
    // the bullet/number prefix, not the task brackets). markdown-it
    // accepts task-item continuation at the bullet-marker column
    // the `[ ]` brackets are consumed as content. If we used the
    // full task marker width (6 chars for `- [ ] `), continuation
    // lines would land at column 6+ which markdown-it reads as a
    // 4+ space-indented code block, corrupting any callout / nested
    // markdown content inside the task.
    const contIndent = depthIndent.length + bareMarkerWidth(node, parent, index);
    const old = state.delim;
    state.delim += " ".repeat(contIndent);
    state.renderContent(node);
    state.delim = old;
    state.closeBlock(node);
  },
  code_block(state, node) {
    const lang = (node.attrs.language as string | undefined) ?? "";
    const fence = state.canonicalForm.codeFence;
    state.write(fence + lang);
    state.write("\n");
    state.text(node.textContent, false);
    state.write("\n");
    state.write(fence);
    state.closeBlock(node);
  },
  horizontal_rule(state, node) {
    state.write(state.canonicalForm.horizontalRule);
    state.closeBlock(node);
  },
  hard_break(state, node, parent, index) {
    if (parent && index != null) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    } else {
      state.write("\\\n");
    }
  },
  softbreak(state) { state.write("\n"); },
  image(state, node) {
    const attrs = node.attrs as {
      src?: string;
      title?: string;
      alt?: string;
      width?: number | null;
      height?: number | null;
      displayMode?: string | null;
    };
    const src = attrs.src ?? "";
    const title = attrs.title;
    const width = attrs.width;
    const height = attrs.height;
    const displayMode = attrs.displayMode;
    let alt = esc(attrs.alt ?? "");
    if (displayMode === "full") {
      // Full-column-width sentinel - overrides any pixel size.
      alt = alt ? `${alt}|full` : "|full";
    } else if (width) {
      const sz = height ? `|${width}x${height}` : `|${width}`;
      alt = alt ? `${alt}${sz}` : sz;
    }
    state.write(`![${alt}](${src}${title ? ` "${title}"` : ""})`);
  },
  text(state, node) { state.text(node.text!); },

  // Tables
  table(state, node) {
    // LP-style aligned table output. Every column is padded to the
    // width of its widest cell (or the alignment marker's minimum
    // width, whichever is greater). Source on disk reads cleanly:
    //
    //   | Header 1 | Header 2 | Header 3 |
    //   | -------- | :------: | -------: |
    //   | short    | center   |    right |
    //   | longer   | b        |        c |
    //
    // Two-phase: pre-render every cell to a string (rewinding
    // `state.out` after each capture so we can pad before writing
    // the final bytes), compute per-column widths, then write
    // padded rows + a width-matched separator row.
    //
    // Cell content escaping (pipes → `\|`, soft/hard breaks → `<br>`)
    // happens during the capture phase so widths reflect what
    // actually lands in source, not the pre-escaped form.
    //
    // Capture pattern: temporarily swap `state.out` to a single-char
    // sentinel and clear `state.delim` / `state.closed` so renderInline
    // doesn't fire flushClose padding or prepend block delimiters
    // (e.g. the `> ` from a callout-wrapped table) into our captured
    // cell content. Restore after capture so the actual table writes
    // emit prefixes correctly.
    const renderCellToString = (c: PMNode): string => {
      const savedOut = state.out;
      const stateAny = state as unknown as { delim: string; closed: boolean };
      const savedDelim = stateAny.delim;
      const savedClosed = stateAny.closed;
      state.out = "x"; // anchor - atBlankLine() returns false
      stateAny.delim = "";
      stateAny.closed = false;
      state.renderInline(c);
      const captured = state.out.slice(1)
        .replace(/\\?\n/g, "<br>")
        .replace(/\|/g, "\\|");
      state.out = savedOut;
      stateAny.delim = savedDelim;
      stateAny.closed = savedClosed;
      return captured;
    };

    // Phase 1: render every cell to a string, collect alignment.
    const hdr = node.child(0);
    const aligns: (string | null)[] = [];
    for (let i = 0; i < hdr.childCount; i++) {
      const a = (hdr.child(i).attrs as { alignment?: unknown }).alignment;
      aligns.push(typeof a === "string" ? a : null);
    }
    const colCount = hdr.childCount;
    const renderedRows: string[][] = [];
    for (let r = 0; r < node.childCount; r++) {
      const row = node.child(r);
      const cells: string[] = [];
      for (let c = 0; c < row.childCount; c++) {
        cells.push(renderCellToString(row.child(c)));
      }
      // Pad sparse rows (rare - should match colCount in well-formed
      // tables, but tolerate just in case).
      while (cells.length < colCount) cells.push("");
      renderedRows.push(cells);
    }

    // Phase 2: compute per-column widths.
    // Minimum alignment-marker widths:
    //   none:   `---`     → 3
    //   left:   `:---`    → 4
    //   right:  `---:`    → 4
    //   center: `:---:`   → 5
    const minMarkerWidth = (a: string | null): number =>
      a === "center" ? 5 : (a === "left" || a === "right") ? 4 : 3;
    const widths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      let w = minMarkerWidth(aligns[c]);
      for (const row of renderedRows) {
        const cellLen = (row[c] ?? "").length;
        if (cellLen > w) w = cellLen;
      }
      widths.push(w);
    }

    // Helper: build the alignment marker padded to `width`.
    const buildMarker = (a: string | null, width: number): string => {
      // Each branch carries its colons in the right slots and fills
      // the rest with dashes, ensuring total length === width.
      if (a === "left") return ":" + "-".repeat(Math.max(3, width - 1));
      if (a === "right") return "-".repeat(Math.max(3, width - 1)) + ":";
      if (a === "center")
        return ":" + "-".repeat(Math.max(3, width - 2)) + ":";
      return "-".repeat(Math.max(3, width));
    };

    // Phase 3: write padded rows. Cells are left-justified in source
    // (text + spaces). Visual alignment in the rendered table comes
    // from the separator row's colons; source-side padding is just
    // for source-on-disk readability.
    const writeRow = (cells: string[]) => {
      state.write("|");
      for (let c = 0; c < colCount; c++) {
        const text = cells[c] ?? "";
        const pad = " ".repeat(Math.max(0, widths[c] - text.length));
        state.write(" " + text + pad + " |");
      }
      state.write("\n");
    };
    writeRow(renderedRows[0] ?? []);
    // Separator row.
    state.write("|");
    for (let c = 0; c < colCount; c++) {
      state.write(" " + buildMarker(aligns[c], widths[c]) + " |");
    }
    state.write("\n");
    // Body rows.
    for (let r = 1; r < node.childCount; r++) {
      writeRow(renderedRows[r] ?? []);
    }
    state.write("\n");
  },
  table_row() {},
  table_header() {},
  table_cell() {},

  /** Raw passthrough - emit the stored bytes verbatim. Source
   *  preservation holds even when Butter doesn't understand the
   *  content; bytes go in, bytes come out. */
  raw_block(state, node) {
    // Write without any escaping - the raw attr IS the source.
    state.text((node.attrs.raw as string | undefined) ?? "", false);
    state.closeBlock(node);
  },

  // Obsidian blocks
  obsidian_callout(state, node) {
    const a = node.attrs as { calloutType?: string; foldState?: string; title?: string };
    const type = a.calloutType || "note";
    const fold = a.foldState ?? "";
    const tp = a.title ? ` ${a.title}` : "";
    state.wrapBlock("> ", null, node, () => {
      state.write(`[!${type}]${fold}${tp}\n`);
      // Insert a blank line separator if the first body block could
      // be interpreted by markdown-it as setext-heading underline of
      // the `[!type]` opener line. `---` and `===` are the two
      // setext-h underline markers; an HR (`---`) as the first child
      // would otherwise re-parse as a level-2 heading "[!type]"
      // INSIDE the callout (the callout itself still parses, but
      // its first body block is the heading instead of the HR).
      // Writing an explicit blank line breaks the setext attachment
      // - `---` after a blank line is unambiguously a HR.
      const first = node.firstChild;
      if (first && first.type.name === "horizontal_rule") {
        state.write("\n");
      }
      state.renderContent(node);
    });
  },
  obsidian_embed(state, node) {
    state.write(`![[${(node.attrs.src as string | undefined) ?? ""}]]`);
    state.closeBlock(node);
  },
  obsidian_embed_inline(state, node) {
    state.write(`![[${(node.attrs.src as string | undefined) ?? ""}]]`);
  },
  math_block(state, node) {
    state.write("$$");
    state.write("\n");
    state.text((node.attrs.value as string | undefined) ?? "", false);
    state.write("\n");
    state.write("$$");
    state.closeBlock(node);
  },
  block_comment(state, node, parent, index) {
    const value = ((node.attrs.value as string | undefined) ?? "");
    const isEmpty = value.length === 0;
    const isListBreak = value === "list-break";

    // Stale-separator cleanup. Both empty (`%% %%`) and list-break
    // (`%%list-break%%`) comments only serve a purpose between two
    // adjacent same-type lists (where they prevent CommonMark from
    // merging the lists on reparse). If the surrounding context
    // isn't that, the comment is leftover noise - most commonly
    // from a previous save where adjacent lists got dragged apart,
    // leaving the separator stranded. Skip emitting it; the auto-
    // injection in renderList will regenerate one if needed on the
    // next save where adjacency returns.
    //
    // Non-empty comments OTHER than the `list-break` sentinel
    // (user-authored notes inside `%%...%%`) are never dropped
    // only the exact-shape separator forms.
    if ((isEmpty || isListBreak) && parent != null && index != null) {
      const prev = index > 0 ? parent.child(index - 1) : null;
      const next =
        index < parent.childCount - 1 ? parent.child(index + 1) : null;
      // Flat-list model: two list_items at same kind+depth that the
      // user wants visually separated (not a continuation) need this
      // sentinel between them. Without it the markdown reparser would
      // merge them into one list.
      const isSeparator =
        prev != null &&
        next != null &&
        prev.type.name === "list_item" &&
        next.type.name === "list_item" &&
        prev.attrs.kind === next.attrs.kind &&
        prev.attrs.depth === next.attrs.depth;
      if (!isSeparator) return; // drop stale separator
    }

    // Single-line forms for the two recognized separator shapes.
    // Empty stays as `%% %%` (back-compat with anything saved before
    // the labeled form shipped); list-break emits as the descriptive
    // `%%list-break%%`. Both round-trip via the parser's single-line
    // sentinel detection. Other content emits the traditional
    // multi-line `%%\n<value>\n%%` form so user-authored notes keep
    // their layout.
    if (isEmpty) {
      state.write("%% %%");
      state.closeBlock(node);
      return;
    }
    if (isListBreak) {
      state.write("%%list-break%%");
      state.closeBlock(node);
      return;
    }
    state.write("%%");
    state.write("\n");
    state.text(value, false);
    state.write("\n");
    state.write("%%");
    state.closeBlock(node);
  },

  // Footnotes
  footnote_ref(state, node) {
    const label = (node.attrs.label as string | undefined) ?? "";
    state.write(`[^${label}]`);
  },
  footnote_def(state, node) {
    const label = (node.attrs.label as string | undefined) ?? "";
    const content = (node.attrs.content as string | undefined) ?? "";
    const lines = content.split("\n");
    state.write(`[^${label}]: ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) state.write(`\n    ${lines[i]}`);
    state.closeBlock(node);
  },

  // Obsidian inline
  wikilink(state, node) {
    const a = node.attrs as { target?: string; alias?: string };
    const target = a.target ?? "";
    const alias = a.alias ?? "";
    state.write(alias ? `[[${target}|${alias}]]` : `[[${target}]]`);
  },
  obsidian_tag(state, node) {
    state.write(`#${(node.attrs.tag as string | undefined) ?? ""}`);
  },
  inline_math(state, node) {
    state.write(`$${(node.attrs.value as string | undefined) ?? ""}$`);
  },
  inline_footnote(state, node) {
    state.write(`^[${(node.attrs.content as string | undefined) ?? ""}]`);
  },
  block_id(state, node) {
    state.write(`^${(node.attrs.id as string | undefined) ?? ""}`);
  },
};

// ── Late-apply hook: wire extensions into live tables ──────────
// Handles both pre-bridge-init registrations (caught up by
// setBridgeLateApplyHandler's initial loop) AND runtime registrations
// (each new registerSyntaxExtension call fires this handler).
//
// Schema additions are NOT applied here - the PM schema is immutable
// after construction. An extension introducing a brand-new schema
// node name must register before ./schema evaluates its module body
// (i.e., via side-effect imports ordered before `import ./schema`).
setBridgeLateApplyHandler((ext: ButterSyntaxExtension) => {
  if (ext.markdownItRule) {
    try {
      ext.markdownItRule(md);
    } catch (err) {
      console.warn(
        `[butter] extension "${ext.name}" markdownItRule threw at apply:`,
        err,
      );
    }
  }
  if (ext.tokenHandlers) {
    for (const [k, fn] of Object.entries(ext.tokenHandlers)) {
      handlers[k] = fn;
    }
  }
  if (ext.serializer) {
    nodeSer[ext.name] = ext.serializer;
  }
  if (ext.sourcePattern) {
    extensionSourcePatterns.push({ name: ext.name, fn: ext.sourcePattern });
  }
});

// ── Public serialize ──

function serialize(doc: PMNode, options?: CanonicalFormOptions): string {
  const state = new SerState(options);
  state.renderContent(doc);
  return state.out;
}

/**
 * Serialize a single top-level block to markdown in isolation.
 * Used by the source-preserving serializer below for nodes whose
 * sourceRange is null (inserted, edited, or otherwise synthesized
 * without an original byte range to emit).
 *
 * When `context` is provided, inline atoms inside the block that
 * are still reference-identical to their parse-time originals emit
 * their original source bytes verbatim (byte-level preservation
 * within an edited block). When context is null, normal canonical
 * synthesis happens.
 */
function serializeBlock(
  block: PMNode,
  context?: {
    originalBody: string;
    originalInlineAtoms: Set<PMNode>;
  },
  options?: CanonicalFormOptions,
): string {
  const wrap = schema.nodes.doc.create(null, Fragment.from(block));
  const state = new SerState(options);
  if (context) {
    state.sourcePresBody = context.originalBody;
    state.sourcePresOriginalAtoms = context.originalInlineAtoms;
  }
  state.renderContent(wrap);
  return state.out;
}

/** Collect every inline atom in `doc` into a reference-identity set.
 *  Used as the "original inline atoms" set at save time so reference
 *  checks can tell whether an atom in the current doc has survived
 *  untouched from the parse-time tree. */
function collectInlineAtoms(doc: PMNode): Set<PMNode> {
  const set = new Set<PMNode>();
  doc.descendants((node) => {
    if (node.isInline && node.isAtom) set.add(node);
  });
  return set;
}

/**
 * Source-preserving serialize.
 *
 * Walks the current doc's top-level children. For each child:
 *   • Node is reference-identical to one of the originalDoc's children
 *     AND has a valid sourceRange → emit `originalBody.slice(start, end)`
 *     verbatim. Zero bytes mutated, zero escaping decisions re-made,
 *     zero formatting preferences re-applied.
 *   • Otherwise → serialize through the normal block serializer,
 *     cushioned by `\n\n` separators so it doesn't glue onto
 *     neighbors.
 *
 * Why reference identity? ProseMirror's immutable-tree model means
 * a node's JS reference survives if-and-only-if no step has mutated
 * it. Structural sharing: an edit in one paragraph produces a new
 * doc whose other paragraphs are the SAME objects as before. So
 * `originals.has(child)` is a precise "this node has not been
 * mutated since parse" check. Cheaper than content hashing and
 * correct against every PM step type including splits/merges (which
 * always produce new node objects).
 *
 * Drag-reordered blocks retain reference identity - the same node
 * object lands at a new index. We emit its original bytes in the
 * new position. That's preservation-through-drag by construction.
 *
 * Inserted / edited / split / pasted blocks are NEW references →
 * synthesized fresh, surrounded by original bytes of the survivors.
 *
 * This is the mechanism that makes the invariant true: bytes the
 * user didn't touch stay byte-identical on save.
 */
function serializeWithSourcePreservation(
  doc: PMNode,
  originalBody: string,
  originalDoc: PMNode,
  options?: CanonicalFormOptions,
): string {
  // ── Identity map: parse-time block → its index in originalDoc ──
  // Reference identity is the STRICT "this block wasn't edited" check
  // (PM's immutable-tree model means an edit produces a new object).
  // Byte identity (same sourceRange.start) is the LENIENT "this was
  // originally THIS block, even if edited" check - PM preserves attrs
  // through ReplaceStep, so a content-only edit keeps sourceRange on
  // the new node. Byte identity lets us look up the ORIGINAL gap
  // between two blocks even when one has been edited in place.
  const originalBlocks: PMNode[] = [];
  originalDoc.forEach((child) => originalBlocks.push(child));
  const originalRefs = new Set<PMNode>(originalBlocks);
  const origIndexByStart = new Map<number, number>();
  for (let i = 0; i < originalBlocks.length; i++) {
    const r = originalBlocks[i].attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (r && typeof r.start === "number" && r.start >= 0) {
      origIndexByStart.set(r.start, i);
    }
  }

  // Reference-identity set of EVERY inline atom that existed in the
  // parse-time doc. When a block is edited (its reference changed)
  // but some of its inline atoms survived untouched, those atoms
  // still have their original byte ranges and can be spliced in
  // verbatim during block synthesis. This is the mechanism for
  // byte-level preservation WITHIN an edited block.
  const originalInlineAtoms = collectInlineAtoms(originalDoc);
  const blockSynthCtx = { originalBody, originalInlineAtoms };

  // Identify each current block: its origIdx (if any) and whether
  // it's still reference-identical (unchanged).
  const n = doc.childCount;
  type BlockIdent = { origIdx: number | null; preserved: boolean };
  const ids: BlockIdent[] = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const r = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    const origIdx =
      r && typeof r.start === "number" && origIndexByStart.has(r.start)
        ? origIndexByStart.get(r.start)!
        : null;
    ids.push({ origIdx, preserved: originalRefs.has(child) });
  }

  // Content emission per block: either preserved original bytes (if
  // reference-identical AND has a valid sourceRange) or synthesized
  // canonical bytes. Content includes the block's own line-ending \n
  // but NOT any inter-block blank lines.
  const contents: string[] = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const range = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    const canPreserve =
      ids[i].preserved &&
      range &&
      typeof range.start === "number" &&
      typeof range.end === "number" &&
      range.start >= 0 &&
      range.end >= range.start &&
      range.end <= originalBody.length;

    if (canPreserve && range) {
      contents.push(originalBody.slice(range.start, range.end));
    } else {
      contents.push(normalizeBlockSynth(serializeBlock(child, blockSynthCtx, options)));
    }
  }

  // Leading whitespace: the bytes before the first block's content.
  // Preserved only if the current first block's origIdx is 0 (same
  // block sits at doc start). Otherwise reordering moved a different
  // block to the top and the original leading whitespace no longer
  // applies.
  let leading = "";
  if (n > 0 && ids[0].origIdx === 0) {
    const r = doc.firstChild!.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (r && r.start >= 0 && r.start <= originalBody.length) {
      leading = originalBody.slice(0, r.start);
    }
  }

  // Inter-block gaps: for each adjacent pair, preserve the original
  // gap ONLY if the pair was adjacent in the same order in the
  // original doc. Otherwise (reorder, insertion, deletion broke the
  // pairing) emit a default gap - a single blank line, which is the
  // CommonMark minimum for separating two paragraphs and a safe
  // no-merge separator for any block-type pair.
  //
  // Special case: the parser may assign a block's range to ABSORB
  // its trailing blank-line bytes (range.end == next block's
  // range.start ⇒ originalBody.slice between them is `""`). When
  // both endpoints are reference-preserved, the absorbed blank line
  // travels with the preserved bytes and the empty gap is correct.
  // But when EITHER block has been synthesized, the canonical
  // synthesis emits only its own trailing `\n` and does NOT carry
  // the absorbed blank-line bytes - leaving the next block lazy-
  // continuing into the previous one. Inject the default separator
  // in that specific case to keep the structural boundary intact.
  // Multi-blank-line gaps (gapBytes.length > 0) still pass through
  // unchanged, preserving the user-authored whitespace.
  const gaps: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = ids[i];
    const b = ids[i + 1];
    if (
      a.origIdx !== null &&
      b.origIdx !== null &&
      b.origIdx === a.origIdx + 1
    ) {
      const aOrig = originalBlocks[a.origIdx];
      const bOrig = originalBlocks[b.origIdx];
      const aR = aOrig.attrs.sourceRange as
        | { start: number; end: number }
        | null;
      const bR = bOrig.attrs.sourceRange as
        | { start: number; end: number }
        | null;
      if (
        aR &&
        bR &&
        aR.end >= 0 &&
        bR.start >= aR.end &&
        bR.start <= originalBody.length
      ) {
        const gapBytes = originalBody.slice(aR.end, bR.start);
        const synthesizedEdge = !a.preserved || !b.preserved;
        if (synthesizedEdge && gapBytes.length === 0) {
          gaps.push(defaultGap());
        } else {
          gaps.push(gapBytes);
        }
        continue;
      }
    }
    gaps.push(defaultGap());
  }

  // Trailing whitespace: bytes after the last block's content.
  // Preserved only if the current last block is the same as the
  // original last block (same origIdx at the end).
  let trailing = "";
  if (n > 0 && ids[n - 1].origIdx === originalBlocks.length - 1) {
    const r = doc.lastChild!.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (r && r.end >= 0 && r.end <= originalBody.length) {
      trailing = originalBody.slice(r.end, originalBody.length);
    }
  }

  // Assemble.
  //
  // Each `contents[i]` is expected to end with `\n` so the gap (a
  // single `\n` for a blank line) sums to two `\n`s - the CommonMark
  // separator for adjacent blocks. The synthesis path normalizes its
  // emit via `normalizeBlockSynth`. For preserved bytes, the parser
  // *usually* includes the block's trailing `\n` in its content range,
  // EXCEPT for the original-last block, whose trailing `\n` is captured
  // in `trailing` (so it survives no-op saves byte-for-byte). When a
  // reorder moves the original-last block out of the last position, its
  // content slice ends without `\n` and the gap that follows can no
  // longer create a proper separator. Force-end every content with `\n`
  // here when the next block follows (or when there's no trailing left
  // to provide the file-ending newline) - idempotent against the
  // already-`\n`-terminated case.
  let out = leading;
  for (let i = 0; i < n; i++) {
    let c = contents[i];
    if (i < n - 1 && !c.endsWith("\n")) c = c + "\n";
    out += c;
    if (i < n - 1) out += gaps[i];
  }
  out += trailing;
  return out;
}

/** Default inter-block gap: one blank line.
 *
 *  Why one blank and not zero: a paragraph-paragraph pair with zero
 *  blanks between would re-parse as a single soft-broken paragraph
 *  (CommonMark), changing doc structure on round-trip. One blank is
 *  the safe no-merge separator for any block-type pair.
 *
 *  The content bytes of each block always END with their own line-
 *  ending `\n`, so this function returns just the EXTRA `\n` that
 *  creates a blank line between them: emitted output looks like
 *  `content_a` + `\n` + `\n` + `content_b` (two `\n` = one blank
 *  line, per CommonMark).
 */
function defaultGap(): string {
  return "\n";
}

/** Normalize a freshly-synthesized block body to end with exactly one
 *  `\n`. serializeBlock emits the block's content without a consistent
 *  trailing newline (paragraphs emit "text", headings emit "# text",
 *  code fences emit "```lang\n...\n```" - each varies). Callers that
 *  treat content-emission as "content + line-ending \n" rely on this
 *  to keep subsequent gap math deterministic. */
function normalizeBlockSynth(synth: string): string {
  let s = synth;
  while (s.endsWith("\n")) s = s.slice(0, -1);
  return s + "\n";
}

// ═══════════════════════════════════════════════
//  INCREMENTAL PARSE
// ═══════════════════════════════════════════════

/**
 * Common-prefix + common-suffix diff. Returns the byte range that
 * changed between `oldBody` and `newBody`. For a single contiguous
 * edit this is exact. For multi-region edits, this returns the
 * smallest range that covers all the changes - which means the
 * incremental parser sees them as one big change and (usually)
 * falls back to full parse.
 */
function findChangedByteRange(oldBody: string, newBody: string): {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
} {
  let prefix = 0;
  const maxPrefix = Math.min(oldBody.length, newBody.length);
  while (prefix < maxPrefix && oldBody[prefix] === newBody[prefix]) prefix++;

  let oldEnd = oldBody.length;
  let newEnd = newBody.length;
  while (
    oldEnd > prefix &&
    newEnd > prefix &&
    oldBody[oldEnd - 1] === newBody[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  return { oldStart: prefix, oldEnd, newStart: prefix, newEnd };
}

/**
 * Incremental parse. When the diff fits inside exactly one
 * top-level block, reparse that block in isolation and splice the
 * result into oldDoc. Surviving blocks keep their JS references
 * (source-preservation invariant: unedited blocks are reference-
 * identical → emit original bytes on save).
 *
 * Returns null to signal "fall back to full parseWithSourceMap" on:
 *   - changes spanning multiple blocks,
 *   - changes at block boundaries we can't cleanly handle,
 *   - reparse producing an unexpected number of blocks,
 *   - any parse error in the isolated sub-parse.
 */
function parseIncrementally(
  oldBody: string,
  newBody: string,
  oldDoc: PMNode,
): SourceMapResult | null {
  if (oldBody === newBody) {
    // No-op change - trivially reuse oldDoc. Recompute blockRanges
    // from the doc's existing sourceRange attrs.
    const blockRanges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < oldDoc.childCount; i++) {
      const r = oldDoc.child(i).attrs.sourceRange as
        | { start: number; end: number }
        | null;
      blockRanges.push(r ?? { start: -1, end: -1 });
    }
    return { doc: oldDoc, blockRanges };
  }

  const { oldStart, oldEnd, newStart, newEnd } = findChangedByteRange(
    oldBody,
    newBody,
  );

  // Identify the block in oldDoc whose sourceRange strictly contains
  // the changed byte range [oldStart, oldEnd).
  //
  // Pure insertions at block boundaries (oldStart === oldEnd and
  // equals block.start or block.end) are ambiguous - could be the
  // end of this block or the start of the next. Fall back to full
  // parse for safety; markdown-it determines the structural
  // assignment correctly in the global context.
  let targetIdx = -1;
  for (let i = 0; i < oldDoc.childCount; i++) {
    const r = oldDoc.child(i).attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (!r) return null; // missing range ⇒ fall back
    if (r.start <= oldStart && oldEnd <= r.end) {
      const insertionAtBoundary =
        oldStart === oldEnd &&
        (oldStart === r.start || oldStart === r.end);
      if (insertionAtBoundary) return null;
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return null; // change crosses a block boundary

  const target = oldDoc.child(targetIdx);
  const targetRange = target.attrs.sourceRange as { start: number; end: number };

  // Compute the block's new byte range in newBody.
  const delta = (newEnd - newStart) - (oldEnd - oldStart);
  const newBlockStart = targetRange.start;
  const newBlockEnd = targetRange.end + delta;
  const newBlockBody = newBody.slice(newBlockStart, newBlockEnd);

  // Parse the isolated block's new body. It should produce exactly
  // one top-level block of the same shape; if not, fall back.
  const subResult = parseWithSourceMap(newBlockBody);
  if (!subResult || subResult.doc.childCount !== 1) return null;

  const newBlock = subResult.doc.firstChild!;

  // Structural change detection: if the sub-parsed block's TYPE differs
  // from the original (e.g., was list_item, edit dropped the marker so
  // now parses as paragraph), the full-document context might absorb
  // this content into a sibling block (markdown-it merges adjacent
  // paragraph-like content into list-item continuations). Falling back
  // to full parse is the safe choice; otherwise our spliced doc has a
  // shape that diverges from what a from-scratch parse would produce.
  if (newBlock.type !== target.type) return null;
  // Same defense for list_item shape: if the kind/depth/checked/start
  // attrs differ, the marker structure changed and a full parse would
  // re-evaluate the surrounding list context.
  if (target.type.name === "list_item") {
    const t = target.attrs as {
      kind?: unknown; depth?: unknown; checked?: unknown; start?: unknown;
    };
    const n = newBlock.attrs as {
      kind?: unknown; depth?: unknown; checked?: unknown; start?: unknown;
    };
    if (
      t.kind !== n.kind ||
      t.depth !== n.depth ||
      t.checked !== n.checked ||
      t.start !== n.start
    ) {
      return null;
    }
  }
  // Adjust the new block's sourceRange to point into newBody, not
  // into the sliced sub-body.
  const shiftedNewBlock = newBlock.type.create(
    {
      ...newBlock.attrs,
      sourceRange: { start: newBlockStart, end: newBlockEnd },
    },
    newBlock.content,
    newBlock.marks,
  );

  // Rebuild the doc's children: copy everything before targetIdx
  // verbatim (reference-preserving), substitute the new block,
  // then copy everything after - with sourceRanges shifted by delta.
  const newChildren: PMNode[] = [];
  const blockRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < oldDoc.childCount; i++) {
    if (i < targetIdx) {
      newChildren.push(oldDoc.child(i));
      const r = oldDoc.child(i).attrs.sourceRange as {
        start: number;
        end: number;
      };
      blockRanges.push(r);
    } else if (i === targetIdx) {
      newChildren.push(shiftedNewBlock);
      blockRanges.push({ start: newBlockStart, end: newBlockEnd });
    } else {
      const r = oldDoc.child(i).attrs.sourceRange as {
        start: number;
        end: number;
      };
      const shifted = { start: r.start + delta, end: r.end + delta };
      newChildren.push(
        oldDoc.child(i).type.create(
          { ...oldDoc.child(i).attrs, sourceRange: shifted },
          oldDoc.child(i).content,
          oldDoc.child(i).marks,
        ),
      );
      blockRanges.push(shifted);
    }
  }

  // Byte-coverage sanity: reconstruct newBody from content-only ranges
  // interleaved with inter-block gaps (leading + content + gap + ... +
  // trailing). If the assembled bytes don't match newBody exactly, the
  // delta math was off - fall back to full parse.
  let covered = "";
  const nRanges = blockRanges.length;
  if (nRanges === 0) {
    if (newBody.length !== 0) return null;
  } else {
    for (let i = 0; i < nRanges; i++) {
      const r = blockRanges[i];
      if (i === 0) covered += newBody.slice(0, r.start);
      covered += newBody.slice(r.start, r.end);
      if (i < nRanges - 1) {
        covered += newBody.slice(r.end, blockRanges[i + 1].start);
      } else {
        covered += newBody.slice(r.end, newBody.length);
      }
    }
    if (covered !== newBody) return null;
  }

  const newDoc = oldDoc.type.create(
    oldDoc.attrs,
    Fragment.fromArray(newChildren),
    oldDoc.marks,
  );
  return { doc: newDoc, blockRanges };
}

// ═══════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════

export { type SourceMapResult };

export const parser = {
  /** Parse markdown into a ProseMirror doc. */
  parse(markdown: string): PMNode | null {
    return parse(markdown);
  },

  /**
   * Source-preserving parse (first-class).
   *
   * Returns the PM doc AND per-block character-offset ranges in a
   * single pass - no double-tokenize, no external shim. The ranges
   * are 1:1 with `doc.childCount` when the parse is clean; callers
   * disable preservation on mismatch.
   */
  parseWithSourceMap(markdown: string): SourceMapResult | null {
    return parseWithSourceMap(markdown);
  },

  /**
   * Incremental parse - when the change between `oldBody` and
   * `newBody` is contained within a single top-level block, reparse
   * only that block and splice it into `oldDoc`. Surrounding blocks
   * keep their JS references (source-preservation invariant stays
   * intact: unedited blocks remain reference-identical).
   *
   * Returns `null` when the change spans multiple blocks, crosses a
   * block boundary, or produces an incompatibly-shaped reparse; the
   * caller should fall back to a full `parseWithSourceMap`.
   *
   * This is an optimization hook, not a correctness prerequisite
   * the full parse is already fast (see test-bench.mjs). Useful for
   * very large docs where even a 50ms full parse is noticeable, or
   * as the foundation for live-incremental-editing features.
   */
  parseIncrementally(
    oldBody: string,
    newBody: string,
    oldDoc: PMNode,
  ): SourceMapResult | null {
    return parseIncrementally(oldBody, newBody, oldDoc);
  },
};

export const serializer = {
  /** Plain serialize - used for round-trip tests and anywhere the
   *  caller wants PMX to re-synthesize the entire doc from scratch.
   *  Optional `options` configure canonical-form preferences (bullet
   *  marker, italic/bold style, fence/HR character). */
  serialize(doc: PMNode, options?: CanonicalFormOptions): string {
    return serialize(doc, options);
  },

  /** Source-preserving serialize - emits original bytes for nodes
   *  still reference-identical to the parse-time doc, synthesizes
   *  fresh for any node whose content (text or structure) has
   *  diverged. `options` apply only to the synthesized blocks; the
   *  preserved bytes pass through unchanged regardless. */
  serializeWithSourcePreservation(
    doc: PMNode,
    originalBody: string,
    originalDoc: PMNode,
    options?: CanonicalFormOptions,
  ): string {
    return serializeWithSourcePreservation(doc, originalBody, originalDoc, options);
  },
};

