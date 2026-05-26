import esbuild from "esbuild";
import { builtinModules as builtins } from "module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";
// `once` mode: build once in DEV flavor (so the .dev-build counter
// increments, the vault manifest gets the `X.Y.Z-N` tag, and phone
// push fires), then exit instead of starting the watcher. Lets the
// agent iterate with the same reload-verification fingerprint that
// long-running `npm run dev` produces.
const onceMode = process.argv[2] === "once";
// Derive the plugin ID from manifest.json so the auto-copy path
// stays correct after a rename (no hardcoded plugin folder name).
const PLUGIN_ID = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
).id;
const vaultPluginDir = resolve(
  __dirname,
  `../Butter-Test-Vault/.obsidian/plugins/${PLUGIN_ID}`,
);

if (!existsSync(vaultPluginDir)) mkdirSync(vaultPluginDir, { recursive: true });

/**
 * Increment the local dev-build counter and return the new number.
 * The counter lives in `.dev-build` (gitignored) so it travels with
 * the SSD but never lands in commits. Used as a tiny reload-verification
 * tag in the boot Notice — "Butter Editor v0.9.1 (dev #128)". If the
 * number doesn't increment after a rebuild, you know the new bundle
 * didn't load on the device.
 *
 * Manifest version is NOT touched here — it stays pinned at the last
 * released version between releases, so release-time has no "un-bump"
 * step.
 */
function bumpDevBuild() {
  const buildFile = resolve(__dirname, ".dev-build");
  let n = 0;
  if (existsSync(buildFile)) {
    n = parseInt(readFileSync(buildFile, "utf8"), 10) || 0;
  }
  n += 1;
  writeFileSync(buildFile, String(n) + "\n");
  return n;
}

// Both mutable — re-evaluated on every build so a `npm run bump`
// during a running watcher picks up the new version, and DEV_BUILD
// increments per push so the boot-Notice version is a unique
// fingerprint ("did the new bundle actually load?").
let DEV_BUILD = 0;
let SOURCE_MANIFEST = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
);

const bumpCounter = {
  name: "bump-counter",
  setup(build) {
    // onStart fires at the beginning of EVERY build — initial and
    // each watch-mode rebuild. Re-reads manifest.json so a mid-watch
    // `npm run bump` shows up immediately. Bumps the counter so each
    // rebuild stamps a unique number.
    build.onStart(() => {
      if (prod) return;
      SOURCE_MANIFEST = JSON.parse(
        readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
      );
      DEV_BUILD = bumpDevBuild();
      console.log(`→ dev build ${SOURCE_MANIFEST.version}-${DEV_BUILD}`);
    });
  },
};

const copyToVault = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      copyFileSync(resolve(__dirname, "main.js"), resolve(vaultPluginDir, "main.js"));

      // Dev: write a modified manifest into the vault so Obsidian
      // displays "Butter Editor (DEV)" at version `X.Y.Z-N` — visibly
      // distinct from any BRAT-installed copy. Source manifest.json
      // on disk stays clean at the release version.
      // Prod: straight copy.
      const destManifest = resolve(vaultPluginDir, "manifest.json");
      if (prod) {
        copyFileSync(resolve(__dirname, "manifest.json"), destManifest);
      } else {
        // Compute dev version FRESH each rebuild — DEV_BUILD has just
        // been bumped by the bumpCounter plugin's onStart hook.
        const vaultManifest = {
          ...SOURCE_MANIFEST,
          name: `${SOURCE_MANIFEST.name} (DEV)`,
          version: `${SOURCE_MANIFEST.version}-${DEV_BUILD}`,
        };
        writeFileSync(destManifest, JSON.stringify(vaultManifest, null, 2) + "\n");
      }

      if (existsSync(resolve(__dirname, "styles.css"))) {
        copyFileSync(resolve(__dirname, "styles.css"), resolve(vaultPluginDir, "styles.css"));
      }
      console.log(`→ copied to ${vaultPluginDir}`);
    });
  },
};

/**
 * Push the build to the user's MTP-connected Android phone (e.g.
 * Samsung S23). Skips silently when the phone isn't plugged in or
 * no local config file is present — designed to be a non-blocking
 * convenience, never a build failure.
 *
 * Configuration lives on disk in `phone-push.local.mjs` (gitignored)
 * rather than environment variables, so the portable SSD setup
 * carries the config across machines without writing to host-machine
 * state (HKCU/Environment, profile dotfiles, etc.). The file
 * exports a default object: `{ device, vaultPath?, pluginId? }`.
 * If the file is missing or `device` is empty, the push step is
 * skipped — no error, build continues.
 *
 * The actual MTP traversal lives in `scripts/push-to-phone.ps1`
 * because Node's fs APIs can't see MTP namespaces — Shell.Application
 * COM is the only way to reach a vault's `.obsidian/plugins/` folder
 * on a phone connected via Phone Link / Cross Device.
 */
