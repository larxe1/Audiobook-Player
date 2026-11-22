# Audiobook-Player

Cross-platform audiobook player with a Spotify-inspired dark interface, Google Drive streaming, local folder deduplication, and automatic self-updates wired to `https://github.com/larxe1/Audiobook-Player`.

## Features

- **Midnight Black & Pitch Black Themes**: Defaults to Midnight Black (`#060911`) with an instant switch to Pitch Black (`#050506`) for OLED displays.
- **Google Drive + Local Folder Deduplication**: Combines cloud audiobooks from Google Drive with local device folders into a single unified library without duplicate entries.
- **Android Notification Shade Mini-Player**: MediaSession-backed lock screen and notification shade playback controls (`-15s`, Play/Pause, `+30s`).
- **Samsung Galaxy Watch (Wear OS) Circular Controller**: Dedicated 270×270 circular watch controller preview and companion media controls with ambient cover backdrop.
- **Conditional Android Auto Car Mode**: Automatically surfaces a driver-friendly Car Mode interface when Android Auto / automotive playback is active, and stays hidden when disconnected.
- **Cover Image Search**: Search and apply crisp audiobook artwork online or pick a local image file.
- **Non-Blocking Updates**:
  - **Windows Desktop (`MultiPlayer.exe`)**: Checks GitHub Releases (`https://api.github.com/repos/larxe1/Audiobook-Player/releases/latest`), downloads the new `.exe` silently in the background without interrupting playback, and shows a dismissible **Restart to Update** prompt when ready.
  - **Web / Android Chrome PWA**: Stages Service Worker updates in the background and shows a dismissible **Reload to Update** prompt.
  - **Android APK**: Managed externally via **Obtainium** pointing to GitHub Releases (`https://github.com/larxe1/Audiobook-Player`) with zero startup lockout. You can also check manually from **Profile -> Check for Updates** to open the latest GitHub Release page.

## Installation

### Android

Choose either option:

1. **Install Native Android APK with Obtainium (Recommended for Android)**
   - Install [Obtainium](https://github.com/ImranR98/Obtainium) on your Android device (or download the initial [`Audiobook-Player.apk`](https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk) directly from **GitHub Releases**).
   - In Obtainium, tap **Add App**.
   - Paste the repository URL: `https://github.com/larxe1/Audiobook-Player`
   - Obtainium automatically detects the GitHub Releases source and `Audiobook-Player.apk` asset.
   - Tap **Add** and then **Install** (or **Update** for future releases) so Obtainium notifies and updates the app natively without in-app interruptions.

2. **Install as a Progressive Web App (PWA)**
   - Open [`https://larxe1.github.io/Audiobook-Player/`](https://larxe1.github.io/Audiobook-Player/) in Chrome on Android.
   - Tap the browser menu (`...`) -> **Install app** (or **Add to Home screen**).
   - Updates stage silently via the Service Worker and prompt with **Reload to Update**.

### Windows PC

Choose any option:

1. **Standalone Native Desktop App (`Audiobook Player.exe` via Tauri 2)**
   - Double-click `Audiobook Player.exe` (or build locally with `npm run tauri:build`, which prepares `ui-dist/` and compiles `src-tauri/` into a standalone Windows executable with no browser chrome or console window).
   - Downloadable from **GitHub Releases** as [`Audiobook-Player.exe`](https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe).
   - Future updates download silently in the background while you listen and show a **Restart to Update** banner when ready to swap and relaunch.

2. **One-Click Local Server Launcher (`Launch-Audiobook-Player.bat`)**
   - Ensure [Node.js](https://nodejs.org/) (v18+) is installed.
   - Double-click `Launch-Audiobook-Player.bat` in the repository root.
   - It starts the local server on `http://127.0.0.1:4173` (if not already running) and opens Microsoft Edge or Google Chrome in standalone borderless app mode (`--app=http://127.0.0.1:4173`).

3. **Install via Edge / Chrome (GitHub Pages or Local Server)**
   - Open [`https://larxe1.github.io/Audiobook-Player/`](https://larxe1.github.io/Audiobook-Player/) (or `http://127.0.0.1:4173`) in Microsoft Edge or Google Chrome.
   - Click the **Install Audiobook Player** icon in the address bar (or browser menu -> **Apps -> Install this site as an app**).

## Development & Releases

- Run unit tests:
  ```bash
  npm test
  ```
- Pushing changes to `main` automatically deploys the web/PWA build to GitHub Pages.
- Updating `version.json` on `main` (or triggering the workflow manually via **Actions -> workflow_dispatch**) runs separate decoupled release jobs: `publish-android-release` uploads `Audiobook-Player.apk` directly to GitHub Releases as soon as the Android build finishes, and `publish-windows-release` uploads `Audiobook-Player.exe` independently.
