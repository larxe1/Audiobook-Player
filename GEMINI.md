# Audiobook Player — Project Instructions

## Mandatory Windows <-> Android Cross-Platform Parity Rule

Every bug report, UI change, or fix applied to the Windows desktop version (`Audiobook Player.exe` / Tauri) **MUST** automatically be audited and verified on the Android version — and vice versa — before completion:

- **Windows targets**: Tauri desktop (`https://tauri.localhost`), Desktop 3-column viewport (`>= 768px`), Windows `.exe`.
- **Android targets**: Android Mobile layout (`< 768px`), Android WebView / Capacitor `.apk` (`https://localhost` / `capacitor://localhost`), Android Chrome PWA (`https://larxe1.github.io/Audiobook-Player/`), Notification Shade, Wear OS (`<= 340px` / `?watch=1`), and Android Auto (`?androidAuto=1`, `android-auto/`).

Never ship a Windows-only or Android-only fix without auditing auth redirects, OAuth popups, WebView constraints, local file pickers (`webkitdirectory` vs `accept="audio/*" multiple`), responsive layout, and OTA/update behavior across both platforms.

## Mandatory Fluid UI Animation & Uncluttered Navigation Rule (`.agents/skills/ui-motion-craft/SKILL.md`)

1. **All UI Must Be Fluidly Animated (Zero Snappy / Abrupt DOM Swaps):**
   - Every view transition (`Home <-> Detail`, filter switches `All / Local / Drive / Podcasts / Saved`), modal/sheet/popover open **and close** (`[data-closing]` exit transition + `@starting-style` entry), card grid reveal (`.ui-stagger-item`), and interactive pill/button state MUST be fluidly animated using spring/exponential deceleration (`cubic-bezier(0.16, 1, 0.3, 1)` / `var(--ease-spring)`) and progressive View Transitions (`document.startViewTransition` when not typing in an input).
   - Overlays must animate out on close (`[data-closing]` before removal) rather than disappearing instantaneously in `0ms`.
   - Handle `@media (prefers-reduced-motion: reduce)` on a case-by-case basis by dampening spatial movement (`translate: none`) while keeping smooth opacity/color feedback — never use a global `transition-duration: 0.01ms !important` override.
2. **Uncluttered Header & Always-Visible Podcast Discovery:**
   - Never place a standalone `Devices` (`open-devices-modal`) button in the Mobile top header or Desktop bottom transport bar where it eats horizontal space (keep `Devices` tucked inside the Profile Avatar menu, alongside the automatic remote-handoff card when another device plays).
   - Keep Podcast search/discovery immediately accessible and impossible to lose: show an inline Podcast Search & Category Discovery bar at the top of the `Podcasts` view (even when podcasts are already subscribed), a prominent `Discover Podcasts` trigger next to the main search bar on Desktop, and a pinned/visible `Find Podcasts` trigger on Mobile.

## Mandatory Dual-Platform Subagent Parity Gate

Unless a task is explicitly requested for one platform only, every implementation round **MUST** be audited in parallel by two separate platform verifiers before building or pushing a release:
- **`android-parity-verifier`** (`.agents/agents/android-parity-verifier.md`, or `auditor-android` in `/swarm`): checks every fix/feature is imported, wired into `android-auto/` & `.github/workflows/release.yml`, and working across Android APK, Mobile `< 768px`, Chrome PWA, Notification Shade, Wear OS, and Android Auto.
- **`windows-parity-verifier`** (`.agents/agents/windows-parity-verifier.md`, or `auditor-windows` in `/swarm`): checks every fix/feature is imported, wired into `src-tauri/` & `scripts/prepare-tauri-ui.mjs`, and working across Windows `.exe` (`tauri.localhost`), Desktop `>= 768px`, and Windows CI.

## 5-Step Release Parity Checklist

1. **Dual-Platform Subagent Audit**: Run `android-parity-verifier` and `windows-parity-verifier` in parallel to verify both Windows (`tauri.localhost` / desktop viewport) and Android (`capacitor://` / `https://localhost` / mobile viewport / Android WebView / Chrome PWA / `android-auto/`) behavior and CI wiring.
2. **Version Bump**: Bump `version.json` (`version` and `build`), `LOCAL_VERSION` in `src/services/self-updater.js`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
3. **Prepare & Build Windows `.exe`**: Run `node scripts/prepare-tauri-ui.mjs` and `cargo build --release --manifest-path src-tauri/Cargo.toml`.
4. **Update Local & Desktop `.exe`**: Stop any running `Audiobook Player` process, copy the release `.exe` to both `d:\Code\Audiobook\Audiobook Player.exe` and `C:\Users\ecmat\OneDrive\Desktop\Audiobook Player.exe`, and verify identical SHA256 hashes (`Get-FileHash`).
5. **Verify, Shield & Push**: Run all unit tests (`node --test`), run `git-secret-shield`, commit, and `git push origin main` so Android OTA / GitHub Actions `.apk` receives the exact fix too.