async function loadPhonePushConfig() {
  const configPath = resolve(__dirname, "phone-push.local.mjs");
  if (!existsSync(configPath)) return null;
  try {
    // Dynamic import so a missing/broken config never breaks the
    // build pipeline at module-load time. URL form so Windows
    // backslash paths resolve correctly through the ESM loader.
    const mod = await import(`file://${configPath.replace(/\\/g, "/")}`);
    const cfg = mod.default ?? mod;
    if (!cfg || typeof cfg.adbExe !== "string" || cfg.adbExe.trim() === "") {
      return null;
    }
    return {
      adbExe: cfg.adbExe,
      vaultPath: cfg.vaultPath || "/sdcard/Documents/butter-mobile-test-vault",
      pluginId: cfg.pluginId || PLUGIN_ID,
    };
  } catch (err) {
    console.warn(`phone-push: skipping (failed to load config: ${err.message})`);
    return null;
  }
}

const pushToPhone = {
  name: "push-to-phone",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      // Phone push fires ONLY in dev mode. The phone's test vault
      // is the DEV stream — it should always show `X.Y.Z-N` labeled
      // builds. The release vault on phone is BRAT-managed and
      // updates only when a real GitHub Release exists, so it must
      // not be reached from a local `npm run build`. Skipping the
      // push in prod keeps the streams from cross-contaminating.
      if (prod) return;
      const cfg = await loadPhonePushConfig();
      if (!cfg) return; // no config file, no push
      const script = resolve(__dirname, "scripts", "push-to-phone.ps1");
      // -NoProfile so the user's PowerShell profile doesn't run on
      // every build (slow + irrelevant). -ExecutionPolicy Bypass so
      // a locked-down corporate policy doesn't refuse to run our
      // script. The push-to-phone.ps1 always exits 0 on
      // skip/success and only nonzero on real script errors.
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy", "Bypass",
          "-File", script,
          "-AdbExe", cfg.adbExe,
          "-VaultPath", cfg.vaultPath,
          "-PluginId", cfg.pluginId,
          // Push from the test vault's plugin dir, NOT the source
          // root — the vault dir contains the DEV-transformed manifest
          // (name="Butter Editor (DEV)" + version="X.Y.Z-N") written
          // by the copyToVault plugin above. Pushing source manifest
          // would land the phone with the release-flavored manifest.
          "-SourceDir", vaultPluginDir,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      ps.on("error", (err) => {
        console.warn(`phone-push: failed to spawn powershell: ${err.message}`);
      });
      // We don't await this — push runs in parallel with whatever
      // the build script does next (in production builds esbuild
      // exits right after, so the phone push finishes naturally
      // before the process is reaped).
    });
  },
};

const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Build-time constant — true in `npm run dev`, false in `npm run build`.
  // esbuild's dead-code elimination removes any `if (__BUTTER_DEV__) { … }`
  // block from production bundles. Used to gate dev-only UI like the
  // license-state test buttons in the settings tab.
  define: {
    __BUTTER_DEV__: prod ? "false" : "true",
  },
  external: [
    "obsidian",
    "electron",
    // CRITICAL: CM6 / Lezer packages must come from Obsidian's runtime,
    // not be bundled. Bundling creates a second copy whose classes fail
    // the instanceof checks Obsidian-registered extensions use — the
    // CM6 bridge would reject every external extension otherwise.
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/commands",
    "@codemirror/search",
    "@codemirror/autocomplete",
    "@codemirror/lint",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "@lezer/markdown",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  // Production: minify + strip dead code (turns `if (false) { … }` into
  // nothing, removing dev-gated branches entirely from the bundle).
  // Also reduces download size and makes the closed-source bundle
  // harder to read. Dev keeps readable output for stack traces.
  minify: prod,
  treeShaking: true,
  platform: "browser",
  logLevel: "info",
  // Order matters: bumpCounter must run first so DEV_BUILD is set
  // before copyToVault writes the vault manifest. pushToPhone runs
  // last and reads from the vault dir, picking up the fresh manifest.
  plugins: [bumpCounter, copyToVault, pushToPhone],
};

if (prod || onceMode) {
  await esbuild.build(config);
} else {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log("watching...");

  // esbuild's watch only follows imports from src/main.ts. styles.css
  // and manifest.json aren't in that graph but are shipped to the
  // vault — without explicit watchers, edits to them don't trigger a
  // rebuild, the dev-build counter doesn't increment, and the change
  // never lands on the device. Watch those files manually and call
  // ctx.rebuild() on any change.
  const assetWatchPaths = [
    resolve(__dirname, "styles.css"),
    resolve(__dirname, "manifest.json"),
  ];
  for (const p of assetWatchPaths) {
    if (!existsSync(p)) continue;
    let pending = false;
    watch(p, () => {
      // Debounce — `fs.watch` fires twice on many editors (write +
      // rename-temp). Coalesce to a single rebuild.
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        ctx.rebuild().catch(() => {});
      }, 50);
    });
  }
}
