# Audiobook Player — Project Instructions

## Mandatory Windows <-> Android Cross-Platform Parity Rule

Every bug report, UI change, or fix applied to the Windows desktop version (`Audiobook Player.exe` / Tauri) **MUST** automatically be audited and verified on the Android version — and vice versa — before completion:

- **Windows targets**: Tauri desktop (`https://tauri.localhost`), Desktop 3-column viewport (`>= 768px`), Windows `.exe`.
- **Android targets**: Android Mobile layout (`< 768px`), Android WebView / Capacitor `.apk` (`https://localhost` / `capacitor://localhost`), Android Chrome PWA (`https://larxe1.github.io/Audiobook-Player/`), Notification Shade, Wear OS (`<= 340px` / `?watch=1`), and Android Auto (`?androidAuto=1`).

Never ship a Windows-only or Android-only fix without auditing auth redirects, OAuth popups, WebView constraints, local file pickers (`webkitdirectory` vs `accept="audio/*" multiple`), responsive layout, and OTA/update behavior across both platforms.

## 5-Step Release Parity Checklist

1. **Cross-Platform Audit**: Audit both Windows (`tauri.localhost` / desktop viewport) and Android (`capacitor://` / `https://localhost` / mobile viewport / Android WebView / Chrome PWA) behavior for every fix.
2. **Version Bump**: Bump `version.json` (`version` and `build`) and `LOCAL_VERSION` in `src/services/self-updater.js`.
3. **Prepare & Build Windows `.exe`**: Run `node scripts/prepare-tauri-ui.mjs` and `cargo build --release --manifest-path src-tauri/Cargo.toml`.
4. **Update Local & Desktop `.exe`**: Stop any running `Audiobook Player` process, copy the release `.exe` to both `d:\Code\Audiobook\Audiobook Player.exe` and `C:\Users\ecmat\OneDrive\Desktop\Audiobook Player.exe`, and verify identical SHA256 hashes (`Get-FileHash`).
5. **Verify, Shield & Push**: Run all unit tests (`node --test`), run `git-secret-shield`, commit, and `git push origin main` so Android OTA / GitHub Actions `.apk` receives the exact fix too.
