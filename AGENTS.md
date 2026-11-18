# Audiobook Player — Agent Rules

Follow all instructions in [`GEMINI.md`](./GEMINI.md), specifically the **Mandatory Windows <-> Android Cross-Platform Parity Rule**:

- Every bug report, UI change, or fix applied to the Windows version MUST automatically be audited and verified on the Android version (Android Mobile layout, Android WebView / Capacitor `.apk`, Android Chrome PWA, Notification Shade, Wear OS, and Android Auto) — and vice versa — before completion.
- Execute the full **5-Step Release Parity Checklist** from `GEMINI.md` on every release:
  1. Audit both Windows (`tauri.localhost` / desktop viewport) and Android (`capacitor://` / `https://localhost` / mobile viewport / Android WebView) behavior.
  2. Bump `version.json` and `LOCAL_VERSION` in `src/services/self-updater.js`.
  3. Run `node scripts/prepare-tauri-ui.mjs` and `cargo build --release --manifest-path src-tauri/Cargo.toml`.
  4. Stop any running `Audiobook Player` process, copy the release `.exe` to both `d:\Code\Audiobook\Audiobook Player.exe` and `C:\Users\ecmat\OneDrive\Desktop\Audiobook Player.exe`, and verify matching `Get-FileHash` SHA256.
  5. Run `node --test`, `git-secret-shield`, commit, and `git push origin main` so Android OTA / GitHub Actions `.apk` gets the exact fix too.
