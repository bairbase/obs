/**
 * Collapsible spoiler block NodeView for `::: spoiler` syntax.
 * UI-only collapse state — does not touch the save pipeline.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

function spoilerLabel(node: PMNode): string {
  const raw = (node.attrs as { label?: unknown }).label;
  return typeof raw === "string" ? raw.trim() : "";
}

export function spoilerView() {
  return (
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
  ): NodeView => {
    const dom = activeDocument.createElement("div");
    dom.className = "butter-spoiler";
    dom.setAttribute("data-butter-spoiler", "");

    const header = activeDocument.createElement("button");
    header.type = "button";
    header.className = "butter-spoiler-header";
    header.setAttribute("aria-expanded", "false");

    const chevron = activeDocument.createElement("span");
    chevron.className = "butter-spoiler-chevron";
    chevron.textContent = "▸";
    chevron.setAttribute("aria-hidden", "true");

    const title = activeDocument.createElement("span");
    title.className = "butter-spoiler-label";

    const syncLabel = (n: PMNode) => {
      const label = spoilerLabel(n);
      if (label) {
        dom.setAttribute("data-label", label);
        title.textContent = `Spoiler: ${label}`;
      } else {
        dom.removeAttribute("data-label");
        title.textContent = "Spoiler";
      }
    };
    syncLabel(node);

    header.appendChild(chevron);
    header.appendChild(title);

    const content = activeDocument.createElement("div");
    content.className = "butter-spoiler-content";
    content.hidden = true;

    const setExpanded = (expanded: boolean) => {
      dom.classList.toggle("is-expanded", expanded);
      content.hidden = !expanded;
      header.setAttribute("aria-expanded", expanded ? "true" : "false");
      chevron.textContent = expanded ? "▾" : "▸";
    };

    header.addEventListener("click", (e) => {
      e.preventDefault();
      setExpanded(!dom.classList.contains("is-expanded"));
    });

    dom.appendChild(header);
    dom.appendChild(content);

    return {
      dom,
      contentDOM: content,
      update(updated) {
        if (updated.type !== node.type) return false;
        syncLabel(updated);
        return true;
      },
      stopEvent(event) {
        return header.contains(event.target as Node);
      },
      ignoreMutation(record) {
        return header.contains(record.target);
      },
    };
  };
}
