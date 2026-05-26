/**
 * License-required banner. Visible whenever the plugin's
 * `licenseStatus` is anything other than `valid` or `trial`.
 *
 * Placement: attaches to the toolbar stack (same parent as the main
 * formatting toolbar) so the banner reads as another toolbar row -
 * the same chrome language as the table toolbar that docks adjacent
 * to the main toolbar when a table is focused. When the user changes
 * toolbarPosition / toolbarStyle, the view re-calls `refresh()` and
 * the banner re-locates itself.
 *
 * "Read-only with a banner" was the chosen UX over hard-blocking
 * file-open: avoids feeling destructive when a paying customer is
 * temporarily offline + their cached session expires, and gives
 * unlicensed users a path to evaluate the visual quality before
 * starting a trial.
 */

import { setIcon } from "obsidian";
import type ButterEditorPlugin from "../main";

const BANNER_CLASS = "butter-license-banner";

export interface LicenseBanner {
  /** Re-evaluates the plugin's `licenseStatus` and shows / hides /
   *  re-renders the banner accordingly. Called from the
   *  `butter:license-changed` workspace listener, on view open,
   *  and after applyToolbarPosition swaps the toolbar's parent. */
  refresh(): void;
  /** Removes the banner DOM. Call from the view's `onClose()`. */
  destroy(): void;
}

/**
 * Mount the banner. `viewContainer` is the ButterEditorView's outer
 * containerEl - we query inside it for the main toolbar to find the
 * stack to dock into, and fall back to prepending to the view's
 * contentEl if the toolbar isn't mounted yet (edge case during
 * initial render before applyToolbarPosition has run).
 */
export function mountLicenseBanner(
  viewContainer: HTMLElement,
  contentFallback: HTMLElement,
  plugin: ButterEditorPlugin,
): LicenseBanner {
  let bannerEl: HTMLElement | null = null;

  const findToolbar = (): HTMLElement | null =>
    viewContainer.querySelector(".butter-toolbar");

  const placeAdjacentToToolbar = (el: HTMLElement) => {
    const toolbar = findToolbar();
    if (!toolbar || !toolbar.parentElement) {
      // No toolbar yet - fall back to top of contentEl. refresh()
      // will be called again once the toolbar mounts.
      if (el.parentElement !== contentFallback) contentFallback.prepend(el);
      return;
    }
    const stack = toolbar.parentElement;
    // Position: banner sits on the FAR SIDE of the toolbar from
    // content. toolbarPosition=top → banner above the main toolbar;
    // toolbarPosition=bottom → banner below the main toolbar. Either
    // way the banner is the row furthest from the user's editing area.
    const pos = toolbar.getAttribute("data-toolbar-pos") || "top";
    if (pos === "bottom") {
      // Banner should be below the toolbar (visually the last row of
      // the chrome stack). Insert after main toolbar; if a table
      // toolbar is also in the stack we sit AFTER it too.
      if (el.parentElement !== stack || el !== stack.lastElementChild) {
        stack.appendChild(el);
      }
    } else {
      // Banner above the toolbar (first row of the chrome stack).
      if (el.parentElement !== stack || el !== stack.firstElementChild) {
        stack.insertBefore(el, stack.firstChild);
      }
    }
  };

  const render = () => {
    const status = plugin.licenseStatus;
    const visible = !(status === "valid" || status === "trial");

    if (!visible) {
      if (bannerEl) {
        bannerEl.remove();
        bannerEl = null;
      }
      return;
    }

    if (!bannerEl) {
      bannerEl = activeDocument.createElement("div");
      bannerEl.classList.add(BANNER_CLASS);
      // role=status + aria-live=polite so screen readers announce
      // state changes (trial expired, license unknown) without
      // interrupting whatever the user is reading.
      bannerEl.setAttribute("role", "status");
      bannerEl.setAttribute("aria-live", "polite");
    }

    placeAdjacentToToolbar(bannerEl);

    bannerEl.empty();
    const icon = bannerEl.createSpan({ cls: `${BANNER_CLASS}-icon` });
    setIcon(icon, status === "expired" ? "alert-triangle" : "lock");

    const text = bannerEl.createDiv({ cls: `${BANNER_CLASS}-text` });
    if (status === "expired") {
      text.createDiv({
        cls: `${BANNER_CLASS}-title`,
        text: "Trial expired - read-only mode",
      });
      text.createDiv({
        cls: `${BANNER_CLASS}-subtitle`,
        text: "Get full access to keep editing in Butter.",
      });
    } else if (status === "unknown") {
      text.createDiv({
        cls: `${BANNER_CLASS}-title`,
        text: "Checking license…",
      });
      text.createDiv({
        cls: `${BANNER_CLASS}-subtitle`,
        text: "Read-only until the licensing server can be reached.",
      });
    } else {
      text.createDiv({
        cls: `${BANNER_CLASS}-title`,
        text: "License required - read-only mode",
      });
      text.createDiv({
        cls: `${BANNER_CLASS}-subtitle`,
        text: "Start a free trial or paste a license key to enable editing.",
      });
    }

    const actions = bannerEl.createDiv({ cls: `${BANNER_CLASS}-actions` });
    const openSettings = () => plugin.openSettings("license");
    const trialBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: status === "expired" ? "Get full access" : "Start trial",
    });
    trialBtn.addEventListener("click", openSettings);
    if (status !== "expired") {
      const enterBtn = actions.createEl("button", { text: "Enter license" });
      enterBtn.addEventListener("click", openSettings);
    }
  };

  render();

  return {
    refresh: render,
    destroy: () => {
      if (bannerEl) {
        bannerEl.remove();
        bannerEl = null;
      }
    },
  };
}
