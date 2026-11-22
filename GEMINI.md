# MultiPlayer — Project Instructions

## Mandatory Windows <-> Android Cross-Platform Parity Rule

Every bug report, UI change, or fix applied to the Windows desktop version (`MultiPlayer` / `Audiobook Player.exe` / Tauri) **MUST** automatically be audited and verified on the Android version — and vice versa — before completion:

- **Windows targets**: Tauri desktop (`https://tauri.localhost`), Desktop 3-column viewport (`>= 768px`), Windows `.exe`.
- **Android targets**: Android Mobile layout (`< 768px`), Android WebView / Capacitor `.apk` (`https://localhost` / `capacitor://localhost`), Android Chrome PWA (`https://larxe1.github.io/Audiobook-Player/`), Notification Shade, Wear OS (`<= 340px` / `?watch=1`), and Android Auto (`?androidAuto=1`, `android-auto/`).

Never ship a Windows-only or Android-only fix without auditing auth redirects, OAuth popups, WebView constraints, local file pickers (`webkitdirectory` vs `accept="audio/*" multiple`), responsive layout, hardware back navigation, and OTA/update behavior across both platforms.

## Mandatory Design, UX & Fluid Motion Craft Rule (`.agents/skills/ui-motion-craft/SKILL.md`)

1. **True Black Default & Zero-Blink Fluid Transitions:**
   - **True Black (`theme-amoled`, `#000000`)** is the sole default theme across HTML, CSS, Tauri, and Android system bars (legacy `'pitch'` and `'midnight'` preferences are removed and auto-migrated to `'amoled'`).
   - Primary view changes (`Home <-> Detail`, `Audiobooks <-> Podcasts`), modal/sheet/popover/context-menu open **and close** (`[data-closing]` exit transition + `@starting-style` entry), and staggered reveals (`.ui-stagger-item`) use exponential ease-out (`cubic-bezier(0.16, 1, 0.3, 1)` / `var(--ease-spring)`).
   - **Zero-blink same-view updates**: Never re-run `.ui-view-enter` / `.ui-stagger-grid` or `startViewTransition` on same-view book selection, play/pause, or series folder toggles, and update search results in-place without recreating focused `<input>` elements.
   - Handle `@media (prefers-reduced-motion: reduce)` case-by-case (`translate: none`) without global `0.01ms !important` overrides.
2. **Uncluttered Navigation, Progressive Disclosure & Context Menus:**
   - Keep the library filter cleanly divided between **`Audiobooks`** and **`Podcasts`**, with series grouping always active and series folders collapsed by default.
   - Never clutter library rows/cards with cloud/folder icons (show **only** a green checkmark when saved offline), never place standalone `Devices` or `Wipe` buttons in headers/transport bars, and tuck rarely used actions (`Add Local Folder`, `Add Audio Files`, `Sync Google Drive`, `Search Cover Images`, `Auto-Match Tags`, `Wipe Synced Files`) inside **`Settings > Advanced Settings`**.
   - Provide a unified **`🔍` Search** modal (`All` / `Audiobooks` / `Podcasts to Follow`), dual-input context menus (PC right-click + Android long-press), compact persistent-dismiss `Continue Listening` pill, and non-destructive Back button / `X` close controls.

## Mandatory Dual-Platform Subagent Parity Gate

Unless a task is explicitly requested for one platform only, every implementation round **MUST** be audited in parallel by two separate platform verifiers before building or pushing a release:
- **`android-parity-verifier`** (`.agents/agents/android-parity-verifier.md`, or `auditor-android` in `/swarm`): read-only audit scoped strictly to Android-specific surfaces (`android-auto/`, `.github/workflows/release.yml`, `< 768px` mobile layout, Capacitor/WebView/OTA constraints, Chrome PWA, Notification Shade, Wear OS, Android Auto) without re-running full test suites or duplicating shared business-logic review.
- **`windows-parity-verifier`** (`.agents/agents/windows-parity-verifier.md`, or `auditor-windows` in `/swarm`): read-only audit scoped strictly to Windows-specific surfaces (`src-tauri/`, `scripts/prepare-tauri-ui.mjs`, `>= 768px` desktop layout, Windows `.exe` CI) without re-running full test suites or duplicating shared business-logic review.

## 5-Step Release Parity Checklist

1. **Dual-Platform Subagent Audit**: Run `android-parity-verifier` and `windows-parity-verifier` in parallel (strictly read-only platform-surface checks, handing off to `neon-reviewer` for shared logic diff review before `verifier` runs the single authoritative test suite).
2. **Version Bump**: Bump `version.json` (`version` and `build`, keeping `minNativeBuild` unchanged unless a breaking native bridge change requires a new APK), `LOCAL_VERSION` / `LOCAL_BUILD` in `src/services/self-updater.js`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
3. **Prepare & Build Windows `.exe`**: Run `node scripts/prepare-tauri-ui.mjs` and `cargo build --release --manifest-path src-tauri/Cargo.toml`.
4. **Update Local & Desktop `.exe`**: Stop any running `Audiobook Player` / `MultiPlayer` process, copy the release `.exe` to both `d:\Code\Audiobook\` and `C:\Users\ecmat\OneDrive\Desktop\`, and verify identical SHA256 hashes (`Get-FileHash`).
5. **Verify, Shield, Push & Confirm CI**: Run all unit tests (`node --test`), run `git-secret-shield`, commit, and `git push origin main` so Android OTA / GitHub Actions `.apk` receives the exact fix too. Whenever `.github/workflows/*` or `android-auto/*` changes, check/report the triggered GitHub Actions run status/URL after pushing so broken APK builds never go unnoticed.
