/**
 * Butter's plugin-settings tab.
 *
 * Extracted from main.ts for readability - the tab is self-contained:
 * it reads + writes `plugin.settings`, triggers saves via
 * `plugin.saveSettings()`, and nudges `plugin.applyOutlineMode()` when
 * the outline toggle flips. It doesn't touch the editor view directly.
 *
 * Four tabs (General / Outline / Block Drag / Normalization) render
 * independently; active tab persists in-memory only (resets on
 * re-open, per Obsidian's settings pane convention).
 */
import {
  App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  getIconIds,
  setIcon,
} from "obsidian";
import type ButterEditorPlugin from "../main";
import type { ButterSettings } from "../main";
import { LicenseClientError } from "../integration/license/client";
import type { DeviceWireRecord } from "../integration/license/client";
import { LINKS } from "../integration/license/links";
import { MAX_DEVICES_PER_CUSTOMER, TRIAL_LENGTH_DAYS } from "../integration/license/policy";
import type { ToolbarLayoutItem } from "../main";
import { MAIN_TOOLBAR_BUTTON_DEFS } from "./toolbar";
import { TABLE_TOOLBAR_BUTTON_DEFS } from "../editor/table-toolbar";
import {
  defaultTableLayout,
  mainLayoutFull,
  mainLayoutSimple,
  mobileLayoutDefault,
  mobileTableLayoutDefault,
  cloneLayout,
  collectButtonIds,
  locate,
  removeItem,
  newId,
} from "./toolbar-layout";
import {
  WelcomeModal,
  SourcePurityConfirmModal,
  PresetDriftConfirmModal,
  BUTTER_GITHUB_README,
  matchActivePreset,
  wouldDriftFromActive,
  type SourcePurityMode,
} from "./welcome-modal";

export class ButterSettingTab extends PluginSettingTab {
  /** Active tab key - persists across re-opens of the settings pane.
   *  Order is the user-facing order in the tab bar. */
  activeTab:
    | "general"
    | "behavior"
    | "toolbar"
    | "advanced"
    | "license" = "general";

  /** Inline trial-poll timer, owned by the License tab's hero block.
   *  Cleared on `hide()` so we don't poll while Settings is closed
   *  (the plugin's `resumeTrialActivation` still picks it up next
   *  open). Null when no poll is scheduled. */
  private trialPollTimer: number | null = null;

  /** Bumped each time the License tab is rendered. The poll loop's
   *  in-flight ticks check this against their captured generation
   *  before continuing - guarantees old timers from a prior render
   *  can't race with a fresher render's state. */
  private pollGeneration = 0;

  /** ResizeObserver watching the tab bar. Created on each display();
   *  disconnected on hide() and at the top of the next display() so
   *  re-renders don't pile up observers. */
  private tabBarResizeObserver: ResizeObserver | null = null;

  constructor(app: App, private plugin: ButterEditorPlugin) {
    super(app, plugin);
  }

  hide() {
    if (this.trialPollTimer != null) {
      window.clearTimeout(this.trialPollTimer);
      this.trialPollTimer = null;
    }
    if (this.tabBarResizeObserver) {
      this.tabBarResizeObserver.disconnect();
      this.tabBarResizeObserver = null;
    }
  }

