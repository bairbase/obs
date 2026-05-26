/**
 * Welcome / onboarding modal - shown once on first install.
 *
 * Two pages:
 *   1. Brief "what is Butter" + the source-purity preset choice
 *      rendered as two clickable description cards.
 *   2. Confirmation + GitHub-README link + Get-to-work CTA.
 *
 * Esc / click-outside silently applies `strict` (the conservative
 * default) and marks onboarding complete. A modal that refuses to
 * dismiss feels hostile, and the user can re-open the walkthrough
 * from Settings → Getting Started.
 *
 * Markup notes:
 *   • Cards are <div role="button"> not <button>. Obsidian's modal
 *     CSS scopes a lot of rules to <button> elements (filled accent
 *     background, fixed height, centered text), and overriding them
 *     all is more fragile than just not using a <button> for the
 *     card-shaped click target.
 *   • Page 2's primary actions live in `.modal-button-container` so
 *     they pick up Obsidian's native button chrome (CTA accent etc.)
 *     without us re-implementing it.
 */
import { App, Modal, Setting } from "obsidian";
import type ButterEditorPlugin from "../main";
import { TRIAL_LENGTH_DAYS } from "../integration/license/policy";

export const BUTTER_GITHUB_README =
  "https://github.com/spreadwell/butter-editor#readme";

/** Settings-preset identifier. Each preset bundles multiple settings
 *  so users pick a single high-level option rather than juggling
 *  individual toggles. "preservation" is experimental and only
 *  surfaces in the Settings tab (not the first-launch welcome). */
export type SourcePurityMode = "strict" | "rich" | "preservation";

export class WelcomeModal extends Modal {
  private page: 1 | 2 = 1;
  private picked: SourcePurityMode | null = null;
  /** Set true only when the user committed via Get-to-work. Esc /
   *  background-click on either page falls through to the silent
   *  default (strict + onboarding complete). */
  private finished = false;

