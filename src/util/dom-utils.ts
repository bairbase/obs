/**
 * Return the nearest scrolling ancestor of `el`, or null if none.
 * A scroll ancestor is the element that clips and scrolls the
 * descendants - its own position on screen is stable while its
 * contents move.
 */
export function scrollHost(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const s = getComputedStyle(cur);
    if (
      /(auto|scroll|overlay)/.test(s.overflowY) &&
      cur.scrollHeight > cur.clientHeight + 1
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Return the viewport-top y-coordinate of the nearest scrolling
 * ancestor of `el`, or 0 if none. Callers use this as the reference
 * point for "is this heading above the fold?" checks.
 */
export function scrollHostTop(el: HTMLElement): number {
  return scrollHost(el)?.getBoundingClientRect().top ?? 0;
}
