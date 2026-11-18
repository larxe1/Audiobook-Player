# Audiobook Player — Agent Rules

Follow all instructions in [`GEMINI.md`](./GEMINI.md), specifically the **Mandatory Windows <-> Android Cross-Platform Parity Rule** and **Mandatory Dual-Platform Subagent Parity Gate**:

- Every bug report, UI change, or fix applied to the Windows version MUST automatically be audited and verified on the Android version (Android Mobile layout, Android WebView / Capacitor `.apk`, Android Chrome PWA, Notification Shade, Wear OS, and Android Auto) — and vice versa — before completion.
- **Dual-Platform Subagent / Swarm Parity Gate**: Before releasing or claiming completion on any change (unless explicitly scoped to one platform only), spawn **both** dedicated parity verifiers in parallel — `android-parity-verifier` (defined in `.agents/agents/android-parity-verifier.md`, or `auditor-android` in `/swarm`) and `windows-parity-verifier` (defined in `.agents/agents/windows-parity-verifier.md`, or `auditor-windows` in `/swarm`) — to verify that every fix and feature is actually imported, wired, and working on both platforms. If either reports `FAIL`, fix the gap and re-verify before building/pushing.
- Execute the full **5-Step Release Parity Checklist** from `GEMINI.md` on every release:
  1. Audit both Windows (`tauri.localhost` / desktop viewport) and Android (`capacitor://` / `https://localhost` / mobile viewport / Android WebView) behavior via the dual-platform parity verifiers.
  2. Bump `version.json`, `LOCAL_VERSION` in `src/services/self-updater.js`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
  3. Run `node scripts/prepare-tauri-ui.mjs` and `cargo build --release --manifest-path src-tauri/Cargo.toml`.
  4. Stop any running `Audiobook Player` process, copy the release `.exe` to both `d:\Code\Audiobook\Audiobook Player.exe` and `C:\Users\ecmat\OneDrive\Desktop\Audiobook Player.exe`, and verify matching `Get-FileHash` SHA256.
  5. Run `node --test`, `git-secret-shield`, commit, and `git push origin main` so Android OTA / GitHub Actions `.apk` gets the exact fix too.
