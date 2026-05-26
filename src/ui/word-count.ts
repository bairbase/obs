/**
 * Status-bar word + character count for the active Butter view.
 *
 *   • Shows `W 234 · C 1,456` by default.
 *   • When the selection is non-empty, swaps to the selected range
 *     and marks with a bullet prefix: `W 12 · C 78`.
 *   • Click the item to toggle detail mode on/off (reading time).
 *   • Updates on every PM doc change + selection change via polling
 *     at 250ms (much cheaper than subscribing to PM transactions
 *     through a per-view shim and accurate enough for a status
 *     counter).
 */
import type { Plugin } from "obsidian";
import type { EditorView } from "prosemirror-view";

interface Counts {
  words: number;
  chars: number;
  selection: boolean;
}

function countText(text: string): { words: number; chars: number } {
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  return { words, chars };
}

function formatCount(c: Counts, showReading: boolean): string {
  const fmt = (n: number) => n.toLocaleString();
  const base = `W ${fmt(c.words)} · C ${fmt(c.chars)}`;
  if (!showReading) return c.selection ? `◆ ${base}` : base;
  const minutes = Math.max(1, Math.round(c.words / 225));
  const reading = `${minutes} min`;
  return c.selection ? `◆ ${base} · ${reading}` : `${base} · ${reading}`;
}

export function installWordCount(
  plugin: Plugin,
  getActivePM: () => EditorView | null,
) {
  const el = plugin.addStatusBarItem();
  el.addClass("butter-status-wordcount");
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", "Word / character count · click for reading time");

  let showReading = false;
  let lastDoc: unknown = null;
  let lastFrom = -1;
  let lastTo = -1;
  let stableSince = 0;
  let lastCountedAt = 0;

  el.addEventListener("click", () => {
    showReading = !showReading;
    stableSince = 0; // force an update on next tick
    lastCountedAt = 0;
    tick();
  });

  const tick = () => {
    const pm = getActivePM();
    if (!pm) {
      el.addClass("butter-hidden");
      return;
    }
    el.removeClass("butter-hidden");

    const doc = pm.state.doc;
    const { from, to } = pm.state.selection;
    const now = Date.now();

    // Defer the heavy textBetween walk until the user has been idle
    // for a short window. For 5000+ line docs the walk is 50-100ms
    // on main thread - running it every 250ms mid-typing blocks
    // keystrokes in a visible rhythm. We still fall through on a
    // longer max-staleness interval so the count keeps updating
    // during long continuous typing sessions.
    const IDLE_MS = 300;
    const MAX_STALE_MS = 4000;
    if (doc !== lastDoc || from !== lastFrom || to !== lastTo) {
      lastDoc = doc;
      lastFrom = from;
      lastTo = to;
      stableSince = now;
      if (now - lastCountedAt < MAX_STALE_MS) return;
    } else if (now - stableSince < IDLE_MS) {
      return;
    }

    const selecting = from !== to;
    const text = selecting
      ? doc.textBetween(from, to, "\n", "\n")
      : doc.textBetween(0, doc.content.size, "\n", "\n");
    const { words, chars } = countText(text);
    el.setText(
      formatCount({ words, chars, selection: selecting }, showReading),
    );
    lastCountedAt = now;
  };

  plugin.registerInterval(window.setInterval(tick, 250));
  tick();
}