  constructor(app: App, private plugin: ButterEditorPlugin) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("butter-welcome-modal");
    this.render();
  }

  onClose() {
    if (!this.finished) {
      void this.applyAndPersist(this.picked ?? "strict");
    }
    this.contentEl.empty();
  }

  private render() {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    if (this.page === 1) this.renderPage1(contentEl, titleEl);
    else this.renderPage2(contentEl, titleEl);
  }

  // ── Page 1 ─────────────────────────────────────────────────
  private renderPage1(contentEl: HTMLElement, titleEl: HTMLElement) {
    titleEl.setText("Welcome to Butter");

    const intro = contentEl.createDiv({ cls: "butter-welcome-intro" });
    intro.createEl("p", {
      text:
        "Edit your notes the way they look in reading mode. Bold is bold, headings are big, lists have bullets. No syntax noise while you write.",
    });
    intro.createEl("p", {
      text:
        "Butter editor keeps your files clean and readable so they work with any Markdown app.",
    });
    intro.createEl("p", {
      text:
        "One question shapes how Butter behaves. Pick whichever option fits how you think about your notes. You can change it later in settings.",
    });

    contentEl.createEl("h3", {
      cls: "butter-welcome-section-heading",
      text: "How should Butter treat your source?",
    });

    const choices = contentEl.createDiv({ cls: "butter-welcome-choices" });

    this.renderChoiceCard(choices, {
      mode: "strict",
      title: "Plain markdown",
      tagline: "Default",
      bestFor: "Best for simple notes that work everywhere.",
      desc:
        "Maximum cross-app compatibility. Font color, inline styles, and other HTML extras stay off so your files read cleanly anywhere and version-control diffs stay tidy.",
    });

    this.renderChoiceCard(choices, {
      mode: "rich",
      title: "Rich formatting",
      bestFor: "Best for colorful, freely styled notes.",
      desc:
        "If you just want to color and style your notes how you want without worrying about markdown source then use this preset. This mixes some HTML into your note under the hood; invisible to you but some don't prefer that.",
    });

    const footnote = contentEl.createDiv({ cls: "butter-welcome-footnote" });
    footnote.setText(
      "Click a card to continue. Press esc to dismiss with plain Markdown as the default.",
    );
  }

  private renderChoiceCard(
    parent: HTMLElement,
    spec: {
      mode: SourcePurityMode;
      title: string;
      tagline?: string;
      bestFor?: string;
      desc: string;
    },
  ) {
    const card = parent.createDiv({
      cls: "butter-welcome-card",
      attr: {
        role: "button",
        tabindex: "0",
        "data-mode": spec.mode,
      },
    });

    const titleRow = card.createDiv({ cls: "butter-welcome-card-title-row" });
    titleRow.createDiv({
      cls: "butter-welcome-card-title",
      text: spec.title,
    });
    if (spec.tagline) {
      titleRow.createDiv({
        cls: "butter-welcome-card-tagline",
        text: spec.tagline,
      });
    }
    // Reuse the settings-tab's `.butter-preset-best-for` class on the
    // lead sentence so both surfaces share the same accent treatment.
    const descEl = card.createDiv({ cls: "butter-welcome-card-desc" });
    if (spec.bestFor) {
      descEl.createSpan({
        cls: "butter-preset-best-for",
        text: spec.bestFor,
      });
      descEl.appendText(" " + spec.desc);
    } else {
      descEl.setText(spec.desc);
    }

    const choose = () => {
      this.picked = spec.mode;
      this.page = 2;
      this.render();
    };
    card.addEventListener("click", choose);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        choose();
      }
    });
  }

  // ── Page 2 ─────────────────────────────────────────────────
  private renderPage2(contentEl: HTMLElement, titleEl: HTMLElement) {
    titleEl.setText("You're set");

    const chosenLabel =
      this.picked === "rich"
        ? "Rich formatting"
        : this.picked === "preservation"
          ? "Source preservation"
          : "Plain markdown";

    const intro = contentEl.createDiv({ cls: "butter-welcome-intro" });
    intro.createEl("p", {
      text: `You chose ${chosenLabel}. Butter will respect that across every note you open.`,
    });
    intro.createEl("p", {
      text:
        "You can revisit this choice - along with Butter's other settings - anytime under settings → Butter editor → general.",
    });

    // License / trial offer. Only shown when the user doesn't already
    // have a valid license or active trial - skipping the section for
    // returning customers who reopened the walkthrough on purpose.
    // Built with Obsidian's native `Setting()` rows so the chrome
    // matches the rest of the plugin's settings surface.
    const status = this.plugin.licenseStatus;
    const hasLicense = status === "valid" || status === "trial";
    if (!hasLicense) {
      const bounceToLicense = async () => {
        // Persist the preset before bouncing to settings so flipping
        // tabs doesn't strand an unsaved choice.
        this.finished = true;
        await this.applyAndPersist(this.picked ?? "strict");
        this.close();
        this.plugin.openSettings("license");
      };
      new Setting(contentEl)
        .setName("Start a free trial")
        .setDesc(
          `${TRIAL_LENGTH_DAYS} days, full access. No card, no email. Butter stays installed but read-only after the trial until you activate a license.`,
        )
        .addButton((b) =>
          b
            .setButtonText("Start free trial")
            .setCta()
            .onClick(() => {
              void bounceToLicense();
            }),
        );
      new Setting(contentEl)
        .setName("Already have a license?")
        .setDesc("Paste your key in settings → license.")
        .addButton((b) =>
          b
            .setButtonText("Enter license")
            .onClick(() => {
              void bounceToLicense();
            }),
        );
    }

    const btnRow = contentEl.createDiv({
      cls: "modal-button-container butter-welcome-button-row",
    });

    const learnBtn = btnRow.createEl("button", {
      text: "Learn more on GitHub",
      attr: { type: "button" },
    });
    learnBtn.addEventListener("click", () => {
      window.open(BUTTER_GITHUB_README, "_blank");
    });

    const goBtn = btnRow.createEl("button", {
      text: "Start writing",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    goBtn.addEventListener("click", () => {
      this.finished = true;
      void (async () => {
        await this.applyAndPersist(this.picked ?? "strict");
        this.close();
      })();
    });

    const back = contentEl.createDiv({ cls: "butter-welcome-back-row" });
    const backBtn = back.createEl("button", {
      cls: "butter-welcome-back",
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- arrow is decoration; "Back" remains the first content word.
      text: "← Back",
      attr: { type: "button" },
    });
    backBtn.addEventListener("click", () => {
      this.page = 1;
      this.render();
    });
  }

  private async applyAndPersist(mode: SourcePurityMode) {
    applySourcePurityPreset(this.plugin, mode);
    this.plugin.settings.hasCompletedOnboarding = true;
    await this.plugin.saveSettings();
  }
}

// ═══════════════════════════════════════════════════════════════
//  Preset helpers - shared by the welcome modal + the Getting
//  Started settings tab. Today the preset only flips one setting
//  (`sourcePurity`); the helper exists so future bundled settings
//  (preferHtmlOutput, etc.) can be added in one place and the
//  confirmation modal automatically lists them.
// ═══════════════════════════════════════════════════════════════

export type PresetChange = {
  label: string;
  from: string;
  to: string;
};

/** Bundled settings each preset enforces. Keyed by mode -> map of
 *  setting field -> expected value. Source of truth for both
 *  "is this preset currently active" (match-based) and "would
 *  changing this setting drift the user out of the active preset"
 *  detection. Extend the inner record as new settings get bundled.
 *
 *  Plain + Rich keep all four source normalizers on (canonical output
 *  is the point), and Preservation flips them off (the point of
 *  preservation is to not rewrite the file). closeUnclosedFences is
 *  bundled too even though it's a safety feature, because turning it
 *  off mid-preset would silently drift the user away from preservation
 *  semantics in one direction or canonical semantics in the other. */
export const PRESET_BUNDLES: Record<
  SourcePurityMode,
  Readonly<Record<string, unknown>>
> = {
  strict: {
    sourcePurity: "strict",
    preserveOriginalSource: false,
    normalizeHeadingGap: true,
    condenseBlankLines: true,
    closeUnclosedFences: true,
    splitFullWidthImages: true,
    // Plain-markdown stance: never AUTHOR inline HTML. Parser still
    // recognises HTML in source so existing notes round-trip; this
    // setting is the toolbar gate. Hides the HTML-only buttons (Text
    // color + the highlight-color chevron behaviour) so users on
    // this preset don't accidentally insert HTML.
    enableHtmlFormatting: false,
    canonicalBullet: "-",
    canonicalItalic: "*",
    canonicalBold: "**",
    canonicalCodeFence: "```",
    canonicalHorizontalRule: "---",
  },
  rich: {
    sourcePurity: "rich",
    preserveOriginalSource: false,
    normalizeHeadingGap: true,
    condenseBlankLines: true,
    closeUnclosedFences: true,
    splitFullWidthImages: true,
    // Rich preset = canonical markdown PLUS the HTML-only marks
    // Obsidian doesn't have shorthand for (text colour, custom
    // highlight colour, underline, sup/sub, kbd).
    enableHtmlFormatting: true,
    canonicalBullet: "-",
    canonicalItalic: "*",
    canonicalBold: "**",
    canonicalCodeFence: "```",
    canonicalHorizontalRule: "---",
  },
  // Preservation deliberately omits canonical form: a user who cares
  // about exact source bytes may legitimately want non-default glyph
  // preferences for edited blocks. Bundling them would force a reset
  // on every preset apply. They stay user-prefs in this mode.
  preservation: {
    sourcePurity: "preservation",
    preserveOriginalSource: true,
    normalizeHeadingGap: false,
    condenseBlankLines: false,
    closeUnclosedFences: false,
    splitFullWidthImages: false,
  },
};

/** Display label for each bundled setting. Used by the preset-apply
 *  confirm modal and the drift-warning modal so settings get a
 *  consistent human-readable name across both surfaces. Extend in
 *  lockstep with PRESET_BUNDLES. */
export const BUNDLED_SETTING_LABELS: Record<string, string> = {
  sourcePurity: "Formatting style",
  preserveOriginalSource: "Byte-for-byte preservation",
  normalizeHeadingGap: "Normalize heading gap",
  condenseBlankLines: "Condense blank lines",
  closeUnclosedFences: "Close unclosed code fences",
  splitFullWidthImages: "Split full-width images",
  enableHtmlFormatting: "HTML formatting toolbar buttons",
  canonicalBullet: "Bullet marker",
  canonicalItalic: "Italic marker",
  canonicalBold: "Bold marker",
  canonicalCodeFence: "Code fence character",
  canonicalHorizontalRule: "Horizontal rule",
};

/** Human-readable label for a preset. Single source of truth so
 *  every surface (cards, modals, drift warnings) spells the name
 *  the same way. */
export function labelOfPreset(mode: SourcePurityMode): string {
  return mode === "rich"
    ? "Rich formatting"
    : mode === "preservation"
      ? "Source preservation"
      : "Plain markdown";
}

/** Returns the preset mode whose bundle currently matches the
 *  plugin's settings, or null when the settings have drifted away
 *  from every preset (the Custom state). */
export function matchActivePreset(
  plugin: ButterEditorPlugin,
): SourcePurityMode | null {
  for (const mode of ["strict", "rich", "preservation"] as const) {
    const bundle = PRESET_BUNDLES[mode];
    let matches = true;
    for (const [key, val] of Object.entries(bundle)) {
      if ((plugin.settings as unknown as Record<string, unknown>)[key] !== val) {
        matches = false;
        break;
      }
    }
    if (matches) return mode;
  }
  return null;
}

/** True if `settingKey` is part of any preset's bundle. Settings
 *  outside every bundle never trigger a drift warning. */
export function isBundledSetting(settingKey: string): boolean {
  return Object.values(PRESET_BUNDLES).some((bundle) => settingKey in bundle);
}

/** If changing `settingKey` to `newValue` would move the plugin
 *  out of its currently-active preset, returns that active preset.
 *  Returns null when the change is safe (already Custom, the new
 *  value still matches the active bundle, or `settingKey` is not
 *  part of any bundle). Drives the drift-warning modal. */
export function wouldDriftFromActive(
  plugin: ButterEditorPlugin,
  settingKey: string,
  newValue: unknown,
): SourcePurityMode | null {
  const active = matchActivePreset(plugin);
  if (active === null) return null;
  const bundle = PRESET_BUNDLES[active];
  if (!(settingKey in bundle)) return null;
  if (bundle[settingKey] === newValue) return null;
  return active;
}

/** What applying `mode` would change, given the plugin's current
 *  settings. Used by the confirmation modal so users see exactly
 *  what they're agreeing to. Returns an empty array when the preset
 *  is already active - the modal can then short-circuit. */
export function getSourcePurityPresetChanges(
  plugin: ButterEditorPlugin,
  mode: SourcePurityMode,
): PresetChange[] {
  const changes: PresetChange[] = [];
  const bundle = PRESET_BUNDLES[mode];
  const settings = plugin.settings as unknown as Record<string, unknown>;
  for (const [key, target] of Object.entries(bundle)) {
    const current = settings[key];
    if (current === target) continue;
    const label = BUNDLED_SETTING_LABELS[key] ?? key;
    // sourcePurity holds a mode string; everything else bundled today
    // is boolean. Render each shape with its natural human form.
    if (key === "sourcePurity") {
      changes.push({
        label,
        from: labelOfPreset(current as SourcePurityMode),
        to: labelOfPreset(target as SourcePurityMode),
      });
    } else if (typeof target === "boolean") {
      changes.push({
        label,
        from: current ? "On" : "Off",
        to: target ? "On" : "Off",
      });
    } else {
      // String-valued settings (canonical glyph choices, etc.).
      // Display the raw value - "-", "*", "**", "```", etc. are
      // themselves the natural label.
      changes.push({
        label,
        from: String(current),
        to: String(target),
      });
    }
  }
  return changes;
}

/** Mutate `plugin.settings` to match the named preset. Caller is
 *  responsible for `saveSettings()` so multiple settings can be
 *  flipped (e.g. `hasCompletedOnboarding` in the welcome flow)
 *  without redundant disk writes. */
export function applySourcePurityPreset(
  plugin: ButterEditorPlugin,
  mode: SourcePurityMode,
) {
  const bundle = PRESET_BUNDLES[mode];
  const settings = plugin.settings as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(bundle)) {
    settings[key] = value;
  }
  // Rebuild the toolbar so any preset-driven visibility change
  // (currently `enableHtmlFormatting`) takes effect immediately
  // without requiring the user to also toggle the setting manually.
  plugin.applyToolbarButtonVisibilityToAllViews();
}