  display() {
    const { containerEl } = this;
    if (this.activeTab === "license") this.activeTab = "general";
    containerEl.empty();
    containerEl.addClass("butter-settings-root");

    // Tab bar with optional left/right overflow indicators. The wrap
    // is positioned-relative so the indicators can absolutely overlay
    // the bar's edges; the bar itself is the scrollable element. On
    // narrow windows the tabs scroll horizontally and the indicators
    // appear when content extends past the visible bounds. Clicking
    // an indicator scrolls one tab worth in that direction.
    const tabWrap = containerEl.createDiv({ cls: "butter-settings-tabs-wrap" });
    const leftInd = tabWrap.createDiv({
      cls: "butter-settings-tabs-indicator is-left",
      attr: { role: "button", tabindex: "0", "aria-label": "Scroll tabs left" },
    });
    setIcon(leftInd, "chevron-left");
    const tabBar = tabWrap.createDiv({ cls: "butter-settings-tabs" });
    const rightInd = tabWrap.createDiv({
      cls: "butter-settings-tabs-indicator is-right",
      attr: { role: "button", tabindex: "0", "aria-label": "Scroll tabs right" },
    });
    setIcon(rightInd, "chevron-right");

    const updateIndicators = () => {
      // 1px tolerance for fractional scroll positions (some browsers
      // report scrollLeft+clientWidth slightly under scrollWidth even
      // when fully scrolled to the right).
      const canLeft = tabBar.scrollLeft > 1;
      const canRight =
        tabBar.scrollLeft + tabBar.clientWidth < tabBar.scrollWidth - 1;
      leftInd.toggleClass("is-visible", canLeft);
      rightInd.toggleClass("is-visible", canRight);
    };

    const scrollByOneTab = (dir: -1 | 1) => {
      const tabs = Array.from(
        tabBar.querySelectorAll<HTMLElement>(".butter-settings-tab"),
      );
      if (dir === 1) {
        // First tab whose right edge is past the current visible end.
        const visibleRight = tabBar.scrollLeft + tabBar.clientWidth;
        const next = tabs.find(
          (t) => t.offsetLeft + t.offsetWidth > visibleRight + 1,
        );
        if (next) {
          tabBar.scrollTo({
            left: next.offsetLeft - 4,
            behavior: "smooth",
          });
        }
      } else {
        // Last tab whose left edge is before the current visible start.
        const visibleLeft = tabBar.scrollLeft;
        let prev: HTMLElement | undefined;
        for (let i = tabs.length - 1; i >= 0; i--) {
          if (tabs[i].offsetLeft < visibleLeft - 1) {
            prev = tabs[i];
            break;
          }
        }
        if (prev) {
          tabBar.scrollTo({
            left: Math.max(0, prev.offsetLeft - 4),
            behavior: "smooth",
          });
        }
      }
    };

    const wireIndicator = (el: HTMLElement, dir: -1 | 1) => {
      el.addEventListener("click", () => scrollByOneTab(dir));
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          scrollByOneTab(dir);
        }
      });
    };
    wireIndicator(leftInd, -1);
    wireIndicator(rightInd, 1);

    tabBar.addEventListener("scroll", updateIndicators, { passive: true });
    // ResizeObserver catches container width changes (Obsidian pane
    // resize, sidebar toggle, etc.) without a window-scoped listener
    // that would leak across display() re-renders. Disconnect any
    // observer from a previous display() first so we never stack.
    if (this.tabBarResizeObserver) this.tabBarResizeObserver.disconnect();
    this.tabBarResizeObserver = new ResizeObserver(updateIndicators);
    this.tabBarResizeObserver.observe(tabBar);

    const body = containerEl.createDiv({ cls: "butter-settings-tab-body" });

    const render = () => {
      body.empty();
      tabBar.querySelectorAll(".butter-settings-tab").forEach((el) => {
        el.toggleClass("is-active", el.getAttribute("data-tab") === this.activeTab);
      });
      switch (this.activeTab) {
        case "general":
          this.renderGeneral(body);
          break;
        case "behavior":
          this.renderBehavior(body);
          break;
        case "toolbar":
          this.renderToolbar(body);
          break;
        case "advanced":
          this.renderAdvanced(body);
          break;
        case "license":
          this.renderLicense(body);
          break;
      }
    };

    const addTab = (id: typeof this.activeTab, label: string) => {
      // Render as a div, not a <button>, so Obsidian's and themes'
      // button-element styling (box-shadow, focus rings, hover fills,
      // padding overrides) never touches us. ARIA role + tabindex
      // restore keyboard activation; Enter/Space dispatch a click.
      const tab = tabBar.createDiv({
        cls: "butter-settings-tab",
        attr: { "data-tab": id, role: "tab", tabindex: "0" },
      });
      tab.createSpan({ cls: "butter-settings-tab-label", text: label });
      const activate = () => {
        this.activeTab = id;
        render();
      };
      tab.addEventListener("click", activate);
      tab.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    };

    addTab("general", "General");
    addTab("behavior", "Behavior");
    addTab("toolbar", "Toolbar");
    addTab("advanced", "Advanced");
    render();
    // Initial indicator visibility once layout has settled.
    window.requestAnimationFrame(updateIndicators);
  }

  /**
   * Composes the intro sections used at the top of the General tab:
   * the "What is Butter" blurb, the source-purity preset cards, and
   * the "Learn more" links / walkthrough replay. Pulled out as a
   * helper so renderGeneral can wrap these with the trial card and
   * everyday toggles without duplicating any of the long copy.
   */
  private renderGeneralIntroSections(root: HTMLElement) {
    // ── Settings Presets ──
    const purity = this.createSettingGroup(root, "Settings Presets");

    // Match-based active preset. Null when the bundled settings have
    // drifted away from every preset (Custom state).
    const activeMode = matchActivePreset(this.plugin);

    // Custom-state indicator. Appears only when no preset matches.
    // Sits as a dimmed line above the cards; applying any preset
    // below clears the state by overwriting the bundled settings.
    if (activeMode === null) {
      purity.createEl("p", {
        cls: "setting-item-description butter-preset-custom-indicator",
        text:
          "Custom: your bundled settings don't match any preset. Apply one below to return to a known baseline.",
      });
    }

    const purityOptions: Array<{
      mode: SourcePurityMode;
      label: string;
      icon: string;
      tag?: string;
      bestFor: string;
      rest: string;
    }> = [
      {
        mode: "strict",
        label: "Plain markdown",
        icon: "file-text",
        tag: "Default",
        bestFor: "Best for simple notes that work everywhere.",
        rest:
          "Maximum cross-app compatibility. Font color, inline styles, and other HTML extras stay off so your files read cleanly anywhere and version-control diffs stay tidy.",
      },
      {
        mode: "rich",
        label: "Rich formatting",
        icon: "paintbrush",
        bestFor: "Best for colorful, freely styled notes.",
        rest:
          "If you just want to color and style your notes how you want without worrying about markdown source then use this preset. This mixes some HTML into your note under the hood; invisible to you but some don't prefer that.",
      },
    ];

    for (const opt of purityOptions) {
      const setting = new Setting(purity).setName(opt.label);
      const isActive = activeMode === opt.mode;
      // Prepend the preset's icon. Inline-flex, muted color, sized
      // to match the row's text height. Same chrome as the other
      // icon-prefixed setting rows (Customize buttons, etc.).
      const presetIcon = createSpan({ cls: "butter-preset-icon" });
      setIcon(presetIcon, opt.icon);
      setting.nameEl.prepend(presetIcon);
      // Render optional tag (e.g. "Default", "Experimental") as a
      // dimmed-italic span next to the name. Reads as a label
      // annotation rather than a parenthetical, which lets the title
      // stand on its own typographically.
      if (opt.tag) {
        setting.nameEl.createSpan({
          cls:
            "butter-preset-tag" +
            (opt.tag === "Experimental" ? " is-experimental" : ""),
          text: opt.tag,
        });
      }
      // Build the description manually so the "best for" lead sentence
      // can render in the theme accent color. setDesc(string) doesn't
      // allow per-span styling, so we populate descEl directly.
      setting.descEl.empty();
      setting.descEl.createSpan({
        cls: "butter-preset-best-for",
        text: opt.bestFor,
      });
      setting.descEl.appendText(" " + opt.rest);
      setting.addButton((b) => {
        if (isActive) {
          b.setButtonText("Currently active").setDisabled(true);
        } else {
          b.setButtonText("Apply preset")
            .setCta()
            .onClick(() => {
              new SourcePurityConfirmModal(
                this.app,
                this.plugin,
                opt.mode,
                () => this.display(),
              ).open();
            });
        }
      });
    }

    // Tail row: not a preset, just a pointer to the Advanced tab's
    // source-preservation toggle. Lets users who want exact-byte
    // file fidelity find the right control without us framing it as
    // a one-click preset (which it isn't - it's an advanced setting
    // in its own right with its own gotchas).
    const preserveRow = new Setting(purity).setName("Source preservation");
    const preserveIcon = createSpan({ cls: "butter-preset-icon" });
    setIcon(preserveIcon, "code-2");
    preserveRow.nameEl.prepend(preserveIcon);
    preserveRow.descEl.empty();
    preserveRow.descEl.createSpan({
      cls: "butter-preset-best-for",
      text: "Best for keeping your files exactly as written.",
    });
    preserveRow.descEl.appendText(
      " Useful for git-tracked vaults or hand-formatted notes. Find the toggle and related normalizers under the Advanced tab.",
    );
    preserveRow.addButton((b) =>
      b
        .setButtonText("Open advanced")
        .onClick(() => {
          this.activeTab = "advanced";
          this.display();
        }),
    );

    // ── Learn more / replay ──
    const more = this.createSettingGroup(root, "Learn more");

    new Setting(more)
      .setName("Open feature docs")
      .setDesc("Opens the Butter README on GitHub. Feature descriptions with screenshots and GIFs.")
      .addButton((b) =>
        b.setButtonText("Open README").onClick(() => {
          window.open(BUTTER_GITHUB_README, "_blank");
        }),
      );

    new Setting(more)
      .setName("Replay welcome walkthrough")
      .setDesc("Re-open the welcome walkthrough.")
      .addButton((b) =>
        b.setButtonText("Replay").onClick(() => {
          new WelcomeModal(this.app, this.plugin).open();
        }),
      );
  }

  /**
   * License tab - gemini four-zone layout: brand stamp, hero, settings
   * card, destructive footer. Below the polished frame the Device
   * + Support sections render as plain native Obsidian setting stacks
   * for utility access (device id, diagnostic copy, docs/issues/
   * email/privacy/terms links). Trial activation morphs the frame in
   * place via `pendingTrialActivation`.
   */
  private renderLicense(root: HTMLElement) {
    // Bump the generation so any in-flight poll-tick from a prior
    // render bails before mutating settings or scheduling next.
    this.pollGeneration++;
    if (this.trialPollTimer != null) {
      window.clearTimeout(this.trialPollTimer);
      this.trialPollTimer = null;
    }

    const phase = this.computeLicensePhase();
    // The License settings group: native Obsidian section group
    // (heading + body). The body holds the ticket on top, then
    // native hairline-divided detail rows below, all in one card.
    // Same chrome as Devices + Support below.
    const section = this.createSettingGroup(root, "License", undefined);
    section.addClass("butter-license-section");
    this.renderRowsFor(section, phase);

    this.renderDevicesSection(root);
    this.renderSupportSection(root);
    if (__BUTTER_DEV__) this.renderDevSection(root);

    // If we're in the polling phase, kick the inline poll. Idempotent
    // because we cleared the timer above.
    if (phase === "polling") this.scheduleTrialPoll();
  }

  /** Resolve the effective License-tab phase from the plugin's
   *  reported `licenseStatus` plus the in-flight pendingTrialActivation
   *  overlay and the offline-grace heuristic. The pending activation
   *  only counts as "polling" if no license is already active - once
   *  the poll completes the field is cleared, but a defensive check
   *  here guards against a stale pending entry overriding a freshly-
   *  active license. The "offline" sub-phase fires when the customer
   *  has been validated before but we couldn't reach the worker on
   *  the most recent attempt and the last successful check is more
   *  than an hour old. */
  private computeLicensePhase():
    | "unlicensed" | "polling" | "trial" | "valid" | "expired" | "unknown"
    | "offline" | "deactivated" | "invalidated" {
    const s = this.plugin.settings;
    const pending = s.pendingTrialActivation;
    const status = this.plugin.licenseStatus;
    const hasLicense = Boolean(s.licenseKey);
    if (pending && !hasLicense) {
      const ageMs = Date.now() - (pending.startedAt || 0);
      if (ageMs <= 30 * 60 * 1000) return "polling";
    }
    // Sticky "this device was deactivated elsewhere" - fires only
    // when there's no current license to render (the deactivation
    // cleared it). Cleared on next successful activation.
    if (s.wasDeactivated && !hasLicense) return "deactivated";
    // Sticky "license was invalidated" (refund / chargeback /
    // revoked). Distinct from a natural trial expiry.
    if (s.wasInvalidated && status === "expired") return "invalidated";
    if (status === "unknown" && s.everValidated) {
      const since = Date.now() - (s.lastValidatedAt || 0);
      if (since > 60 * 60 * 1000) return "offline";
    }
    return status;
  }

  // ── License section: per-state native rows ──────────────────

  /** Render the per-state License surface as a stack of native
   *  Obsidian `Setting()` rows. Top row carries the state name +
   *  one-line description + the primary action. Detail rows below
   *  show the relevant info (license key, customer, dates).
   *  Inline forms (paste-key, recovery) come last for states that
   *  need them. */
  private renderRowsFor(parent: HTMLElement, phase: ReturnType<typeof this.computeLicensePhase>) {
    switch (phase) {
      case "unlicensed":  this.renderUnlicensedRows(parent); break;
      case "polling":     this.renderPollingRows(parent); break;
      case "trial":       this.renderTrialRows(parent); break;
      case "valid":       this.renderLifetimeRows(parent); break;
      case "expired":     this.renderExpiredRows(parent); break;
      case "offline":     this.renderOfflineRows(parent); break;
      case "deactivated": this.renderDeactivatedRows(parent); break;
      case "invalidated": this.renderInvalidatedRows(parent); break;
      case "unknown":
      default:            this.renderUnknownRows(parent); break;
    }
  }

  private renderUnlicensedRows(parent: HTMLElement) {
    new Setting(parent)
      .setName("Free trial available")
      .setDesc(`${TRIAL_LENGTH_DAYS} days, full access. No card, no email.`)
      .addButton((b) =>
        b.setButtonText("Start free trial").setCta()
          .onClick(() => { void this.beginTrialActivation(); }),
      );
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
    this.renderRecoveryRow(parent);
  }

  private renderPollingRows(parent: HTMLElement) {
    new Setting(parent)
      .setName("Activating trial…")
      .setDesc("Confirming with the licensing server. This usually takes a few seconds.")
      .addButton((b) => b.setButtonText("Checking…").setDisabled(true));
    const pending = this.plugin.settings.pendingTrialActivation;
    if (!pending) return;
    const ageSec = (Date.now() - (pending.startedAt || 0)) / 1000;
    if (ageSec > 25 && pending.checkoutUrl) {
      new Setting(parent)
        .setName("Take it to a browser")
        .setDesc("If activation is stuck, complete it in a browser as a fallback.")
        .addButton((b) =>
          b.setButtonText("Open").setCta()
            .onClick(() => { window.open(pending.checkoutUrl, "_blank"); }),
        );
    }
  }

  private renderTrialRows(parent: HTMLElement) {
    const r = this.computeRemaining();
    const s = this.plugin.settings;
    const dayN = Math.min(7, r.daysUsed + 1);
    const stateName = r.daysLeft <= 0 && r.hoursLeft > 0
      ? `Trial · ${r.hoursLeft} ${r.hoursLeft === 1 ? "hour" : "hours"} left`
      : `Trial · ${r.daysLeft} ${r.daysLeft === 1 ? "day" : "days"} left`;
    const exp = s.licenseExpiresAt
      ? `Day ${dayN} of ${TRIAL_LENGTH_DAYS} · ends ${this.formatActivationDate(s.licenseExpiresAt)}.`
      : `Day ${dayN} of ${TRIAL_LENGTH_DAYS}.`;
    new Setting(parent)
      .setName(stateName)
      .setDesc(exp)
      .addButton((b) =>
        b.setButtonText("Get lifetime · $16").setCta()
          .onClick(() => { window.open(LINKS.pricing, "_blank"); }),
      );
    this.renderKeyRow(parent);
  }

  private renderLifetimeRows(parent: HTMLElement) {
    const s = this.plugin.settings;
    const tierLabel = s.tier === "v2" ? "v2" : "v1";
    new Setting(parent)
      .setName(`Lifetime License · ${tierLabel}`)
      .setDesc("Thanks for buying Butter - yours, forever.")
      .addButton((b) =>
        b.setButtonText("Manage license").setCta()
          .onClick(() => { window.open(LINKS.accountPortal, "_blank"); }),
      );
    this.renderKeyRow(parent);
    if (s.customerEmail) {
      new Setting(parent).setName("Email").setDesc(s.customerEmail);
    }
    // `customerId` is Polar's internal billing identifier (`cust_xxx`).
    // It used to render here as a fallback "Customer" row when no
    // email was on file - opaque to the user, useful to nobody but
    // support, and confusing as a settings row. Removed; if support
    // ever needs it, it stays available in the diagnostic copy under
    // Devices → Copy diagnostics.
    if (s.activatedAt) {
      new Setting(parent)
        .setName("Activated")
        .setDesc(this.formatActivationDate(s.activatedAt));
    }
    this.renderPasteKeyRow(parent, /* asUpdate */ true);
  }

  /** "This device was deactivated from elsewhere" - sticky state
   *  set by refreshLicenseStatus when /session returns
   *  device_deactivated. Cleared on next successful activation. */
  private renderDeactivatedRows(parent: HTMLElement) {
    new Setting(parent)
      .setName("Device deactivated")
      .setDesc("This install was removed from your license from another device. Paste your key to add it back, or start a new trial.")
      .addButton((b) =>
        b.setButtonText("Start free trial").setCta()
          .onClick(() => { void this.beginTrialActivation(); }),
      );
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
    this.renderRecoveryRow(parent);
  }

  /** License was invalidated by the server (refund, chargeback,
   *  revoked, or key not recognized). Distinct from a natural trial
   *  expiry - the user was a real customer who lost access for a
   *  specific reason we can surface. */
  private renderInvalidatedRows(parent: HTMLElement) {
    const s = this.plugin.settings;
    const reason = this.reasonCopyFor(s.lastReason);
    new Setting(parent)
      .setName("License could not be verified")
      .setDesc(`We couldn't validate your license. ${reason}`)
      .addButton((b) =>
        b.setButtonText("Re-check").setCta().onClick(async () => {
          await this.plugin.refreshLicenseStatus();
          this.display();
        }),
      );
    new Setting(parent)
      .setName("Contact support")
      .setDesc("If this is unexpected, get in touch and we'll sort it.")
      .addButton((b) =>
        b.setButtonText("Email").onClick(() => {
          window.open(`mailto:${LINKS.supportEmail}`, "_blank");
        }),
      );
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
  }

  /** Maps the lastReason error.kind to a one-line explanation. */
  private reasonCopyFor(reason: string): string {
    switch (reason) {
      case "license_invalid":
        return "The key was not recognized by the server (refund, chargeback, or revoked).";
      case "device_deactivated":
        return "This device was deactivated from another machine.";
      case "polar_error":
        return "The licensing service is temporarily unavailable.";
      case "network":
        return "We couldn't reach the licensing server.";
      default:
        return "Try again, or contact support if this persists.";
    }
  }

  private renderExpiredRows(parent: HTMLElement) {
    const expiredAt = this.plugin.settings.licenseExpiresAt || 0;
    const desc = expiredAt
      ? `Your trial ended ${this.formatActivationDate(expiredAt)}. Get lifetime to keep using Butter.`
      : "Get lifetime to keep using Butter.";
    new Setting(parent)
      .setName("Trial ended")
      .setDesc(desc)
      .addButton((b) =>
        b.setButtonText("Get lifetime · $16").setCta()
          .onClick(() => { window.open(LINKS.pricing, "_blank"); }),
      );
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
  }

  private renderOfflineRows(parent: HTMLElement) {
    const s = this.plugin.settings;
    new Setting(parent)
      .setName("Offline · using cached license")
      .setDesc("We can't reach the server right now. Your cached license keeps Butter running.")
      .addButton((b) =>
        b.setButtonText("Retry").onClick(async () => {
          await this.plugin.refreshLicenseStatus();
          this.display();
        }),
      );
    if (s.lastValidatedAt) {
      new Setting(parent)
        .setName("Last verified")
        .setDesc(this.formatRelativeTime(s.lastValidatedAt));
    }
  }

  private renderUnknownRows(parent: HTMLElement) {
    new Setting(parent)
      .setName("Checking license…")
      .setDesc("Verifying with the licensing server.")
      .addButton((b) => b.setButtonText("Checking…").setDisabled(true));
  }

  // ── Trial / time formatters (used by hero meta) ──────────────

  /** Trial-state headline copy table. Urgency lives ONLY here
   *  the layout, accent, and CTA stay constant across the full
   *  trial so day N-1 doesn't visually shout at the user. Buckets
   *  are computed as fractions of `TRIAL_LENGTH_DAYS` so the copy
   *  follows trial-length changes automatically. */
  private trialHeadlineFor(
    remaining: { daysLeft: number; hoursLeft: number; expired: boolean },
  ): string {
    if (remaining.expired) return "Trial expired.";
    if (remaining.daysLeft <= 0) return "Today's the day.";
    if (remaining.daysLeft === 1) return "One day left.";
    if (remaining.daysLeft === 2) return "Two days left.";
    const pct = remaining.daysLeft / TRIAL_LENGTH_DAYS;
    if (pct <= 0.33) return "Closing in.";
    if (pct <= 0.66) return "Halfway through.";
    return "Settling in.";
  }

  /** Mono detail line below the trial headline. Format:
   *  "day {n} of {TRIAL_LENGTH_DAYS} · ends {date}" or
   *  "· ends in {h}h" on the last day. Plays well against the
   *  italic-serif headline. */
  private trialStatLineFor(
    remaining: { daysLeft: number; hoursLeft: number; daysUsed: number; expired: boolean },
  ): string {
    const dayN = Math.min(TRIAL_LENGTH_DAYS, Math.max(1, remaining.daysUsed + 1));
    const exp = this.plugin.settings.licenseExpiresAt
      || this.plugin.settings.sessionExpiresAt
      || 0;
    if (!exp) return `day ${dayN} of ${TRIAL_LENGTH_DAYS}`;
    if (remaining.expired) return `day ${TRIAL_LENGTH_DAYS} of ${TRIAL_LENGTH_DAYS} · ended`;
    const dateStr = remaining.daysLeft <= 0
      ? `ends in ${Math.max(1, remaining.hoursLeft)}h`
      : `ends ${this.formatActivationDate(exp)}`;
    return `day ${dayN} of ${TRIAL_LENGTH_DAYS} · ${dateStr}`;
  }

  /** Compact "Mon DD, YYYY" - Intl.DateTimeFormat with short month.
   *  Year omitted when the date is in the current calendar year. */
  private formatActivationDate(ms: number): string {
    if (!ms) return "-";
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  }

  /** "5 minutes ago" / "3 hours ago" / "yesterday" / "Mon DD"
   *  used by the Offline state for the last-verified line. */
  private formatRelativeTime(ms: number): string {
    if (!ms) return "-";
    const diffMs = Date.now() - ms;
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
    const day = Math.floor(hr / 24);
    if (day === 1) return "yesterday";
    if (day < 7) return `${day} days ago`;
    return this.formatActivationDate(ms);
  }

  private renderKeyRow(parent: HTMLElement) {
    const setting = new Setting(parent).setName("License key");
    setting.descEl.createEl("code", {
      cls: "butter-license-keyview",
      text: this.plugin.settings.licenseKey || "-",
    });
    setting.addButton((b) =>
      b.setButtonText("Copy").onClick(async () => {
        try {
          await navigator.clipboard.writeText(this.plugin.settings.licenseKey);
          new Notice("License key copied.", 2000);
        } catch {
          new Notice("Couldn't copy - your browser blocked clipboard access.", 4000);
        }
      }),
    );
  }

  /** Trial state: synthesize the trial-* email from deviceId.
   *  Lifetime state: surface customerId if we have it. Either is
   *  the locally-known identity for this license; if neither
   *  applies, the row is skipped rather than rendered as "-". */
  private renderAccountIdentityRow(parent: HTMLElement) {
    const phase = this.computeLicensePhase();
    if (phase === "trial") {
      const dev = this.plugin.settings.deviceId || "";
      if (!dev) return;
      const synthetic = `trial-${dev.slice(0, 8)}@buttereditor.com`;
      new Setting(parent).setName("Account").setDesc(synthetic);
      return;
    }
    if (phase === "valid") {
      const cid = this.plugin.settings.customerId;
      if (!cid) return;
      new Setting(parent).setName("Customer").setDesc(cid);
      return;
    }
  }

  /** Paste-key form, one-shot Setting row. `asUpdate` flips copy
   *  between "Have a license key?" and "Update license key". */
  private renderPasteKeyRow(parent: HTMLElement, asUpdate: boolean) {
    let keyInputValue = "";
    const setting = new Setting(parent)
      .setName(asUpdate ? "Update license key" : "Have a license key?")
      .setDesc(asUpdate
        ? "Replace the active key (e.g. trial → lifetime)."
        : "Paste the key from your purchase or recovery email.")
      .addText((t) =>
        t.setPlaceholder("BTR-xxxx-xxxx-xxxx")
          .onChange((v) => { keyInputValue = v.trim(); }),
      );
    const errorEl = setting.descEl.createDiv({ cls: "butter-account-error" });
    errorEl.addClass("butter-hidden");
    setting.addButton((b) =>
      b.setButtonText("Validate").setCta().onClick(async () => {
        if (!keyInputValue) { new Notice("Paste a key first."); return; }
        await this.validateLicenseKeyFlow(keyInputValue, errorEl);
      }),
    );
  }

  private renderRecoveryRow(parent: HTMLElement) {
    let recoverEmail = "";
    new Setting(parent)
      .setName("Lost your key?")
      .setDesc("We'll email a one-time access link to recover your licenses.")
      .addText((t) =>
        t.setPlaceholder("you@example.com")
          .onChange((v) => { recoverEmail = v.trim(); }),
      )
      .addButton((b) =>
        b.setButtonText("Send link").onClick(async () => {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoverEmail)) {
            new Notice("Enter a valid email first.");
            return;
          }
          try {
            await this.plugin.licenseClient.requestRecovery(recoverEmail);
            new Notice(
              "If an account exists for that email, a recovery link is on its way.",
              7000,
            );
          } catch (err) {
            const msg = err instanceof LicenseClientError
              ? this.friendlyError(err)
              : "Couldn't reach the licensing server. Try again in a moment.";
            new Notice(msg, 7000);
          }
        }),
      );
  }

  // ── Section 2: Devices ──────────────────────────────────────

  /** Devices using this license. Each row shows the device's
   *  activation date and a Deactivate action. The list is fetched
   *  live from the Worker (1.7.0+) and includes every device the
   *  customer has activated. While the fetch is in flight, render
   *  pulsing skeleton rows. On network failure or pre-1.7.0 Worker,
   *  fall back to showing just the current device.
   *
   *  Reset license state + Copy diagnostic info live below the
   *  device list as plain rows. */
  private renderDevicesSection(root: HTMLElement) {
    const section = this.createSettingGroup(root, "Devices");
    const phase = this.computeLicensePhase();
    const hasActiveLicense =
      phase === "trial" || phase === "valid" || phase === "offline";

    const list = section.createDiv({ cls: "butter-license-device-list" });
    if (hasActiveLicense) {
      this.renderDeviceListSkeleton(list);
      void this.fetchAndRenderDevices(list);
    } else {
      list.createDiv({
        cls: "butter-license-devices-hint",
        text: "No active license on this device.",
      });
    }

    this.renderDeviceUtilities(section);
  }

  /** Async fetch + render of the live device list. Replaces the
   *  skeleton in `listEl` with real rows on resolve, or a graceful
   *  fallback on network/auth failure. */
  private async fetchAndRenderDevices(listEl: HTMLElement) {
    const sessionToken = this.plugin.settings.sessionToken;
    if (!sessionToken) {
      listEl.empty();
      this.renderCurrentDeviceFallback(
        listEl,
        "Local session missing - re-paste your key to refresh the device list.",
      );
      return;
    }
    let devices: DeviceWireRecord[];
    try {
      devices = await this.plugin.licenseClient.listDevices(sessionToken);
    } catch (err) {
      listEl.empty();
      if (err instanceof LicenseClientError) {
        if (err.kind === "device_deactivated") {
          // Server confirms this device was deactivated remotely.
          // refreshLicenseStatus would normally clear local state,
          // but listDevices doesn't go through that path - do it
          // here, then re-render.
          await this.plugin.refreshLicenseStatus();
          this.display();
          return;
        }
        if (err.kind === "unauthorized") {
          // Token expired client-side. Trigger refresh - that'll
          // either re-issue or mark unlicensed.
          await this.plugin.refreshLicenseStatus();
          this.display();
          return;
        }
      }
      // Network / polar / unknown - fall back to local-only view.
      this.renderCurrentDeviceFallback(
        listEl,
        "Couldn't reach the licensing server. Showing this device only.",
      );
      return;
    }

    listEl.empty();
    if (devices.length === 0) {
      // Worker has no record of this device yet (legacy customer or
      // pre-1.7.0 Worker). Fall back to local-only view.
      this.renderCurrentDeviceFallback(
        listEl,
        "Sign in on another machine to add it here.",
      );
      return;
    }

    for (const device of devices) {
      this.renderDeviceRow(listEl, device);
    }

    // Device-count summary line below the list. Always shown when
    // there's at least one device - "1 device" doubles as the hint
    // that you can add more.
    const count = devices.length;
    const summary = count === 1
      ? "1 device · sign in on another machine to add it here."
      : `${count} devices on this license.`;
    listEl.createDiv({ cls: "butter-license-devices-hint", text: summary });
  }

  /** Pulse-skeleton rows for the in-flight device fetch. Two rows
   *  to roughly match a typical 2-device customer's resolved list. */
  private renderDeviceListSkeleton(parent: HTMLElement) {
    for (let i = 0; i < 2; i++) {
      const row = parent.createDiv({ cls: "butter-license-skeleton-row" });
      const info = row.createDiv({ cls: "butter-license-skeleton-info" });
      info.createDiv({ cls: "butter-license-skeleton is-row-name" });
      info.createDiv({ cls: "butter-license-skeleton is-row-desc" });
      row.createDiv({ cls: "butter-license-skeleton is-row-control" });
    }
  }

  /** Single device row. The current device's row uses the
   *  confirm-modal sign-out path (clears local session immediately
   *  + revokes server-side); sibling devices revoke server-side
   *  only - their next /session call will return device_deactivated. */
  private renderDeviceRow(parent: HTMLElement, device: DeviceWireRecord) {
    const activated = this.formatActivationDate(device.activatedAt);
    const lastSeen = device.lastSeenAt && device.lastSeenAt !== device.activatedAt
      ? ` · last seen ${this.formatRelativeTime(device.lastSeenAt)}`
      : "";
    const setting = new Setting(parent)
      .setName(device.isCurrent ? "This device" : "Another device")
      .setDesc(`Activated ${activated}${lastSeen}`);
    setting.addButton((b) =>
      b.setButtonText("Deactivate").setWarning().onClick(() => {
        if (device.isCurrent) {
          new DeactivateConfirmModal(this.app, async () => {
            await this.deactivateCurrentDevice();
          }).open();
        } else {
          void this.deactivateSiblingDevice(device.deviceId);
        }
      }),
    );
  }

  /** Self-deactivation: revoke server-side, then clear local
   *  session token + regenerate deviceId so this Obsidian install
   *  drops back to read-only mode immediately AND can be re-added
   *  cleanly by re-pasting the same key (a fresh deviceId means the
   *  Worker's device_deactivated gate doesn't fire on re-validation,
   *  since the new id has no deactivated entry). The old deviceId's
   *  deactivated entry stays in the server-side list as a historical
   *  record. */
  private async deactivateCurrentDevice() {
    const sessionToken = this.plugin.settings.sessionToken;
    const oldDeviceId = this.plugin.settings.deviceId;
    if (sessionToken) {
      try {
        await this.plugin.licenseClient.deactivateDevice(
          sessionToken,
          oldDeviceId,
        );
      } catch (err) {
        // Server revoke failed - log it, but still clear local
        // state so the user's "deactivate" intent succeeds locally.
        // The new deviceId means re-validation will work either
        // way; the worst case is the old deviceId stays usable on
        // the server until its session token expires (≤7 days).
        console.warn("[butter] device-deactivate server call failed:", err);
      }
    }
    // Clear the in-flight license state. Note: we preserve
    // `everValidated` so the user keeps offline grace if they
    // re-paste the same key on this install - losing it on a
    // self-initiated action would punish them for cleaning up.
    // Same reason for clearing the sticky failure flags - a user
    // who chose to deactivate isn't surprised by it.
    this.plugin.settings.sessionToken = "";
    this.plugin.settings.sessionExpiresAt = 0;
    this.plugin.settings.lastValidatedAt = 0;
    this.plugin.settings.licenseKey = "";
    this.plugin.settings.customerId = "";
    this.plugin.settings.customerEmail = "";
    this.plugin.settings.licenseExpiresAt = 0;
    this.plugin.settings.activatedAt = 0;
    this.plugin.settings.wasDeactivated = false;
    this.plugin.settings.wasInvalidated = false;
    this.plugin.settings.lastReason = "";
    this.plugin.settings.deviceId = (crypto).randomUUID();
    await this.plugin.saveSettings();
    await this.plugin.refreshLicenseStatus();
    this.display();
    new Notice("This device deactivated.", 4000);
  }

  /** Sibling-device deactivation: revoke server-side, refresh the
   *  list. The other device keeps its cached session token until
   *  expiry (~7 days max); on its next /session refresh the Worker
   *  returns device_deactivated and that device's local state
   *  clears itself via main.ts's refreshLicenseStatus handler. */
  private async deactivateSiblingDevice(deviceId: string) {
    const sessionToken = this.plugin.settings.sessionToken;
    if (!sessionToken) {
      new Notice("Session expired - re-paste your key to refresh.", 5000);
      return;
    }
    try {
      await this.plugin.licenseClient.deactivateDevice(sessionToken, deviceId);
      new Notice("Device deactivated.", 4000);
    } catch (err) {
      const msg = err instanceof LicenseClientError
        ? this.friendlyError(err)
        : "Couldn't reach the licensing server.";
      new Notice(msg, 5000);
      return;
    }
    // Re-render Devices section to reflect the change.
    this.display();
  }

  /** Local-only fallback row for the current device - used when the
   *  /devices fetch fails (network, pre-1.7.0 Worker) or the Worker
   *  returns an empty list (legacy customer). */
  private renderCurrentDeviceFallback(parent: HTMLElement, hintText: string) {
    const activatedAt = this.plugin.settings.activatedAt
      || this.plugin.settings.lastValidatedAt
      || 0;
    const desc = activatedAt
      ? `Activated ${this.formatActivationDate(activatedAt)}`
      : "this install";
    new Setting(parent)
      .setName("This device")
      .setDesc(desc)
      .addButton((b) =>
        b.setButtonText("Deactivate").setWarning().onClick(() => {
          new DeactivateConfirmModal(this.app, async () => {
            await this.deactivateCurrentDevice();
          }).open();
        }),
      );
    parent.createDiv({
      cls: "butter-license-devices-hint",
      text: hintText,
    });
  }

  /** Copy-diagnostic row parked at the bottom of the Devices
   *  section. Real customer feature - gives them a one-block payload
   *  to paste into support tickets. (Reset license state used to
   *  live here too; it's now in the Dev section since normal users
   *  shouldn't need it - Deactivate covers the sign-out path.) */
  private renderDeviceUtilities(section: HTMLElement) {
    new Setting(section)
      .setName("Copy diagnostic info")
      .setDesc("Device ID, key prefix, plugin version, and server URL for support tickets.")
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          const devId = this.plugin.settings.deviceId || "-";
          const keyPrefix = (this.plugin.settings.licenseKey || "").slice(0, 12) || "-";
          const ver = this.plugin.manifest.version;
          const status = this.plugin.licenseStatus;
          const payload = [
            `Butter Editor diagnostic`,
            `version: ${ver}`,
            `device: ${devId}`,
            `key prefix: ${keyPrefix}`,
            `status: ${status}`,
            `worker: https://api.buttereditor.com`,
          ].join("\n");
          try {
            await navigator.clipboard.writeText(payload);
            new Notice("Diagnostic info copied.", 2000);
          } catch {
            new Notice("Couldn't copy - clipboard access was blocked.", 4000);
          }
        }),
      );
  }

  // ── Section 3: Support ──────────────────────────────────────

  private renderSupportSection(root: HTMLElement) {
    const section = this.createSettingGroup(root, "Support", undefined);

    new Setting(section)
      .setName("Documentation")
      .setDesc("Read the docs and FAQ.")
      .addButton((b) =>
        b.setButtonText("Open").onClick(() => { window.open(LINKS.docs, "_blank"); }),
      );

    new Setting(section)
      .setName("Report an issue")
      .setDesc("GitHub issue tracker.")
      .addButton((b) =>
        b.setButtonText("Open").onClick(() => { window.open(LINKS.issues, "_blank"); }),
      );

    new Setting(section)
      .setName("Community thread")
      .setDesc("Obsidian forum thread.")
      .addButton((b) =>
        b.setButtonText("Open").onClick(() => { window.open(LINKS.forum, "_blank"); }),
      );

    new Setting(section)
      .setName("Email support")
      .setDesc(LINKS.supportEmail)
      .addButton((b) =>
        b.setButtonText("Email").onClick(() => {
          window.open(`mailto:${LINKS.supportEmail}`, "_blank");
        }),
      );

    new Setting(section)
      .setName("Privacy policy")
      .addButton((b) =>
        b.setButtonText("Open").onClick(() => { window.open(LINKS.privacy, "_blank"); }),
      );

    new Setting(section)
      .setName("Terms of service")
      .addButton((b) =>
        b.setButtonText("Open").onClick(() => { window.open(LINKS.terms, "_blank"); }),
      );

    new Setting(section)
      .setName("Refund policy")
      .addButton((b) =>
        b.setButtonText("Open").onClick(() => { window.open(LINKS.refunds, "_blank"); }),
      );

    new Setting(section)
      .setName("Plugin version")
      .setDesc(`v${this.plugin.manifest.version}`);
  }

  // ── Section 4: Dev (test + reset) ───────────────────────────

  /** Dev-time scratch surface for testing the License flow. Force-
   *  state buttons skip Worker validation (they write fake-but-
   *  coherent settings shapes with sessionExpiresAt well in the
   *  future so refreshLicenseStatus trusts the cached "token"
   *  without round-tripping). Trigger /session refresh exercises
   *  the real Worker call. Reset clears all license state +
   *  regenerates deviceId.
   *
   *  Strip this section before public launch - or gate the
   *  renderDevSection() call behind a hidden setting. */
  private renderDevSection(root: HTMLElement) {
    const section = this.createSettingGroup(root, "Dev");

    const day = 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    const FAR_FUTURE = (): number => Date.now() + 8 * day; // bypass /session refresh

    new Setting(section)
      .setName("Force license state")
      .setDesc("Skips worker validation. Each button writes a coherent settings shape and re-renders the tab.")
      .addButton((b) =>
        b.setButtonText("Unlicensed").onClick(async () => {
          await this.forceLicenseState({});
        }),
      )
      .addButton((b) =>
        b.setButtonText("Polling").onClick(async () => {
          await this.forceLicenseState({
            pendingTrialActivation: {
              pollToken: "dev-fake",
              startedAt: Date.now(),
            },
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("Trial d1").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-T-DEV-D1",
            sessionToken: "dev-fake",
            sessionExpiresAt: FAR_FUTURE(),
            licenseExpiresAt: Date.now() + 6 * day, // ~6 days left
            everValidated: true,
            activatedAt: Date.now() - day,
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("Trial d6").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-T-DEV-D6",
            sessionToken: "dev-fake",
            sessionExpiresAt: FAR_FUTURE(),
            licenseExpiresAt: Date.now() + day, // ~1 day left → "One day left."
            everValidated: true,
            activatedAt: Date.now() - 6 * day,
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("Trial 4h").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-T-DEV-4H",
            sessionToken: "dev-fake",
            sessionExpiresAt: FAR_FUTURE(),
            licenseExpiresAt: Date.now() + 4 * hour, // last hours → "Today's the day."
            everValidated: true,
            activatedAt: Date.now() - 7 * day + 4 * hour,
          });
        }),
      );

    new Setting(section)
      .setName(" ")
      .setDesc(" ")
      .addButton((b) =>
        b.setButtonText("Lifetime").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-DEV-LIFETIME",
            sessionToken: "dev-fake",
            sessionExpiresAt: FAR_FUTURE(),
            licenseExpiresAt: 0,
            everValidated: true,
            customerId: "dev-customer-xyz",
            activatedAt: Date.now() - 30 * day,
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("Expired").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-T-DEV-EXPIRED",
            sessionToken: "dev-fake",
            sessionExpiresAt: FAR_FUTURE(),
            licenseExpiresAt: Date.now() - 2 * day,
            everValidated: true,
            activatedAt: Date.now() - 9 * day,
          });
          // Force the computed phase to "expired" - refreshLicenseStatus
          // alone won't because sessionToken is technically still
          // "valid" (cached). Override directly.
          this.plugin.licenseStatus = "expired";
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Offline").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-DEV-OFFLINE",
            sessionToken: "",
            sessionExpiresAt: 0,
            everValidated: true,
            lastValidatedAt: Date.now() - 2 * hour,
            activatedAt: Date.now() - 10 * day,
          });
          this.plugin.licenseStatus = "unknown";
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Deactivated").onClick(async () => {
          await this.forceLicenseState({
            wasDeactivated: true,
            lastReason: "device_deactivated",
          });
          this.plugin.licenseStatus = "unlicensed";
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Invalidated").onClick(async () => {
          await this.forceLicenseState({
            licenseKey: "BTR-DEV-INVALID",
            sessionToken: "dev-fake",
            sessionExpiresAt: FAR_FUTURE(),
            everValidated: true,
            activatedAt: Date.now() - 30 * day,
            wasInvalidated: true,
            lastReason: "license_invalid",
          });
          this.plugin.licenseStatus = "expired";
          this.display();
        }),
      );

    new Setting(section)
      .setName("Trigger /session refresh")
      .setDesc("Calls the real worker /session endpoint with the current key + deviceId.")
      .addButton((b) =>
        b.setButtonText("Refresh").onClick(async () => {
          await this.plugin.refreshLicenseStatus();
          this.display();
          new Notice("License status refreshed.", 3000);
        }),
      );

    const hasState =
      Boolean(this.plugin.settings.licenseKey) ||
      Boolean(this.plugin.settings.everValidated) ||
      Boolean(this.plugin.settings.pendingTrialActivation);
    new Setting(section)
      .setName("Reset license state")
      .setDesc("Clears all license data on this device + regenerates deviceId.")
      .addButton((b) => {
        b.setButtonText("Reset").setWarning();
        if (!hasState) b.setDisabled(true);
        b.onClick(async () => {
          this.plugin.settings.deviceId = (crypto).randomUUID();
          await this.forceLicenseState({});
          new Notice("Licensing state reset.", 4000);
        });
      });
  }

  /** Apply a fake license-settings shape and re-render. Starts from
   *  a fully-cleared base so partial patches don't leave stale fields
   *  (e.g. forcing Polling shouldn't leave a stale licenseKey). The
   *  deviceId is preserved across forces - only the explicit Reset
   *  action regenerates it. */
  private async forceLicenseState(state: {
    licenseKey?: string;
    sessionToken?: string;
    sessionExpiresAt?: number;
    customerId?: string;
    customerEmail?: string;
    tier?: "v1" | "v2";
    everValidated?: boolean;
    lastValidatedAt?: number;
    licenseExpiresAt?: number;
    pendingTrialActivation?: ButterSettings["pendingTrialActivation"];
    activatedAt?: number;
    wasDeactivated?: boolean;
    wasInvalidated?: boolean;
    lastReason?: string;
  }) {
    this.plugin.settings.licenseKey = "";
    this.plugin.settings.sessionToken = "";
    this.plugin.settings.sessionExpiresAt = 0;
    this.plugin.settings.customerId = "";
    this.plugin.settings.customerEmail = "";
    this.plugin.settings.tier = "v1";
    this.plugin.settings.everValidated = false;
    this.plugin.settings.lastValidatedAt = 0;
    this.plugin.settings.licenseExpiresAt = 0;
    this.plugin.settings.pendingTrialActivation = null;
    this.plugin.settings.activatedAt = 0;
    this.plugin.settings.wasDeactivated = false;
    this.plugin.settings.wasInvalidated = false;
    this.plugin.settings.lastReason = "";
    Object.assign(this.plugin.settings, state);
    await this.plugin.saveSettings();
    await this.plugin.refreshLicenseStatus();
    this.display();
  }

  /** Returns the trial's progress in days/hours plus a derived
   *  daysUsed counter for the 7-segment strip. All zero-valued when
   *  expiry is unknown. `expired` is true once msLeft <= 0. */
  private computeRemaining(): {
    daysLeft: number;
    hoursLeft: number;
    daysUsed: number;
    expired: boolean;
  } {
    const exp = this.plugin.settings.licenseExpiresAt
      || this.plugin.settings.sessionExpiresAt
      || 0;
    if (!exp) {
      return { daysLeft: 7, hoursLeft: 168, daysUsed: 0, expired: false };
    }
    const now = Date.now();
    const msLeft = exp - now;
    if (msLeft <= 0) {
      return { daysLeft: 0, hoursLeft: 0, daysUsed: 7, expired: true };
    }
    const hoursLeft = Math.max(1, Math.ceil(msLeft / (60 * 60 * 1000)));
    if (msLeft < 24 * 60 * 60 * 1000) {
      return { daysLeft: 0, hoursLeft, daysUsed: 6, expired: false };
    }
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    const daysUsed = Math.max(0, Math.min(7, 7 - daysLeft));
    return { daysLeft, hoursLeft, daysUsed, expired: false };
  }

  // ── Inline trial activation (replaces TrialPollingModal) ────

  /** Tap-to-trial: hits `/trial`, persists `pendingTrialActivation`
   *  (including the browser-fallback `checkoutUrl`), flips the
   *  License-status section into the polling phase, and starts the
   *  inline poll loop. Idempotent - a second tap while polling is a
   *  no-op. */
  private async beginTrialActivation(): Promise<void> {
    if (this.plugin.settings.pendingTrialActivation) return; // already in flight
    let resp: Awaited<ReturnType<typeof this.plugin.licenseClient.startTrial>>;
    try {
      resp = await this.plugin.licenseClient.startTrial(
        this.plugin.settings.deviceId,
      );
    } catch (err) {
      if (err instanceof LicenseClientError && err.kind === "trial_used") {
        new Notice(
          "A trial has already been activated on this device. Reset state under device if you're testing.",
          10_000,
        );
      } else {
        const msg = err instanceof LicenseClientError
          ? this.friendlyError(err)
          : "Couldn't reach the licensing server.";
        new Notice(msg, 7000);
      }
      return;
    }

    this.plugin.settings.pendingTrialActivation = {
      pollToken: resp.pollToken,
      startedAt: Date.now(),
      checkoutUrl: resp.checkoutUrl,
    };
    await this.plugin.saveSettings();
    // Re-render the License-status section into the polling state.
    // Polling is scheduled inside renderAccount when the phase is
    // "polling".
    this.display();
  }

  /** Schedule the next `/trial/poll` tick. Cadence ramps with elapsed
   *  time so we hit the server tightly during the typical ~3-5s
   *  fulfillment window then back off. Captures `pollGeneration` so
   *  a render-induced cancel is honored even if the timer already
   *  fired before clearTimeout ran. */
  private scheduleTrialPoll() {
    if (this.trialPollTimer != null) return; // already armed
    const pending = this.plugin.settings.pendingTrialActivation;
    if (!pending) return;
    const ageMs = Date.now() - (pending.startedAt || 0);
    const delay = ageMs < 25_000 ? 1_500 : ageMs < 5 * 60_000 ? 5_000 : 30_000;
    const myGen = this.pollGeneration;
    this.trialPollTimer = window.setTimeout(() => {
      this.trialPollTimer = null;
      if (myGen !== this.pollGeneration) return;
      void this.runTrialPollOnce();
    }, delay);
  }

  /** Single `/trial/poll` request. Updates settings on `ready`,
   *  re-renders accordingly. Re-arms via `display()` if still
   *  polling. */
  private async runTrialPollOnce(): Promise<void> {
    const pending = this.plugin.settings.pendingTrialActivation;
    if (!pending) return;
    const ageMs = Date.now() - (pending.startedAt || 0);
    if (ageMs > 30 * 60_000) {
      // Give up - clear state, return to unlicensed.
      this.plugin.settings.pendingTrialActivation = null;
      await this.plugin.saveSettings();
      this.display();
      return;
    }
    try {
      const res = await this.plugin.licenseClient.pollTrial(pending.pollToken);
      if (res.status === "ready" && res.licenseKey) {
        this.plugin.settings.licenseKey = res.licenseKey;
        if (res.expiresAt) {
          const exp = Date.parse(res.expiresAt);
          if (!Number.isNaN(exp)) this.plugin.settings.licenseExpiresAt = exp;
        }
        this.plugin.settings.pendingTrialActivation = null;
        if (!this.plugin.settings.activatedAt) {
          this.plugin.settings.activatedAt = Date.now();
        }
        // Fresh activation clears any sticky failure flags from a
        // prior state. customerEmail + tier get populated by the
        // first /session call that follows (via refreshLicenseStatus
        // below); we don't need to clear them since this is a brand
        // new license attaching to this device.
        this.plugin.settings.wasDeactivated = false;
        this.plugin.settings.wasInvalidated = false;
        this.plugin.settings.lastReason = "";
        await this.plugin.saveSettings();
        await this.plugin.refreshLicenseStatus();
        new Notice("Trial activated!", 4000);
        this.display();
        return;
      }
    } catch (err) {
      if (err instanceof LicenseClientError && err.kind === "invalid_token") {
        // Token rotted - reset and let the user retry.
        this.plugin.settings.pendingTrialActivation = null;
        await this.plugin.saveSettings();
        this.display();
        return;
      }
      // Transient - fall through, schedule next tick.
    }
    // Pending. Re-render so the "Still working on it…" copy can
    // appear once we cross the 25s threshold, then re-schedule.
    this.display();
  }

  /**
   * Validate-license-key flow: call /session, persist the issued
   * sessionToken, refresh status. On failure, show the typed error
   * message inline beneath the input.
   */
  private async validateLicenseKeyFlow(
    licenseKey: string,
    errorEl: HTMLElement | null,
  ): Promise<void> {
    if (errorEl) errorEl.addClass("butter-hidden");
    try {
      const session = await this.plugin.licenseClient.validateAndIssueSession(
        licenseKey,
        this.plugin.settings.deviceId,
      );
      this.plugin.settings.licenseKey = licenseKey;
      this.plugin.settings.sessionToken = session.sessionToken;
      this.plugin.settings.sessionExpiresAt = Date.parse(session.expiresAt);
      this.plugin.settings.lastValidatedAt = Date.now();
      if (session.customerId) this.plugin.settings.customerId = session.customerId;
      if (session.email) this.plugin.settings.customerEmail = session.email;
      if (session.tier) this.plugin.settings.tier = session.tier;
      this.plugin.settings.everValidated = true;
      if (!this.plugin.settings.activatedAt) {
        this.plugin.settings.activatedAt = Date.now();
      }
      // Fresh activation clears any sticky failure flags from a
      // prior state so the License tab doesn't briefly show
      // "deactivated"/"invalidated" between save + re-render.
      this.plugin.settings.wasDeactivated = false;
      this.plugin.settings.wasInvalidated = false;
      this.plugin.settings.lastReason = "";
      await this.plugin.saveSettings();
      await this.plugin.refreshLicenseStatus();
      this.display();
      new Notice("License activated.", 4000);
    } catch (err) {
      const msg = err instanceof LicenseClientError
        ? this.friendlyError(err)
        : "Couldn't reach the licensing server.";
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.removeClass("butter-hidden");
      } else {
        new Notice(msg, 7000);
      }
    }
  }

  /** Maps the LicenseClientError kind to a customer-facing string.
   *  Settings UI uses this for inline errors + toasts. */
  private friendlyError(err: LicenseClientError): string {
    switch (err.kind) {
      case "license_invalid":
        return "That license key is not valid (revoked, expired, or unrecognized).";
      case "device_deactivated":
        return "This device was deactivated for this license. Re-enter the key to re-activate it.";
      case "device_cap":
        return `This license is active on ${MAX_DEVICES_PER_CUSTOMER} devices already. Deactivate one at licenses.buttereditor.com to free a slot.`;
      case "unauthorized":
        return "Session expired. Re-enter the license key to continue.";
      case "trial_used":
        return "A trial has already been activated for this email or device.";
      case "rate_limited":
        return "Too many attempts in a short window. Wait a minute and try again.";
      case "network":
        return "Couldn't reach the licensing server. Check your internet connection.";
      case "polar_error":
        return "The licensing service is temporarily unavailable. Try again in a minute.";
      case "invalid_input":
        return "Input was rejected by the server. Double-check email + key formatting.";
      default:
        return "Something went wrong. Try again in a moment.";
    }
  }

  /**
   * General tab - the user's touchbase. Intro blurb explaining Butter,
   * the source-purity preset cards (the headline configuration
   * choice), the most-frequently-toggled settings, and a Learn more
   * section with docs link and walkthrough replay.
   */
  private renderGeneral(root: HTMLElement) {
    // Intro + source-purity presets. Composed from a shared helper so
    // the long copy lives in one place.
    this.renderGeneralIntroSections(root);

    // Most-common toggles. These are the knobs new users most often
    // want to change; less-common behavior settings live in the
    // Behavior tab.
    const common = this.createSettingGroup(root, "Common settings");

    new Setting(common)
      .setName("Open notes in Butter")
      .setDesc("Markdown files open directly in Butter. Reload Obsidian after toggling.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.openNewFilesInButter)
          .onChange(async (v) => {
            this.plugin.settings.openNewFilesInButter = v;
            await this.plugin.saveSettings();
            new Notice(
              "Reload Obsidian for this change to take full effect.",
              5000,
            );
          }),
      );

    new Setting(common)
      .setName("Animations")
      .setDesc("Entrance fades, drag springs, hint transitions, and other motion polish. Turn off for slower machines, accessibility, or screen recordings.")
      .addToggle((t) =>
        t
          .setValue(!this.plugin.settings.disableAnimations)
          .onChange(async (v) => {
            this.plugin.settings.disableAnimations = !v;
            await this.plugin.saveSettings();
            this.plugin.applyAnimationsBodyClass();
          }),
      );
  }

  /**
   * Behavior tab - the less-common everyday knobs that don't merit a
   * place on the General tab. Outline, drag handle behavior, plugin
   * compat, view-cycle ordering.
   */
  private renderBehavior(root: HTMLElement) {
    const outline = this.createSettingGroup(root, "Outline");
    this.renderOutlineSection(outline);

    const formatting = this.createSettingGroup(root, "Formatting");
    new Setting(formatting)
      .setName("HTML formatting")
      .setDesc(
        "Show toolbar buttons for marks that can only be written as inline HTML in source: text color, custom highlight color, underline, superscript, subscript, keyboard key. Turn off to keep your source pure Markdown. Existing HTML in files is still read and round-tripped either way.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableHtmlFormatting)
          .onChange(async (v) => {
            this.plugin.settings.enableHtmlFormatting = v;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          }),
      );

    const dragDrop = this.createSettingGroup(root, "Drag and drop");
    this.renderDragSection(dragDrop);
    new Setting(dragDrop)
      .setName("Rich paste and file drop")
      .setDesc("Pasted URLs become links. HTML pastes as Markdown. Images and files dropped on the editor save to the vault and embed.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enablePasteDrop).onChange(async (v) => {
          this.plugin.settings.enablePasteDrop = v;
          await this.plugin.saveSettings();
        }),
      );

    const cycleSection = this.createSettingGroup(root, "View cycle modes");
    const cycleModes: Array<{
      id: "source" | "live" | "reading" | "butter";
      label: string;
      desc: string;
    }> = [
      { id: "source", label: "Source", desc: "Raw markdown text." },
      {
        id: "live",
        label: "Live Preview",
        desc: "Obsidian's default editor - markdown with inline rendering.",
      },
      {
        id: "reading",
        label: "Reading",
        desc: "Read-only rendered view.",
      },
      {
        id: "butter",
        label: "Butter",
        desc: "Butter's WYSIWYG editor (this plugin).",
      },
    ];
    for (const m of cycleModes) {
      new Setting(cycleSection)
        .setName(m.label)
        .setDesc(m.desc)
        .addToggle((t) =>
          t
            .setValue(this.plugin.settings.viewCycleModes.includes(m.id))
            .onChange(async (v) => {
              const current = new Set(this.plugin.settings.viewCycleModes);
              if (v) current.add(m.id);
              else current.delete(m.id);
              // Preserve the canonical order so cycle direction stays
              // consistent regardless of toggle sequence.
              const ordered: Array<typeof m.id> = [];
              for (const id of ["source", "live", "reading", "butter"] as const) {
                if (current.has(id)) ordered.push(id);
              }
              this.plugin.settings.viewCycleModes = ordered;
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  /**
   * Advanced tab - power-user surface. Source preservation + normalize
   * options, canonical-glyph choices, experimental flags (CM6 bridge,
   * theme compat), and debug controls.
   */
  private renderAdvanced(root: HTMLElement) {
    // Source preservation + canonical-glyph + normalize options.
    this.renderSourceSection(root);

    // Compatibility bridges. Each adapts an Obsidian API or theme
    // surface that assumes the native CM6 MarkdownView to Butter's
    // PM editor. Grouped together because they're conceptually
    // related, with per-row Experimental tags where appropriate.
    const compat = this.createSettingGroup(root, "Compatibility");
    new Setting(compat)
      .setName("Plugin autocomplete pop-ups")
      .setDesc("Pop-ups that appear as you type. `[[` for wikilinks, `#` for tags, `:` for emoji, `@today` for Natural Language Dates. Dismiss with Esc.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableSuggestBridge)
          .onChange(async (v) => {
            this.plugin.settings.enableSuggestBridge = v;
            await this.plugin.saveSettings();
          }),
      );
    const inlineWidgets = new Setting(compat)
      .setName("Inline plugin rendering")
      .setDesc("Plugin output rendered inside your note content. Dataview's `= dv.list(...)` becomes a real list; Tasks plugin checkboxes become togglable widgets; Templater commands render in place. Mounts a hidden mirror editor; some plugins may have positioning quirks.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableCM6Bridge).onChange(async (v) => {
          this.plugin.settings.enableCM6Bridge = v;
          await this.plugin.saveSettings();
        }),
      );
    inlineWidgets.nameEl.createSpan({
      cls: "butter-preset-tag is-experimental",
      text: "Experimental",
    });
    const themeCompat = new Setting(compat)
      .setName("Max theme compatibility")
      .setDesc("Claim Obsidian's `.markdown-rendered` class so Reading-mode theme CSS cascades into Butter. Wider theme coverage; some themes assume non-editable content and can break selection or hover.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.experimentalThemeCompatMode)
          .onChange(async (v) => {
            this.plugin.settings.experimentalThemeCompatMode = v;
            await this.plugin.saveSettings();
            this.plugin.applyThemeCompatModeToAllViews();
          }),
      );
    themeCompat.nameEl.createSpan({
      cls: "butter-preset-tag is-experimental",
      text: "Experimental",
    });

    // Debug controls last - usually only touched when investigating
    // an issue.
    const debug = this.createSettingGroup(root, "Debug");
    this.renderDebugSection(debug);
  }

  /**
   * Surface a Start-trial CTA card on the General tab while the user
   * has never activated a license / trial. The card disappears once
   * they have a key or a pending activation - this surface is for
   * users who haven't yet engaged with the licensing flow at all.
   * The button bounces them to the License tab where the actual
   * trial activation UI lives.
   */
  private renderStartTrialCardIfApplicable(root: HTMLElement) {
    const s = this.plugin.settings;
    const hasKey = typeof s.licenseKey === "string" && s.licenseKey.trim() !== "";
    const trialPending = !!s.pendingTrialActivation;
    const hasActivated = !!s.everValidated || !!s.activatedAt;
    if (hasKey || trialPending || hasActivated) return;

    // Native Setting row so the chrome matches the rest of the
    // settings surface. The CTA bounces to the License tab where
    // the actual activation flow lives.
    new Setting(root)
      .setName("Start a free trial")
      .setDesc(
        "Butter is paid software with a free trial. No card, no email. You get the full editor for the trial window, then choose whether to license or fall back to read-only.",
      )
      .addButton((b) =>
        b
          .setButtonText("Start free trial")
          .setCta()
          .onClick(() => {
            this.activeTab = "license";
            this.display();
          }),
      );
  }

  private renderToolbar(root: HTMLElement) {
    // Single tab-level Desktop/Mobile platform switcher rendered
    // FIRST so the layout settings, primary toolbar editor, and
    // table toolbar editor all re-render together when it flips.
    // The device is a tab-level concern, not a per-section one.
    const segKey = "butterToolbarSegment";
    const stored = window.sessionStorage?.getItem(segKey);
    let segment: "desktop" | "mobile" =
      stored === "desktop" || stored === "mobile"
        ? stored
        : (Platform.isMobile ? "mobile" : "desktop");

    const reRenders: Array<() => void> = [];

    const switcher = root.createDiv({
      cls: "butter-toolbar-platform-switcher",
      attr: { role: "tablist", "aria-label": "Toolbar platform" },
    });

    // Sliding accent pill - a single absolutely-positioned element
    // that translates between segments via transform. Sits behind
    // the button labels via z-index so the text stays legible during
    // the slide.
    switcher.createDiv({
      cls: "butter-toolbar-platform-switcher__indicator",
      attr: { "aria-hidden": "true" },
    });

    const makeSegBtn = (label: string, icon: string) => {
      const btn = switcher.createEl("button", {
        cls: "butter-toolbar-platform-switcher__btn",
        attr: { type: "button", role: "tab" },
      });
      const iconEl = btn.createSpan({
        cls: "butter-toolbar-platform-switcher__icon",
      });
      setIcon(iconEl, icon);
      btn.createSpan({
        cls: "butter-toolbar-platform-switcher__label",
        text: label,
      });
      return btn;
    };

    const desktopBtn = makeSegBtn("Desktop", "monitor");
    const mobileBtn = makeSegBtn("Mobile", "smartphone");

    const applyPillState = () => {
      switcher.dataset.segment = segment;
      desktopBtn.classList.toggle("is-active", segment === "desktop");
      mobileBtn.classList.toggle("is-active", segment === "mobile");
      desktopBtn.setAttribute(
        "aria-selected",
        segment === "desktop" ? "true" : "false",
      );
      mobileBtn.setAttribute(
        "aria-selected",
        segment === "mobile" ? "true" : "false",
      );
    };

    const setSegment = (next: "desktop" | "mobile") => {
      if (segment === next) return;
      segment = next;
      try { window.sessionStorage?.setItem?.(segKey, segment); } catch { /* ignore */ }
      applyPillState();
      for (const cb of reRenders) cb();
    };

    desktopBtn.addEventListener("click", () => setSegment("desktop"));
    mobileBtn.addEventListener("click", () => setSegment("mobile"));
    applyPillState();

    this.renderLayoutSection(root, () => segment, reRenders);
    this.renderPrimaryToolbarSection(root, () => segment, reRenders);
    this.renderTableToolbarSection(root, () => segment, reRenders);
  }

  /** Layout settings group, filtered by the tab-level platform switcher.
   *  Desktop view shows toolbar style + position + status-bar fade;
   *  mobile view shows the mobile toolbar style. Active style is
   *  shared and appears in both views (it's the same underlying
   *  setting either way). */
  private renderLayoutSection(
    root: HTMLElement,
    getSegment: () => "desktop" | "mobile",
    reRenders: Array<() => void>,
  ): void {
    const container = root.createDiv({ cls: "butter-toolbar-segment-body" });

    const renderSegment = () => {
      container.empty();
      const segment = getSegment();
      const tag =
        segment === "desktop"
          ? { label: "Desktop", icon: "monitor" }
          : { label: "Mobile", icon: "smartphone" };
      const layoutItems = this.createSettingGroup(
        container,
        "Layout",
        undefined,
        undefined,
        tag,
      );

      if (segment === "desktop") {
        new Setting(layoutItems)
          .setName("Toolbar style")
          .setDesc("Attached sits as a chrome row at the edge of the pane. Detached floats as a card inside the editor.")
          .addDropdown((d) =>
            // Integrated is implemented but hidden from this dropdown
            // until the design pass for view-header layout is finalized.
            // The setting still works if set programmatically.
            d
              .addOptions({
                attached: "Attached",
                detached: "Detached",
              })
              .setValue(
                this.plugin.settings.toolbarStyle === "integrated"
                  ? "attached"
                  : this.plugin.settings.toolbarStyle,
              )
              .onChange(async (v) => {
                this.plugin.settings.toolbarStyle = v as "detached" | "attached" | "integrated";
                await this.plugin.saveSettings();
                this.plugin.applyToolbarPositionToAllViews();
              }),
          );

        new Setting(layoutItems)
          .setName("Toolbar position")
          .setDesc("Top: pins above the editor content. Bottom: pins below.")
          .addDropdown((d) =>
            d
              .addOptions({ top: "Pin to top", bottom: "Pin to bottom" })
              .setValue(this.plugin.settings.toolbarPosition)
              .onChange(async (v) => {
                this.plugin.settings.toolbarPosition = v as "top" | "bottom";
                await this.plugin.saveSettings();
                this.plugin.applyToolbarPositionToAllViews();
              }),
          );
      } else {
        new Setting(layoutItems)
          .setName("Mobile toolbar style")
          .setDesc("Native matches Obsidian's mobile bar. Butter is taller, with accent pills and backdrop blur.")
          .addDropdown((d) =>
            d
              .addOptions({ detached: "Detached", attached: "Attached" })
              .setValue(this.plugin.settings.mobileToolbarStyle)
              .onChange(async (v) => {
                this.plugin.settings.mobileToolbarStyle = v as
                  | "detached"
                  | "attached";
                await this.plugin.saveSettings();
                // Re-render so the data-mobile-style attribute updates
                // on the live toolbar dom without a view reopen.
                this.plugin.applyToolbarButtonVisibilityToAllViews();
              }),
          );
      }

      // Active style applies to both desktop and mobile toolbars,
      // so render it in either segment view.
      new Setting(layoutItems)
        .setName("Active style")
        .setDesc("How active formatting buttons are highlighted.")
        .addDropdown((d) =>
          d
            .addOptions({
              filled: "Filled",
              soft: "Soft",
              outlined: "Outlined",
              underline: "Underline",
            })
            .setValue(this.plugin.settings.toolbarActiveStyle)
            .onChange(async (v) => {
              this.plugin.settings.toolbarActiveStyle = v as "underline" | "filled" | "soft" | "outlined";
              await this.plugin.saveSettings();
            }),
        );

      if (segment === "desktop") {
        new Setting(layoutItems)
          .setName("Fade status bar on toolbar hover")
          .setDesc("When the bottom toolbar overlaps the status bar, hovering toolbar buttons fades the status bar so they're reachable.")
          .addToggle((t) =>
            t
              .setValue(this.plugin.settings.statusBarHoverFade)
              .onChange(async (v) => {
                this.plugin.settings.statusBarHoverFade = v;
                await this.plugin.saveSettings();
                // If the user disables while the fade is active, force
                // it off immediately rather than waiting for the next
                // mousemove to clear the class.
                if (!v) {
                  activeDocument.body.classList.remove("butter-status-bar-hide");
                }
              }),
          );
      }
    };

    reRenders.push(renderSegment);
    renderSegment();
  }

  /**
   * Native Obsidian settings group: a `setting-item-heading` row at
   * the top + a `setting-items` body underneath. Matches the markup
   * Obsidian's own appearance / about settings produce, so the
   * native CSS supplies the visual chrome (card-style background,
   * dividers between rows). No custom card classes - pure native.
   *
   * Optional `action` adds an icon button to the heading's right side
   * (rendered through `.setting-item-control`, same slot dropdowns
   * and toggles use on regular setting rows).
   */
  private createSettingGroup(
    parent: HTMLElement,
    heading: string,
    description?: string,
    action?: {
      icon: string;
      tooltip: string;
      onClick: () => void | Promise<void>;
    },
    tag?: { label: string; icon?: string },
  ): HTMLElement {
    const group = parent.createDiv({ cls: "setting-group butter-setting-group" });
    const headerEl = group.createDiv({
      cls: "setting-item setting-item-heading",
    });
    const infoEl = headerEl.createDiv({ cls: "setting-item-info" });
    const nameEl = infoEl.createDiv({
      cls: "setting-item-name",
      text: heading,
    });
    // Optional dimmed-italic suffix (icon + label) on the heading.
    // Same visual treatment as the "Experimental" preset tag - used
    // by the platform-segmented sections (Layout / Primary toolbar /
    // Table toolbar) to show whether the current view is Desktop or
    // Mobile.
    if (tag) {
      const tagEl = nameEl.createSpan({ cls: "butter-platform-tag" });
      if (tag.icon) {
        const iconEl = tagEl.createSpan({ cls: "butter-platform-tag__icon" });
        setIcon(iconEl, tag.icon);
      }
      tagEl.createSpan({
        cls: "butter-platform-tag__label",
        text: tag.label,
      });
    }
    if (description) {
      infoEl.createDiv({ cls: "setting-item-description", text: description });
    }
    if (action) {
      const controlEl = headerEl.createDiv({ cls: "setting-item-control" });
      const btn = controlEl.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": action.tooltip, type: "button" },
      });
      setIcon(btn, action.icon);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        void action.onClick();
      });
    }
    return group.createDiv({ cls: "setting-items" });
  }

  /**
   * Layout editor - two-list customizer with drag-to-reorder,
   * add/remove, and create/edit/delete submenus. Mirrors Obsidian's
   * own mobile-toolbar settings pattern: rows are full-width with
   * large tap targets so it works on both desktop and touch.
   *
   * `On toolbar` shows the current layout in order; submenu rows
   * are followed by their indented children (single-level nesting).
   * `Available` shows buttons not currently anywhere in the layout.
   * Drag-handle drag reorders within the same parent. The kebab
   * menu on each row exposes cross-level moves and deletion.
   */
  /**
   * Primary-toolbar section. Re-renders its layout editor when the
   * tab-level platform switcher (rendered in `renderToolbar`) flips
   * between Desktop and Mobile. Each platform edits its own layout
   * (`toolbarLayout` vs `mobileToolbarLayout`); the active toolbar
   * at runtime is picked by `getActiveToolbarLayout()` based on
   * `Platform.isMobile`. Letting the user edit BOTH from either
   * platform matches how Obsidian Sync moves a single `data.json`
   * between desktop and mobile - the user can prep their phone
   * toolbar from desktop and vice versa.
   */
  private renderPrimaryToolbarSection(
    root: HTMLElement,
    getSegment: () => "desktop" | "mobile",
    reRenders: Array<() => void>,
  ): void {
    // Container for the layout editor - we re-render this on
    // segment change. Tab-level switcher is rendered separately.
    const container = root.createDiv({ cls: "butter-toolbar-segment-body" });

    const renderSegment = () => {
      container.empty();
      const segment = getSegment();
      if (segment === "desktop") {
        this.renderLayoutEditor(
          container,
          "Primary toolbar",
          "Drag rows to reorder. Tap row actions to remove or move into a submenu. Tap an Available button's plus to add it back.",
          MAIN_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getMainToolbarLayout(),
          async (next) => {
            this.plugin.settings.toolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Full toolbar preset",
              desc: "Every Butter feature, organized into submenus.",
              cta: true,
              build: mainLayoutFull,
            },
            {
              name: "Simple toolbar preset",
              desc: "Pared-down essentials only.",
              build: mainLayoutSimple,
            },
          ],
          { label: "Desktop", icon: "monitor" },
        );
      } else {
        this.renderLayoutEditor(
          container,
          "Primary toolbar",
          "Shown above the soft keyboard on phones and tablets. Submenus flatten on mobile, so pick a focused subset.",
          MAIN_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getMobileToolbarLayout(),
          async (next) => {
            this.plugin.settings.mobileToolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Default toolbar preset",
              desc: "Curated thumb-friendly button strip.",
              cta: true,
              build: mobileLayoutDefault,
            },
          ],
          { label: "Mobile", icon: "smartphone" },
        );
      }
    };

    reRenders.push(renderSegment);
    renderSegment();
  }

  /** Mirrors `renderPrimaryToolbarSection` for the table toolbar.
   *  Shares the same tab-level platform switcher; mobile segment
   *  edits `mobileTableToolbarLayout` and uses `mobileTableLayoutDefault`
   *  as its preset. */
  private renderTableToolbarSection(
    root: HTMLElement,
    getSegment: () => "desktop" | "mobile",
    reRenders: Array<() => void>,
  ): void {
    const container = root.createDiv({ cls: "butter-toolbar-segment-body" });

    const renderSegment = () => {
      container.empty();
      const segment = getSegment();
      if (segment === "desktop") {
        this.renderLayoutEditor(
          container,
          "Table toolbar",
          "Shown when the cursor is inside a table. Drag rows to reorder.",
          TABLE_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getTableToolbarLayout(),
          async (next) => {
            this.plugin.settings.tableToolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Default table toolbar preset",
              desc: "Built-in table toolbar layout.",
              cta: true,
              build: defaultTableLayout,
            },
          ],
          { label: "Desktop", icon: "monitor" },
        );
      } else {
        this.renderLayoutEditor(
          container,
          "Table toolbar",
          "Shown when the cursor is inside a table on mobile. Replaces the main toolbar; thumb-friendly sizing.",
          TABLE_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getMobileTableToolbarLayout(),
          async (next) => {
            this.plugin.settings.mobileTableToolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Default table toolbar preset",
              desc: "Curated thumb-friendly table buttons.",
              cta: true,
              build: mobileTableLayoutDefault,
            },
          ],
          { label: "Mobile", icon: "smartphone" },
        );
      }
    };

    reRenders.push(renderSegment);
    renderSegment();
  }

  private renderLayoutEditor(
    root: HTMLElement,
    title: string,
    desc: string,
    defs: ReadonlyArray<{
      id: string;
      label: string;
      group: string;
      icon: string;
    }>,
    getLayout: () => ToolbarLayoutItem[],
    saveLayout: (layout: ToolbarLayoutItem[]) => Promise<void>,
    presets: ReadonlyArray<{
      name: string;
      desc: string;
      cta?: boolean;
      build: () => ToolbarLayoutItem[];
    }>,
    tag?: { label: string; icon?: string },
  ) {
    const defLookup = new Map(defs.map((d) => [d.id, d]));

    // Single setting-group card holding both the preset rows and
    // the button-by-button customizer. Keeps everything related to
    // configuring this toolbar in one visual container.
    const items = this.createSettingGroup(
      root,
      title,
      undefined,
      undefined,
      tag,
    );

    for (const p of presets) {
      const row = new Setting(items).setName(p.name).setDesc(p.desc);
      row.addButton((b) => {
        b.setButtonText("Apply").onClick(async () => {
          await saveLayout(p.build());
          rerender();
        });
        if (p.cta) b.setCta();
      });
    }

    // "Customize buttons" intro row sits between the presets and the
    // drag/drop customizer below. Plain setting-item (no `.setHeading()`)
    // so it aligns horizontally with the preset rows above instead of
    // adopting the native heading row's competing chrome. The
    // `sliders-horizontal` icon flags it as the customization
    // entry-point distinct from the preset rows above.
    const customizeRow = new Setting(items)
      .setName("Customize buttons")
      .setDesc(desc);
    const customizeIcon = createSpan({ cls: "butter-customize-icon" });
    setIcon(customizeIcon, "sliders-horizontal");
    customizeRow.nameEl.prepend(customizeIcon);

    const wrap = items.createDiv({ cls: "butter-layout-editor" });

    const rerender = () => {
      wrap.empty();
      const layout = cloneLayout(getLayout());

      // ── ON TOOLBAR list ──
      const onWrap = wrap.createDiv({ cls: "butter-layout-list" });
      onWrap.createEl("div", {
        cls: "butter-layout-list-label",
        text: "On toolbar",
      });
      const onList = onWrap.createDiv({
        cls: "butter-layout-rows",
        attr: { "data-list": "on" },
      });

      const renderRow = (
        item: ToolbarLayoutItem,
        parentArr: ToolbarLayoutItem[],
        index: number,
        depth: number,
      ) => {
        const row = onList.createDiv({
          cls: "butter-layout-row",
          attr: {
            "data-item-id": item.id,
            "data-depth": String(depth),
            "data-type": item.type,
          },
        });
        if (depth > 0) row.classList.add("is-nested");

        const handle = row.createEl("button", {
          cls: "butter-layout-handle clickable-icon",
          attr: { "aria-label": "Drag to reorder", type: "button" },
        });
        setIcon(handle, "grip-vertical");
        handle.dataset.dragHandle = "1";

        const icon = row.createDiv({ cls: "butter-layout-icon" });
        const label = row.createDiv({ cls: "butter-layout-label" });

        if (item.type === "separator") {
          row.classList.add("is-separator");
          // Keep the icon slot empty (don't remove it) so the label
          // text aligns horizontally with other rows' labels - the
          // icon column reserves the same left indent across every
          // row type. The label itself takes a muted-italic style
          // that reads as "divider marker" without competing with
          // the surrounding rows visually.
          label.setText("Divider");
          label.classList.add("butter-layout-sep-label");
        } else if (item.type === "submenu") {
          setIcon(icon, item.icon || "more-horizontal");
          label.setText(item.label || "Submenu");
          row.classList.add("is-submenu");
        } else {
          const def = defLookup.get(item.id);
          setIcon(icon, def?.icon ?? "circle-help");
          label.setText(def?.label ?? item.id);
        }

        const actions = row.createDiv({ cls: "butter-layout-row-actions" });

        if (item.type === "submenu") {
          const editBtn = actions.createEl("button", {
            cls: "butter-layout-action clickable-icon",
            attr: { "aria-label": "Edit submenu", type: "button" },
          });
          setIcon(editBtn, "pencil");
          editBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.openSubmenuEditModal(item, async () => {
              await saveLayout(layout);
              rerender();
            });
          });
        }

        // Cross-level move: top-level button can be moved into a
        // submenu; child can be moved out to top-level.
        if (item.type === "button") {
          const submenus = layout.filter(
            (i) => i.type === "submenu",
          );
          if (depth === 0 && submenus.length > 0) {
            const moveBtn = actions.createEl("button", {
              cls: "butter-layout-action clickable-icon",
              attr: { "aria-label": "Move into submenu", type: "button" },
            });
            setIcon(moveBtn, "folder-input");
            moveBtn.addEventListener("click", (e) => {
              e.preventDefault();
              this.openMoveToSubmenuMenu(moveBtn, submenus, async (subId) => {
                const targetSub = layout.find(
                  (i) => i.type === "submenu" && i.id === subId,
                ) as Extract<ToolbarLayoutItem, { type: "submenu" }> | undefined;
                if (!targetSub) return;
                const idx = parentArr.findIndex((i) => i.id === item.id);
                if (idx < 0) return;
                parentArr.splice(idx, 1);
                targetSub.children.push(item);
                await saveLayout(layout);
                rerender();
              });
            });
          }
          if (depth > 0) {
            const moveOutBtn = actions.createEl("button", {
              cls: "butter-layout-action clickable-icon",
              attr: {
                "aria-label": "Move out of submenu",
                type: "button",
              },
            });
            setIcon(moveOutBtn, "folder-output");
            moveOutBtn.addEventListener("click", (e) => {
              e.preventDefault();
              const idx = parentArr.findIndex((i) => i.id === item.id);
              if (idx < 0) return;
              parentArr.splice(idx, 1);
              layout.push(item);
              void (async () => {
                await saveLayout(layout);
                rerender();
              })();
            });
          }
        }

        const removeBtn = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon mod-danger",
          attr: { "aria-label": "Remove from toolbar", type: "button" },
        });
        setIcon(removeBtn, "x");
        removeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const idx = parentArr.findIndex((i) => i.id === item.id);
          if (idx < 0) return;
          parentArr.splice(idx, 1);
          void (async () => {
            await saveLayout(layout);
            rerender();
          })();
        });

        // Wire drag-to-reorder. Supports any-depth drops: drop a
        // row before/after another row (at the target's level), or
        // drop a row INTO a submenu (becomes its last child). See
        // `wireDrag()` below.
        this.wireDrag(handle, row, layout, item.id, async () => {
          await saveLayout(layout);
          rerender();
        });
      };

      for (let i = 0; i < layout.length; i++) {
        const item = layout[i];
        renderRow(item, layout, i, 0);
        if (item.type === "submenu") {
          for (let j = 0; j < item.children.length; j++) {
            renderRow(item.children[j], item.children, j, 1);
          }
          if (item.children.length === 0) {
            const empty = onList.createDiv({
              cls: "butter-layout-row is-nested is-empty",
            });
            empty.createDiv({
              cls: "butter-layout-empty",
              text: "Empty submenu - add buttons via their Move actions.",
            });
          }
        }
      }

      // Add-controls row - Obsidian-style buttons with icon + label.
      const addRow = onWrap.createDiv({ cls: "butter-layout-add-row" });
      const buildAddBtn = (
        icon: string,
        label: string,
        onClick: (e: MouseEvent) => void,
      ) => {
        const btn = addRow.createEl("button", {
          cls: "butter-layout-add-btn",
          attr: { type: "button" },
        });
        const iconWrap = btn.createSpan({ cls: "butter-layout-add-btn-icon" });
        setIcon(iconWrap, icon);
        btn.createSpan({ text: label });
        btn.addEventListener("click", onClick);
      };
      buildAddBtn("folder", "Submenu", (e) => {
        e.preventDefault();
        this.openSubmenuEditModal(
          {
            type: "submenu",
            id: newId("sub"),
            label: "New submenu",
            icon: "more-horizontal",
            children: [],
          },
          async (created) => {
            layout.push(created);
            await saveLayout(layout);
            rerender();
          },
          /* isNew */ true,
        );
      });
      buildAddBtn("minus", "Divider", (e) => {
        e.preventDefault();
        layout.push({ type: "separator", id: newId("sep") });
        void (async () => {
          await saveLayout(layout);
          rerender();
        })();
      });

      // ── AVAILABLE list ──
      const used = collectButtonIds(layout);
      const available = defs.filter((d) => !used.has(d.id));
      if (available.length > 0) {
        const availWrap = wrap.createDiv({ cls: "butter-layout-list" });
        availWrap.createEl("div", {
          cls: "butter-layout-list-label",
          text: "Available",
        });
        const availList = availWrap.createDiv({ cls: "butter-layout-rows" });
        for (const def of available) {
          const row = availList.createDiv({
            cls: "butter-layout-row is-available",
          });
          const icon = row.createDiv({ cls: "butter-layout-icon" });
          setIcon(icon, def.icon);
          row.createDiv({ cls: "butter-layout-label", text: def.label });
          const addBtn = row.createEl("button", {
            cls: "butter-layout-action clickable-icon mod-add",
            attr: { "aria-label": `Add ${def.label}`, type: "button" },
          });
          setIcon(addBtn, "plus");
          addBtn.addEventListener("click", (e) => {
            e.preventDefault();
            layout.push({ type: "button", id: def.id });
            void (async () => {
              await saveLayout(layout);
              rerender();
            })();
          });
        }
      }
    };

    rerender();
  }

  /** Open a small floating menu anchored to `anchor` listing each
   *  available submenu. Tap a row to invoke `onPick(submenuId)`. */
  private openMoveToSubmenuMenu(
    anchor: HTMLElement,
    submenus: Array<Extract<ToolbarLayoutItem, { type: "submenu" }>>,
    onPick: (submenuId: string) => void | Promise<void>,
  ) {
    const menu = activeDocument.createElement("div");
    menu.classList.add("butter-layout-popup-menu");
    for (const sub of submenus) {
      const item = menu.createDiv({ cls: "butter-layout-popup-menu-item" });
      const icn = item.createDiv({ cls: "butter-layout-popup-menu-icon" });
      setIcon(icn, sub.icon || "more-horizontal");
      item.createDiv({
        cls: "butter-layout-popup-menu-label",
        text: sub.label || "Submenu",
      });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        cleanup();
        void onPick(sub.id);
      });
    }
    const rect = anchor.getBoundingClientRect();
    menu.addClass("butter-pos-fixed");
    menu.setCssProps({
      "--butter-pos-top": `${rect.bottom + 4}px`,
      "--butter-pos-left": `${Math.max(8, rect.right - 220)}px`,
    });
    activeDocument.body.appendChild(menu);
    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) cleanup();
    };
    // Close on any scroll - the menu is position:fixed so it would
    // otherwise stay glued to the viewport while its anchor button
    // scrolls away. `true` (capture) so we catch scrolls on inner
    // scrollable containers (the settings pane), not just window.
    const dismissOnScroll = () => cleanup();
    const cleanup = () => {
      menu.remove();
      activeDocument.removeEventListener("mousedown", dismiss);
      activeDocument.removeEventListener("touchstart", dismiss as unknown as EventListener);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
    window.setTimeout(() => {
      activeDocument.addEventListener("mousedown", dismiss);
      activeDocument.addEventListener("touchstart", dismiss as unknown as EventListener);
      window.addEventListener("scroll", dismissOnScroll, true);
    }, 0);
  }

  /** Modal for create / edit submenu (icon + label).
   *  Mutates `item` in place and calls onSave when committed. */
  private openSubmenuEditModal(
    item: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    onSave: (
      updated: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    ) => void | Promise<void>,
    isNew = false,
  ) {
    const modal = new SubmenuEditModal(this.app, item, isNew, async (updated) => {
      await onSave(updated);
    });
    modal.open();
  }

  /** Pointer-event drag-to-reorder with cross-level support.
   *
   * Drop targets fall into three kinds:
   *   • `before` ref-row → insert as the previous sibling of the
   *     ref-row's parent (depth-aware - a ref-row inside a submenu
   *     means we drop into the submenu's children).
   *   • `after`  ref-row → same but after.
   *   • `into`   submenu-row → append as the submenu's last child.
   *
   * Visual: blue line at the top/bottom edge of the ref-row for
   * before/after; accent-tinted background on the submenu row for
   * into. Both work on touch + mouse via pointer events. */
  private wireDrag(
    handle: HTMLElement,
    row: HTMLElement,
    rootLayout: ToolbarLayoutItem[],
    draggedItemId: string,
    onCommit: () => void | Promise<void>,
  ) {
    // Inner function that runs the actual drag interaction. Pulled
    // out so two activation paths can call it: the desktop "click
    // and drag the handle" path (immediate via pointerdown) and the
    // mobile "long-press anywhere on the row" path (delayed via a
    // touch-friendly timer). `pointerType` is forwarded so the
    // mobile path can register a non-passive touchmove listener
    // that blocks the browser's natural pan-y scrolling for the
    // duration of the drag.
    const initDrag = (startY: number, pointerType: string) => {
      const list = row.parentElement!;
      const startRect = row.getBoundingClientRect();

      // For touch drags, block the page's scroll so finger movement
      // moves the ghost rather than scrolling under it.
      let preventScroll: ((e: TouchEvent) => void) | null = null;
      if (pointerType === "touch") {
        preventScroll = (e) => e.preventDefault();
        activeDocument.addEventListener("touchmove", preventScroll, { passive: false });
      }

      // Pin the list container's height for the duration of the drag.
      // Without this, the source's collapse (.is-dragging → max-height
      // 0) shrinks the container by sourceFootprint, but the rows
      // pushed by translateY for the drop gap visually extend BELOW
      // the container's new bottom edge - and overflow:hidden on
      // .butter-layout-rows clips them out of view. Pinning min-height
      // to the original height keeps the bottom rows visible.
      const startListHeight = list.getBoundingClientRect().height;
      list.style.minHeight = `${startListHeight}px`;

      // Find the nearest vertically-scrollable ancestor so auto-scroll
      // can run when the cursor sits near the scroller's top or
      // bottom edge during a drag. The settings pane is the usual
      // scroller; we walk up from the list and pick the first
      // ancestor whose computed `overflow-y` is auto/scroll and
      // whose content overflows.
      const findScroller = (start: HTMLElement): HTMLElement | null => {
        let cur: HTMLElement | null = start.parentElement;
        while (cur) {
          const style = window.getComputedStyle(cur);
          const oy = style.overflowY;
          if (
            (oy === "auto" || oy === "scroll") &&
            cur.scrollHeight > cur.clientHeight
          ) {
            return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      };
      const scroller = findScroller(list);
      const startScrollTop = scroller ? scroller.scrollTop : 0;

      // Cache row metadata for the live-reflow shifts. Source's
      // children rows (if dragging a submenu) also collapse so the
      // submenu's whole footprint vacates as one unit.
      const allRows = Array.from(
        list.querySelectorAll<HTMLElement>(".butter-layout-row[data-item-id]"),
      );
      const sourceIdx = allRows.indexOf(row);
      const sourceChildRows: HTMLElement[] = [];
      if (row.dataset.type === "submenu") {
        let next = row.nextElementSibling as HTMLElement | null;
        while (next && next.classList.contains("is-nested")) {
          sourceChildRows.push(next);
          next = next.nextElementSibling as HTMLElement | null;
        }
      }
      // Total footprint that vacates when the source collapses.
      const sourceFootprint =
        startRect.height +
        sourceChildRows.reduce(
          (acc, r) => acc + r.getBoundingClientRect().height,
          0,
        );

      // Snapshot every row's rect BEFORE `.is-dragging` is applied -
      // once the source collapses, rows below it shift up to fill
      // the slot, which makes live `getBoundingClientRect` lie about
      // their "natural" Y. Trigger calculations want the pre-shift
      // positions: a 1H downward drag should advance the target by
      // 1 row, which only works if we compare the ghost's leading
      // edge against original midpoints, not shifted ones.
      const originalRects = new Map<HTMLElement, DOMRect>();
      for (const r of allRows) {
        originalRects.set(r, r.getBoundingClientRect());
      }

      // Floating ghost. When dragging a submenu, the ghost is a
      // wrapper containing the parent clone PLUS each child clone -
      // otherwise the children would just collapse via `.is-dragging`
      // on the source rows and visually disappear during the drag.
      // We clone BEFORE applying `.is-dragging` to the originals so
      // the clones stay at full height.
      const ghost = activeDocument.createElement("div");
      ghost.classList.add("butter-layout-row-ghost");
      ghost.setCssProps({
        "--butter-pos-width": `${startRect.width}px`,
        "--butter-pos-left": `${startRect.left}px`,
        "--butter-pos-top": `${startRect.top}px`,
      });
      ghost.appendChild(row.cloneNode(true) as HTMLElement);
      for (const child of sourceChildRows) {
        ghost.appendChild(child.cloneNode(true) as HTMLElement);
      }
      activeDocument.body.appendChild(ghost);

      // Suppress transitions for the setup frame so the source
      // collapse + initial reflow push apply in one paint. Without
      // this, rows-below would briefly shift UP to fill the source's
      // collapsed slot, then animate back DOWN via the transform
      // transition - a visible shrink-grow glitch on every drag start.
      list.classList.add("butter-layout-drag-snap");

      // Collapse the source's slot (and any nested children).
      row.classList.add("is-dragging");
      for (const child of sourceChildRows) {
        child.classList.add("is-dragging");
      }

      const indicator = activeDocument.createElement("div");
      indicator.classList.add("butter-layout-drop-indicator");
      list.appendChild(indicator);

      type DropTarget =
        | { kind: "before" | "after"; refRowId: string }
        | { kind: "into"; submenuId: string };
      let target: DropTarget | null = null;

      // Track which rows currently have a translateY shift applied
      // so we only mutate styles when the set changes (avoids
      // restarting transitions on every pointermove tick).
      let pushedRows = new Set<HTMLElement>();
      const clearShifts = () => {
        for (const r of pushedRows) r.style.removeProperty("transform");
        pushedRows = new Set();
      };

      /** Walks past `refIdx` to skip any indented children rows that
       *  visually belong with refIdx (when refIdx is a submenu in
       *  the rendered DOM). Returns the last DOM-index of the
       *  submenu's footprint. For non-submenu rows, returns refIdx. */
      const skipSubmenuChildren = (refIdx: number): number => {
        const refEl = allRows[refIdx];
        if (!refEl || refEl.dataset.type !== "submenu") return refIdx;
        let last = refIdx;
        for (let i = refIdx + 1; i < allRows.length; i++) {
          if (allRows[i].classList.contains("is-nested")) last = i;
          else break;
        }
        return last;
      };

      /** Push every non-source row that comes after the drop point
       *  down by the source's footprint. Rows before the drop point
       *  stay at translateY(0). The CSS transition on `transform`
       *  makes the shift smooth.
       *
       *  Special-casing:
       *  - For `into <submenu>`: open the gap AT THE END of the
       *    submenu's children (not above them) so the highlight +
       *    gap together convey "appending as a new child".
       *  - For `after <submenu>`: skip past the submenu's expanded
       *    children when computing the push start so we don't
       *    push them around (they belong with the submenu in the
       *    rendered DOM, not separately). */
      const applyReflow = (t: DropTarget | null) => {
        const want = new Set<HTMLElement>();
        if (t) {
          let startPushIdx = -1;
          if (t.kind === "into") {
            const subRow = list.querySelector<HTMLElement>(
              `.butter-layout-row[data-item-id="${t.submenuId}"]`,
            );
            if (subRow) {
              const subIdx = allRows.indexOf(subRow);
              startPushIdx = skipSubmenuChildren(subIdx) + 1;
            }
          } else {
            const refRow = list.querySelector<HTMLElement>(
              `.butter-layout-row[data-item-id="${t.refRowId}"]`,
            );
            if (refRow) {
              const refIdx = allRows.indexOf(refRow);
              startPushIdx =
                t.kind === "before"
                  ? refIdx
                  : skipSubmenuChildren(refIdx) + 1;
            }
          }
          if (startPushIdx >= 0) {
            for (let i = startPushIdx; i < allRows.length; i++) {
              const r = allRows[i];
              if (r === row || sourceChildRows.includes(r)) continue;
              want.add(r);
            }
          }
        }

        // Diff against the currently-pushed set.
        for (const r of pushedRows) {
          if (!want.has(r)) r.style.removeProperty("transform");
        }
        for (const r of want) {
          if (!pushedRows.has(r)) {
            r.style.transform = `translateY(${sourceFootprint}px)`;
          }
        }
        pushedRows = want;
      };

      // Seed the target at the source's own slot so applyReflow
      // pushes rows-below back to their original positions
      // immediately on pointerdown. Without this seed, target starts
      // null, no push runs, and the rows-below visibly shift UP to
      // fill the source's collapsed slot before the user moves the
      // cursor - which reads as a glitchy hop.
      const prevRow = sourceIdx > 0 ? allRows[sourceIdx - 1] : null;
      const nextNonSourceIdx = sourceIdx + 1 + sourceChildRows.length;
      const initialTarget: DropTarget | null = prevRow
        ? { kind: "after", refRowId: prevRow.dataset.itemId! }
        : nextNonSourceIdx < allRows.length
          ? { kind: "before", refRowId: allRows[nextNonSourceIdx].dataset.itemId! }
          : null;
      applyReflow(initialTarget);
      target = initialTarget;

      // Force a synchronous layout so the snap-class styles commit
      // before we restore transitions. Reading `offsetHeight` is the
      // standard trick - it forces the browser to flush pending
      // style changes.
      void list.offsetHeight;
      list.classList.remove("butter-layout-drag-snap");

      const clearHighlights = () => {
        list
          .querySelectorAll<HTMLElement>(".is-drop-into")
          .forEach((el) => el.classList.remove("is-drop-into"));
      };

      // Track the previous resolved target so we can apply a small
      // hysteresis deadband at the before↔after boundary on a single
      // row - without it, the cursor sitting exactly on a row's
      // midpoint flickers the row's pushed state every other tick,
      // which reads as "shake".
      let lastTarget: DropTarget | null = null;
      const HYSTERESIS_PX = 6;

      const draggingSubmenu = row.dataset.type === "submenu";

      const computeTarget = (pointerY: number): DropTarget | null => {
        const candidates = allRows.filter(
          (r) =>
            r.dataset.itemId !== draggedItemId &&
            !sourceChildRows.includes(r),
        );
        if (candidates.length === 0) return null;

        // Sort by ORIGINAL top - we want the trigger to compare the
        // ghost's leading edge against the pre-drag row positions,
        // not the live shifted ones. Otherwise a multi-row drag
        // jumps multiple positions because the post-collapse layout
        // has the next-below row already shifted up to where the
        // ghost's bottom starts.
        const rects = candidates
          .map((r) => ({ row: r, rect: originalRects.get(r) ?? r.getBoundingClientRect() }))
          .sort((a, b) => a.rect.top - b.rect.top);

        // Above all visible rows → before the first.
        if (pointerY < rects[0].rect.top) {
          return { kind: "before", refRowId: rects[0].row.dataset.itemId! };
        }

        const resolveOnRow = (r: HTMLElement, rect: DOMRect): DropTarget => {
          const isSubmenu = r.dataset.type === "submenu";
          if (isSubmenu && !draggingSubmenu) {
            const margin = rect.height * 0.3;
            if (
              pointerY >= rect.top + margin &&
              pointerY <= rect.bottom - margin
            ) {
              return { kind: "into", submenuId: r.dataset.itemId! };
            }
          }
          const mid = rect.top + rect.height / 2;
          return pointerY < mid
            ? { kind: "before", refRowId: r.dataset.itemId! }
            : { kind: "after", refRowId: r.dataset.itemId! };
        };

        for (let i = 0; i < rects.length; i++) {
          const { row: r, rect } = rects[i];

          // Pointer inside this row?
          if (pointerY >= rect.top && pointerY <= rect.bottom) {
            return resolveOnRow(r, rect);
          }

          // Pointer in the gap between this row and the next?
          // Snap to whichever side is closer - keeps the target
          // stable instead of flickering null in dead space.
          if (i < rects.length - 1) {
            const nextRect = rects[i + 1].rect;
            if (pointerY > rect.bottom && pointerY < nextRect.top) {
              const distAbove = pointerY - rect.bottom;
              const distBelow = nextRect.top - pointerY;
              return distAbove < distBelow
                ? { kind: "after", refRowId: r.dataset.itemId! }
                : {
                    kind: "before",
                    refRowId: rects[i + 1].row.dataset.itemId!,
                  };
            }
          }
        }

        // Below all visible rows → after the last.
        const last = rects[rects.length - 1];
        return { kind: "after", refRowId: last.row.dataset.itemId! };
      };

      const applyHysteresis = (
        raw: DropTarget | null,
        pointerY: number,
      ): DropTarget | null => {
        if (
          !lastTarget ||
          !raw ||
          raw.kind === "into" ||
          lastTarget.kind === "into"
        ) {
          lastTarget = raw;
          return raw;
        }
        // Same row, opposite kind = boundary toggle. Require a
        // few pixels past the current row's midpoint before letting
        // it flip.
        if (
          raw.refRowId === lastTarget.refRowId &&
          raw.kind !== lastTarget.kind
        ) {
          const refRow = list.querySelector<HTMLElement>(
            `.butter-layout-row[data-item-id="${raw.refRowId}"]`,
          );
          if (refRow) {
            const rect = originalRects.get(refRow) ?? refRow.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (Math.abs(pointerY - mid) < HYSTERESIS_PX) {
              return lastTarget;
            }
          }
        }
        lastTarget = raw;
        return raw;
      };

      const updateIndicator = () => {
        clearHighlights();
        // The reflow gap (siblings shifted to make room) is the
        // visual cue for before/after drops - no extra line needed.
        // For "into" we still need an explicit highlight since no
        // gap is created.
        indicator.addClass("butter-hidden");
        if (!target) return;
        if (target.kind === "into") {
          const subRow = list.querySelector<HTMLElement>(
            `.butter-layout-row[data-item-id="${target.submenuId}"]`,
          );
          subRow?.classList.add("is-drop-into");
        }
      };

      // Latest cursor Y, kept up to date by onMove so the auto-scroll
      // tick can re-evaluate the target each frame even while the
      // user holds their finger still (rows are scrolling under
      // them, so the target row at the cursor's screen Y changes).
      let lastPointerY = startY;

      // Run the target computation + reflow for a given cursor Y.
      // Factored out of onMove so the auto-scroll rAF can call it.
      const processMove = (pointerY: number) => {
        lastPointerY = pointerY;
        const dy = pointerY - startY;
        ghost.style.top = `${startRect.top + dy}px`;
        // For a single-row drag the cursor IS the natural trigger.
        // For a multi-row submenu drag use the LEADING edge of the
        // group as the trigger: upper edge (ghost.top) when dragging
        // upward, lower edge (ghost.top + footprint) when dragging
        // downward. The leading edge is what's "moving into new
        // territory" - matching it to a target row makes the
        // dropped source land where the user expects (source's
        // top at the upper edge when going up, source's bottom at
        // the lower edge when going down).
        let triggerY: number;
        if (draggingSubmenu) {
          const ghostTop = startRect.top + dy;
          const ghostBottom = ghostTop + sourceFootprint;
          triggerY =
            dy < 0
              ? ghostTop
              : dy > 0
                ? ghostBottom
                : pointerY;
        } else {
          triggerY = pointerY;
        }
        // originalRects were captured pre-collapse and pre-scroll.
        // If the container has scrolled since then, every row's
        // current viewport Y differs from its captured rect by
        // exactly the scroll delta. Adjusting the trigger Y by the
        // same delta keeps the comparison against original rects
        // accurate regardless of auto-scroll progress.
        if (scroller) {
          triggerY += scroller.scrollTop - startScrollTop;
        }
        const raw = computeTarget(triggerY);
        target = applyHysteresis(raw, triggerY);
        updateIndicator();
        applyReflow(target);
      };

      // Auto-scroll: when the cursor sits within EDGE_ZONE_PX of the
      // scroller's top or bottom, scroll the container in that
      // direction at a steady pixels-per-frame rate. The rAF tick
      // also calls processMove with the last cursor Y so the drop
      // target shifts as new rows scroll into view.
      const EDGE_ZONE_PX = 60;
      const SCROLL_SPEED_PX = 12;
      let autoScrollDir: -1 | 0 | 1 = 0;
      let autoScrollFrame: number | null = null;
      const tickAutoScroll = () => {
        if (!scroller || autoScrollDir === 0) {
          autoScrollFrame = null;
          return;
        }
        const before = scroller.scrollTop;
        scroller.scrollTop = before + autoScrollDir * SCROLL_SPEED_PX;
        if (scroller.scrollTop === before) {
          // Hit a scroll bound (top or bottom). Stop until the user
          // moves the cursor out of and back into the edge zone.
          autoScrollDir = 0;
          autoScrollFrame = null;
          return;
        }
        processMove(lastPointerY);
        autoScrollFrame = window.requestAnimationFrame(tickAutoScroll);
      };

      const onMove = (mv: PointerEvent) => {
        processMove(mv.clientY);
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          if (mv.clientY < rect.top + EDGE_ZONE_PX) autoScrollDir = -1;
          else if (mv.clientY > rect.bottom - EDGE_ZONE_PX) autoScrollDir = 1;
          else autoScrollDir = 0;
          if (autoScrollDir !== 0 && autoScrollFrame === null) {
            autoScrollFrame = window.requestAnimationFrame(tickAutoScroll);
          }
        }
      };

      const onUp = (): void => {
        activeDocument.removeEventListener("pointermove", onMove);
        activeDocument.removeEventListener("pointerup", onUp);
        if (preventScroll) {
          activeDocument.removeEventListener("touchmove", preventScroll);
        }
        autoScrollDir = 0;
        if (autoScrollFrame !== null) {
          cancelAnimationFrame(autoScrollFrame);
          autoScrollFrame = null;
        }
        // Suppress transitions so the cleanup snaps. Without this,
        // clearing the transform pushes and removing .is-dragging
        // would animate (transform 160ms, max-height 150ms) mid-
        // flight, then rerender wipes the DOM - visible as a flash.
        list.classList.add("butter-layout-drag-snap");
        ghost.remove();
        indicator.remove();
        clearHighlights();
        clearShifts();
        list.style.removeProperty("min-height");
        row.classList.remove("is-dragging");
        for (const child of sourceChildRows) {
          child.classList.remove("is-dragging");
        }

        // Force the snap-instant cleanup to commit before restoring
        // transitions. Same offsetHeight trick as the setup.
        void list.offsetHeight;
        list.classList.remove("butter-layout-drag-snap");

        if (!target) return;

        // Apply the move against rootLayout. Remove first, then
        // re-locate the ref point (indices may shift if removal
        // happens to be in the same parent).
        const removed = removeItem(rootLayout, draggedItemId);
        if (!removed) return;

        if (target.kind === "into") {
          const found = locate(rootLayout, target.submenuId);
          if (!found) return;
          const sub = found.parent[found.index];
          if (sub.type !== "submenu") return;
          sub.children.push(removed);
        } else {
          const ref = locate(rootLayout, target.refRowId);
          if (!ref) return;
          const insertAt =
            target.kind === "before" ? ref.index : ref.index + 1;
          ref.parent.splice(insertAt, 0, removed);
        }

        void onCommit();
      };

      activeDocument.addEventListener("pointermove", onMove);
      activeDocument.addEventListener("pointerup", onUp);
    };

    // Desktop / pen activation: immediate drag from the handle.
    // Touch is intentionally skipped here - the row's long-press
    // listener below handles all touch activation, including taps
    // that land on the handle. (On phones the handle is small and
    // accidental touches while scrolling are common; requiring a
    // long-press uniformly avoids that surprise.)
    handle.addEventListener("pointerdown", (downEv) => {
      if (downEv.pointerType === "touch") return;
      downEv.preventDefault();
      initDrag(downEv.clientY, downEv.pointerType);
    });

    // Mobile activation: long-press anywhere on the row except the
    // action buttons triggers the drag. Movement past a small
    // tolerance during the press cancels (so vertical scrolling
    // still works when the user is actually trying to scroll).
    const LONG_PRESS_MS = 400;
    const MOVE_TOLERANCE = 8;
    let longPressTimer: number | null = null;
    let pressStartY = 0;
    let pressStartX = 0;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    row.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch") return;
      const target = ev.target as HTMLElement;
      // Skip action buttons (add / remove / submenu controls) so
      // tapping those still fires their click handlers normally.
      if (target.closest(".butter-layout-row-actions")) return;
      pressStartY = ev.clientY;
      pressStartX = ev.clientX;
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        // Short haptic so the user knows drag mode engaged.
        try { navigator.vibrate?.(10); } catch { /* unsupported */ }
        initDrag(pressStartY, "touch");
      }, LONG_PRESS_MS);
    });
    row.addEventListener("pointermove", (ev) => {
      if (longPressTimer === null || ev.pointerType !== "touch") return;
      const dx = Math.abs(ev.clientX - pressStartX);
      const dy = Math.abs(ev.clientY - pressStartY);
      if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) cancelLongPress();
    });
    row.addEventListener("pointerup", cancelLongPress);
    row.addEventListener("pointercancel", cancelLongPress);
  }

  private renderOutlineSection(root: HTMLElement) {
    new Setting(root)
      .setName("Use Butter outline")
      .setDesc("Use Butter's outline sidebar instead of the core outline plugin. The core plugin is disabled while this is on and restored when off.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useButterOutline).onChange(async (v) => {
          this.plugin.settings.useButterOutline = v;
          await this.plugin.saveSettings();
          await this.plugin.applyOutlineMode();
        }),
      );
  }

  private renderDragSection(root: HTMLElement) {
    new Setting(root)
      .setName("Motion")
      .setDesc("Drag animation feel. Springy bounces; Snappy is direct; Smooth is steady.")
      .addDropdown((d) =>
        d
          .addOptions({
            springy: "Springy",
            snappy: "Snappy",
            smooth: "Smooth",
          })
          .setValue(this.plugin.settings.dragMotion)
          .onChange(async (v) => {
            this.plugin.settings.dragMotion = v as "springy" | "snappy" | "smooth";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Handle visibility")
      .setDesc("When the gutter drag handle appears. Hover: only on the pointed-at block. Always: stays on the nearest block.")
      .addDropdown((d) =>
        d
          .addOptions({
            hover: "On hover",
            always: "Always",
          })
          .setValue(this.plugin.settings.dragHandleVisibility)
          .onChange(async (v) => {
            this.plugin.settings.dragHandleVisibility = v as "hover" | "always";
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderSourceSection(root: HTMLElement) {
    const formSection = this.createSettingGroup(root, "Canonical form");

    new Setting(formSection)
      .setName("Bullet marker")
      .setDesc("Character used for unordered list items.")
      .addDropdown((d) =>
        d
          .addOptions({
            "-": "- hyphen (default)",
            "*": "* asterisk",
            "+": "+ plus",
          })
          .setValue(this.plugin.settings.canonicalBullet)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalBullet",
              v,
              "Bullet marker",
            ))) return;
            this.plugin.settings.canonicalBullet = v as "*" | "-" | "+";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Italic marker")
      .setDesc("Wrapper for emphasized text.")
      .addDropdown((d) =>
        d
          .addOptions({
            "*": "*text* (default)",
            _: "_text_",
          })
          .setValue(this.plugin.settings.canonicalItalic)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalItalic",
              v,
              "Italic marker",
            ))) return;
            this.plugin.settings.canonicalItalic = v as "*" | "_";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Bold marker")
      .setDesc("Wrapper for strong text.")
      .addDropdown((d) =>
        d
          .addOptions({
            "**": "**text** (default)",
            __: "__text__",
          })
          .setValue(this.plugin.settings.canonicalBold)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalBold",
              v,
              "Bold marker",
            ))) return;
            this.plugin.settings.canonicalBold = v as "**" | "__";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Code fence character")
      .setDesc("Triple-backtick is the convention; tildes are valid CommonMark too.")
      .addDropdown((d) =>
        d
          .addOptions({
            "```": "``` backtick (default)",
            "~~~": "~~~ tilde",
          })
          .setValue(this.plugin.settings.canonicalCodeFence)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalCodeFence",
              v,
              "Code fence character",
            ))) return;
            this.plugin.settings.canonicalCodeFence = v as "```" | "~~~";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Horizontal rule")
      .setDesc("Marker for thematic breaks (`<hr>`).")
      .addDropdown((d) =>
        d
          .addOptions({
            "---": "--- (default)",
            "***": "***",
            ___: "___",
          })
          .setValue(this.plugin.settings.canonicalHorizontalRule)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalHorizontalRule",
              v,
              "Horizontal rule",
            ))) return;
            this.plugin.settings.canonicalHorizontalRule = v as "---" | "***" | "___";
            await this.plugin.saveSettings();
          }),
      );

    const presSection = this.createSettingGroup(root, "Source preservation");

    const preserveSetting = new Setting(presSection)
      .setName("Preserve original source byte-for-byte")
      .setDesc(
        "Untouched blocks are written back verbatim from the file you opened: whitespace, marker style, indentation, and blank-line counts all preserved. Edited blocks are still re-serialized canonically.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.preserveOriginalSource)
          .onChange(async (v) => {
            if (!(await this.gateBundledToggle(
              t,
              "preserveOriginalSource",
              v,
              "Preserve original source byte-for-byte",
            ))) return;
            this.plugin.settings.preserveOriginalSource = v;
            await this.plugin.saveSettings();
          }),
      );
    preserveSetting.nameEl.createSpan({
      cls: "butter-preset-tag is-experimental",
      text: "Experimental",
    });

    const normSection = this.createSettingGroup(root, "Source normalizers");

    new Setting(normSection)
      .setName("Normalize heading gap to 1 blank line")
      .setDesc("Adds a blank line between a heading and the next block if they're touching. Existing gaps are left alone. Respects fenced code blocks.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.normalizeHeadingGap).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "normalizeHeadingGap",
            v,
            "Normalize heading gap to 1 blank line",
          ))) return;
          if (v && !this.plugin.settings.normalizeWarningAcknowledged) {
            const ok = await this.showWarning();
            if (!ok) {
              t.setValue(this.plugin.settings.normalizeHeadingGap);
              return;
            }
            this.plugin.settings.normalizeWarningAcknowledged = true;
          }
          this.plugin.settings.normalizeHeadingGap = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(normSection)
      .setName("Condense multiple blank lines")
      .setDesc("Cap runs of 2+ blank lines at 1 on save. Respects fenced code blocks.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.condenseBlankLines).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "condenseBlankLines",
            v,
            "Condense multiple blank lines",
          ))) return;
          if (v && !this.plugin.settings.normalizeWarningAcknowledged) {
            const ok = await this.showWarning();
            if (!ok) {
              t.setValue(this.plugin.settings.condenseBlankLines);
              return;
            }
            this.plugin.settings.normalizeWarningAcknowledged = true;
          }
          this.plugin.settings.condenseBlankLines = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(normSection)
      .setName("Close unclosed code fences")
      .setDesc("Append a closing fence when the file ends mid-fence. Prevents later edits from being swallowed when parsers extend the fence to end-of-file. Top-level fences only.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.closeUnclosedFences).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "closeUnclosedFences",
            v,
            "Close unclosed code fences",
          ))) return;
          if (v && !this.plugin.settings.normalizeWarningAcknowledged) {
            const ok = await this.showWarning();
            if (!ok) {
              t.setValue(this.plugin.settings.closeUnclosedFences);
              return;
            }
            this.plugin.settings.normalizeWarningAcknowledged = true;
          }
          this.plugin.settings.closeUnclosedFences = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(normSection)
      .setName("Auto-split full-width images into their own block")
      .setDesc("Move full-width inline images into their own paragraph. Sized embeds (with `|WIDTH`) stay inline.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.splitFullWidthImages).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "splitFullWidthImages",
            v,
            "Auto-split full-width images into their own block",
          ))) return;
          this.plugin.settings.splitFullWidthImages = v;
          await this.plugin.saveSettings();
        }),
      );

    // Discoverability: palette commands for one-shot cleanup that
    // apply regardless of the global toggles above.
    const commandNote = normSection.createDiv({ cls: "setting-item-description" });
    commandNote.createEl("div", {
      text:
        "Three palette commands clean files on demand. Tidy whitespace applies the normalizers above. Rewrite current note re-serializes with your canonical preferences. Rewrite entire vault does the same across all notes (commit to Git first).",
    });
  }

  /** Show a blocking warning modal. Resolves to true if the user
   *  confirms, false if they cancel. Used as the first-enable gate
   *  for normalization toggles so users don't accidentally rewrite
   *  their entire vault. */
  private showWarning(): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new NormalizeWarningModal(this.app, resolve);
      modal.open();
    });
  }

  /** Show the preset-drift confirm modal when a bundled setting
   *  changes would move the user out of an active preset. Resolves
   *  true on confirm (apply the change), false on cancel (revert). */
  private confirmPresetDrift(
    activePreset: SourcePurityMode,
    settingLabel: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      new PresetDriftConfirmModal(
        this.app,
        activePreset,
        settingLabel,
        resolve,
      ).open();
    });
  }

  /** Drift-check wrapper for a bundled-setting toggle. If changing
   *  `settingKey` to `newValue` would move the user out of an active
   *  preset, fires the drift confirm modal. Returns true if the
   *  caller should proceed with the change, false if it should
   *  revert the toggle (already reverted here). Use at the top of
   *  any bundled toggle's onChange before mutating settings. */
  private async gateBundledToggle(
    t: { setValue(v: boolean): void },
    settingKey: keyof ButterSettings,
    newValue: boolean,
    settingLabel: string,
  ): Promise<boolean> {
    const drift = wouldDriftFromActive(
      this.plugin,
      settingKey,
      newValue,
    );
    if (drift === null) return true;
    const ok = await this.confirmPresetDrift(drift, settingLabel);
    if (!ok) {
      t.setValue(this.plugin.settings[settingKey] as boolean);
      return false;
    }
    return true;
  }

  /** Drift-check wrapper for a bundled string-valued dropdown (e.g.
   *  canonical-glyph picks). Same flow as gateBundledToggle but
   *  reverts via setValue(string) so the dropdown returns to the
   *  current setting if the user cancels the drift modal. */
  private async gateBundledChoice(
    d: { setValue(v: string): void },
    settingKey: keyof ButterSettings,
    newValue: string,
    settingLabel: string,
  ): Promise<boolean> {
    const drift = wouldDriftFromActive(
      this.plugin,
      settingKey,
      newValue,
    );
    if (drift === null) return true;
    const ok = await this.confirmPresetDrift(drift, settingLabel);
    if (!ok) {
      d.setValue(this.plugin.settings[settingKey] as string);
      return false;
    }
    return true;
  }

  private renderDebugSection(root: HTMLElement) {
    new Setting(root)
      .setName("Verbose debug logging")
      .setDesc("Log internal events to the dev-tools console with a `[butter:...]` prefix. Filter by `butter:` in the console filter box.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLogging).onChange(async (v) => {
          this.plugin.settings.verboseLogging = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}

class NormalizeWarningModal extends Modal {
  private resolved = false;
  constructor(app: App, private resolve: (ok: boolean) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Enable source normalization?");
    contentEl.createEl("p", {
      text:
        "You're turning on a setting that automatically modifies file source on save. Files with non-matching formatting will get a one-time diff the next time they're saved.",
    });
    contentEl.createEl("p", {
      text:
        "This is an advanced feature. Most Butter users want the default (source is truth) so they can move freely between Butter, live preview, and source without their files being rewritten.",
    });
    contentEl.createEl("p", {
      text:
        "Continue only if you understand you're opting into automatic source changes.",
    });
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const okBtn = btnRow.createEl("button", {
      text: "I understand - enable",
      cls: "mod-cta",
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
    // If the user dismissed via Esc / clicking outside without
    // clicking a button, treat that as a cancel.
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}

/** Edit a submenu's icon + label. New submenus open with default
 *  values; existing ones populate from the current attrs. */
class SubmenuEditModal extends Modal {
  private current: Extract<ToolbarLayoutItem, { type: "submenu" }>;
  constructor(
    app: App,
    initial: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    private isNew: boolean,
    private onSave: (
      updated: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    ) => void | Promise<void>,
  ) {
    super(app);
    // Local copy so cancel discards any edits.
    this.current = JSON.parse(JSON.stringify(initial)) as Extract<
      ToolbarLayoutItem,
      { type: "submenu" }
    >;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.isNew ? "Add submenu" : "Edit submenu");

    const previewWrap = contentEl.createDiv({
      cls: "butter-submenu-edit-preview",
    });
    const previewIcon = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-icon",
    });
    setIcon(previewIcon, this.current.icon || "more-horizontal");
    const previewLabel = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-label",
      text: this.current.label || "Submenu",
    });

    new Setting(contentEl)
      .setName("Label")
      .setDesc("Shown as the submenu's tooltip.")
      .addText((t) => {
        t.setValue(this.current.label).onChange((v) => {
          this.current.label = v;
          previewLabel.setText(v || "Submenu");
        });
        t.inputEl.addClass("butter-submenu-label-input");
      });

    // Icon picker - search box on top, scrollable grid below.
    // Sourced from Obsidian's full icon registry via `getIconIds`,
    // so plugin-registered custom icons (including Butter's own
    // `butter-delete-row` etc.) show up alongside Lucide.
    const iconWrap = contentEl.createDiv({ cls: "butter-icon-picker" });
    iconWrap.createEl("div", {
      cls: "butter-icon-picker-label",
      text: "Icon",
    });
    const search = iconWrap.createEl("input", {
      cls: "butter-icon-picker-search",
      attr: { type: "text", placeholder: "Search icons…" },
    });
    const grid = iconWrap.createDiv({ cls: "butter-icon-picker-grid" });

    const allIds = getIconIds();
    // Strip "lucide-" prefix for display + matching since `setIcon`
    // accepts either form. Sort alphabetically. Filter out a small
    // set of non-iconic markers (Lucide ships some empty / debug
    // entries on certain Obsidian versions).
    const normalized = Array.from(
      new Set(allIds.map((id) => id.replace(/^lucide-/, ""))),
    )
      .filter((id) => id.length > 0)
      .sort();

    const renderGrid = (query: string) => {
      grid.empty();
      const q = query.trim().toLowerCase();
      const matches = q
        ? normalized.filter((id) => id.toLowerCase().includes(q))
        : normalized;
      // Cap rendered tiles for perf - the registry has ~1500 icons.
      const cap = 240;
      const shown = matches.slice(0, cap);
      for (const id of shown) {
        const tile = grid.createEl("button", {
          cls: "butter-icon-picker-tile",
          attr: { type: "button", "aria-label": id, "data-icon-id": id },
        });
        if (id === this.current.icon) tile.classList.add("is-selected");
        setIcon(tile, id);
        tile.addEventListener("click", (e) => {
          e.preventDefault();
          this.current.icon = id;
          previewIcon.empty();
          setIcon(previewIcon, id);
          // Refresh the grid's selection ring.
          grid
            .querySelectorAll(".butter-icon-picker-tile.is-selected")
            .forEach((el) => el.classList.remove("is-selected"));
          tile.classList.add("is-selected");
        });
      }
      if (matches.length > cap) {
        grid.createEl("div", {
          cls: "butter-icon-picker-overflow",
          text: `Showing first ${cap} of ${matches.length} matches - refine your search.`,
        });
      }
      if (matches.length === 0) {
        grid.createEl("div", {
          cls: "butter-icon-picker-empty",
          text: "No icons match.",
        });
      }
    };
    renderGrid("");
    search.addEventListener("input", () => renderGrid(search.value));

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const saveBtn = btnRow.createEl("button", {
      text: this.isNew ? "Add" : "Save",
      cls: "mod-cta",
    });
    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => {
      // Default icon if blank (avoid invisible submenu).
      if (!this.current.icon) this.current.icon = "more-horizontal";
      if (!this.current.label) this.current.label = "Submenu";
      void (async () => {
        await this.onSave(this.current);
        this.close();
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
/**
 * Per-device deactivation confirmation. Shown only for the "this
 * device" action since sibling-device deactivations are
 * non-destructive locally. The license key itself stays valid; the
 * user can re-add the device later by re-pasting the key.
 */
class DeactivateConfirmModal extends Modal {
  constructor(
    app: App,
    private onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Deactivate this device?" });
    contentEl.createEl("p", {
      text:
        "Removes the cached license from this Obsidian install. Your license key stays valid - paste it back on this or any other device any time to re-add it.",
    });
    contentEl.createEl("p", {
      text:
        "Butter editor will switch to read-only mode here until you re-add the device.",
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = btnRow.createEl("button", { text: "Cancel" });
    const ok = btnRow.createEl("button", {
      text: "Deactivate",
      cls: "mod-warning",
    });
    cancel.addEventListener("click", () => this.close());
    ok.addEventListener("click", () => {
      void (async () => {
        await this.onConfirm();
        this.close();
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
