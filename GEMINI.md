# Audiobook Player — Project Instructions

## Mandatory Windows <-> Android Cross-Platform Parity Rule

Every bug report, UI change, or fix applied to the Windows desktop version (`Audiobook Player.exe` / Tauri) **MUST** automatically be audited and verified on the Android version — and vice versa — before completion:

- **Windows targets**: Tauri desktop (`https://tauri.localhost`), Desktop 3-column viewport (`>= 768px`), Windows `.exe`.
- **Android targets**: Android Mobile layout (`< 768px`), Android WebView / Capacitor `.apk` (`https://localhost` / `capacitor://localhost`), Android Chrome PWA (`https://larxe1.github.io/Audiobook-Player/`), Notification Shade, Wear OS (`<= 340px` / `?watch=1`), and Android Auto (`?androidAuto=1`, `android-auto/`).

Never ship a Windows-only or Android-only fix without auditing auth redirects, OAuth popups, WebView constraints, local file pickers (`webkitdirectory` vs `accept="audio/*" multiple`), responsive layout, and OTA/update behavior across both platforms.

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