/** Confirmation modal opened from the Getting Started settings tab
 *  when the user clicks `Apply` on a preset. Lists the concrete
 *  settings changes so applying the preset never feels like a
 *  black box. Cancel / Apply pattern matches `NormalizeWarningModal`. */
export class SourcePurityConfirmModal extends Modal {
  constructor(
    app: App,
    private plugin: ButterEditorPlugin,
    private mode: SourcePurityMode,
    private onApplied: () => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    const label =
      this.mode === "rich"
        ? "Rich formatting"
        : this.mode === "preservation"
          ? "Source preservation"
          : "Plain markdown";
    titleEl.setText(`Apply ${label} preset?`);

    const changes = getSourcePurityPresetChanges(this.plugin, this.mode);

    if (changes.length === 0) {
      contentEl.createEl("p", {
        text: `${label} is already active. No changes will be applied.`,
      });
    } else {
      contentEl.createEl("p", {
        text: "This will update the following settings:",
      });
      const list = contentEl.createEl("ul", { cls: "butter-preset-changes" });
      for (const c of changes) {
        const li = list.createEl("li");
        li.appendText(`${c.label}: ${c.from} → `);
        li.createEl("strong", { text: c.to });
      }
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "You can change individual settings at any time. Presets are a fast path; they don't lock anything in.",
      });
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = btnRow.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());

    if (changes.length > 0) {
      const apply = btnRow.createEl("button", {
        text: "Apply preset",
        cls: "mod-cta",
        attr: { type: "button" },
      });
      apply.addEventListener("click", () => {
        applySourcePurityPreset(this.plugin, this.mode);
        void (async () => {
          await this.plugin.saveSettings();
          this.close();
          this.onApplied();
        })();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Modal shown when toggling a bundled setting would move the user
 *  out of their currently-active preset. Lets them opt into the
 *  drift consciously instead of silently moving them to Custom.
 *  Resolves true on confirm, false on cancel / dismiss. */
export class PresetDriftConfirmModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private activePreset: SourcePurityMode,
    private settingLabel: string,
    private resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Move out of preset?");
    contentEl.createEl("p", {
      text: `"${this.settingLabel}" is part of the ${labelOfPreset(this.activePreset)} preset. Changing it will move your Settings Presets state to Custom.`,
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "You can apply any preset later to return to a known baseline. This is just a heads-up so the change doesn't surprise you.",
    });

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = btnRow.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(false);
      this.close();
    });
    const ok = btnRow.createEl("button", {
      text: "Continue",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    ok.addEventListener("click", () => {
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
