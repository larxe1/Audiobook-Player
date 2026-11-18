# Audiobook Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use native `/swarm` (`gemini-4-hydrogen-high` workers with disjoint `ALLOWED_PATHS`) or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Audiobook Player`, a Spotify-inspired cross-platform audiobook player for Android (PWA + Capacitor `.apk` + Notification Shade MediaStyle mini-player + Samsung Galaxy Watch Wear OS circular controller + conditional Android Auto car mode) and Windows Desktop (3-column Spotify Web layout), powered by Google Drive streaming, local folder playback with smart deduplication, automatic file-tag & online metadata enrichment, online cover art search, and Supabase Realtime + Gmail OAuth cross-device sync.

**Architecture:** Modular ES Module web application (`index.html`, `src/styles/theme.css`, `src/services/*`, `src/player/*`, `src/ui/*`) with Capacitor Android + Native Android Auto `MediaBrowserServiceCompat` (`android-auto/*`) and offline-first `IndexedDB` + Supabase Postgres/Realtime (`ycokzejqpenvlamvzhrm` `audiobook_*` tables). Each subsystem lives in strictly disjoint file paths so 4 parallel `gemini-4-hydrogen-high` coders can implement all modules simultaneously without file collisions.

**Tech Stack:** Vanilla ES2024 Modules, Tailwind CSS + CSS Custom Properties (`Midnight Black` default + `Pitch Black` theme toggle), Web Audio / HTML5 Audio API, MediaSession API, IndexedDB, Google Drive API v3, iTunes/Audnexus/Open Library/Google Books Metadata & Cover Search APIs, Supabase REST & Realtime WebSockets, Node.js (`node --test` unit test runner).

**Spec:** `d:\Code\Audiobook\docs\superpowers\specs\2026-11-18-audiobook-player-design.md`

## Global Constraints

- **App Name:** `Audiobook Player`
- **Themes:** `Midnight Black` (`#060911` canvas, `#080c16` shell, `#0d1322` panel, `#131b2e` card) is the default theme; `Pitch Black` (`#050506` canvas, `#08080a` shell, `#101012` panel, `#161619` card) is selectable from the Gmail Profile menu and persisted in `localStorage`.
- **Minimalist Copy & Zero Handholding Ban:** Never render instructional subtitles next to section headings (`"Jump back in"`, `"Library"` stand alone), never render `"Offline"` or `"Synced"` text badges, never render sub-labels under `-15s`/`+30s`/`Bookmark` buttons, and never render verbose status banners. Use a `14px` green downward-arrow-in-circle SVG icon for downloaded status and 3D Fluent Folder/Cloud SVGs for source badges.
- **Strict Text Containment:** Every card, cover thumbnail, and flex/grid child must enforce `min-w-0`, `overflow-hidden`, and `truncate` or `clamp-2` so long titles (such as *The Fellowship of the Ring*) never overflow outside their container.
- **Android Auto Visibility:** Car Mode UI is completely hidden during normal mobile/desktop operation and only renders when Android Auto is connected.
- **Galaxy Watch (Wear OS) Design:** Circular `270×270` watch surface with a full-watch faded cover-art gradient backdrop (`opacity: 0.35` + radial dark vignette), a small `24×24px` mini cover thumbnail inside the title pill, bezel progress ring, `-15s`, `Play/Pause`, `+30s`, speed cycler, and 1-tap Bookmark.
- **Supabase Project:** `https://ycokzejqpenvlamvzhrm.supabase.co` (Publishable key: `sb_publishable_YzLKM2MCjKhqrc91vgmsFA_8RZlzyOZ`), isolated to `public.audiobook_library_items`, `public.audiobook_progress`, `public.audiobook_bookmarks`, and `public.audiobook_devices`.

## Review Focus

1. **Duplicate Book in Local Folder + Google Drive:** When the same audiobook (`Project Hail Mary` by `Andy Weir`, even with different casing/punctuation or file extensions `.m4b` vs `.mp3`) is scanned from both a Local Folder and Google Drive, `deduplicateLibraryItems` must merge them into a single book item with `sources: ['drive', 'local']` and prefer `localUrl` for playback.
2. **Offline Listening Followed by Reconnection:** When progress updates occur while `navigator.onLine === false`, `resolveProgressConflict(localRecord, remoteRecord)` must pick the record with the newer `clientUpdatedAt` timestamp and flush queued checkpoints without losing position.
3. **Malformed or Missing ID3/M4B Headers:** When an audio file has no ID3v2/MP4 tags or truncated bytes, `parseAudioTags(buffer, filename)` must safely fall back to extracting clean `title` and `author` from the filename without throwing.
4. **Long Unbroken Words in Book Titles:** Titles like `"The Fellowship of the Ring"` must stay strictly contained inside square cover cards (`overflow-hidden`, `clamp-2`, `break-words`) with zero horizontal overflow.
5. **Remote Device Playback Handoff:** When a remote device on the same Gmail account broadcasts `PLAYBACK_STARTED`, the local active player must pause immediately and update its position to the remote `positionSec` and `chapterIndex`.

---

### Task 1: Project Scaffold, Theme CSS, HTML Shell & Native Android Auto Manifest (`coder-scaffold`)

**Files:**
- Create: `d:\Code\Audiobook\package.json`
- Create: `d:\Code\Audiobook\.gitignore`
- Create: `d:\Code\Audiobook\index.html`
- Create: `d:\Code\Audiobook\src\styles\theme.css`
- Create: `d:\Code\Audiobook\public\manifest.json`
- Create: `d:\Code\Audiobook\public\sw.js`
- Create: `d:\Code\Audiobook\capacitor.config.json`
- Create: `d:\Code\Audiobook\android-auto\AndroidManifest.xml`
- Create: `d:\Code\Audiobook\android-auto\res\xml\automotive_app_desc.xml`
- Create: `d:\Code\Audiobook\android-auto\AudiobookMediaBrowserService.kt`

**Interfaces:**
- Produces:
  - DOM shell in `d:\Code\Audiobook\index.html` loading `./src/styles/theme.css` and `<script type="module" src="./src/ui/app.js"></script>`.
  - CSS classes in `d:\Code\Audiobook\src\styles\theme.css`: `.theme-midnight`, `.theme-pitch`, `.surface-shell`, `.surface-panel`, `.surface-card`, `.ambient-surface`, `.sheet-modal`, `.notif-shade`, `.popover-menu`, `.clamp-2`, `.btn-press`, `.play-fab`.
  - NPM scripts in `package.json`: `"test": "node --test tests/*.test.mjs"`, `"start": "node scripts/serve.mjs"` (or static HTTP server).

- [ ] **Step 1: Create `.gitignore` and `package.json`**
  - `.gitignore` must ignore `.env`, `.env.*`, `*.env`, `node_modules/`, `dist/`, `.superpowers/`, `*.keystore`, `*.jks`.
  - `package.json` sets `"type": "module"`, `"name": "audiobook-player"`, `"version": "1.0.0"`, `"scripts": { "test": "node --test tests/sync.test.mjs tests/library.test.mjs" }`.

- [ ] **Step 2: Create `src/styles/theme.css`**
  - Define `--bg-canvas`, `--bg-shell`, `--bg-panel`, `--bg-card`, `--bg-card-hover`, `--border-subtle` for `body.theme-midnight` (`#060911`, `#080c16`, `#0d1322`, `#131b2e`) and `body.theme-pitch` (`#050506`, `#08080a`, `#101012`, `#161619`), plus spring animations (`cubic-bezier(0.22, 1, 0.36, 1)`), `.notif-shade`, `.sheet-modal`, `.popover-menu`, and `.clamp-2`.

- [ ] **Step 3: Create `index.html`, `public/manifest.json`, `public/sw.js`, `capacitor.config.json`, and `android-auto/*`**
  - `index.html` links `./src/styles/theme.css`, `./public/manifest.json`, and `<script type="module" src="./src/ui/app.js"></script>`, and provides `<div id="appRoot"></div>` plus hidden `<input id="localFolderInput" type="file" webkitdirectory multiple class="hidden" />` and `<input id="localCoverInput" type="file" accept="image/*" class="hidden" />`.
  - `android-auto/AndroidManifest.xml`, `android-auto/res/xml/automotive_app_desc.xml`, and `android-auto/AudiobookMediaBrowserService.kt` declare Android Auto media support (`<uses name="media"/>`), `MediaSession` transport callbacks (`onPlay`, `onPause`, `onFastForward` -> `+30s`, `onRewind` -> `-15s`), and Bluetooth disconnect auto-pause.

---

### Task 2: Supabase Auth, Realtime Device Handoff & Offline Sync Queue (`coder-sync`)

**Files:**
- Create: `d:\Code\Audiobook\src\services\offline-queue.js`
- Create: `d:\Code\Audiobook\src\services\supabase-sync.js`
- Test: `d:\Code\Audiobook\tests\sync.test.mjs`

**Interfaces:**
- Produces in `src/services/offline-queue.js`:
  - `resolveProgressConflict(localRecord, remoteRecord)` -> returns winning record based on latest `clientUpdatedAt` ISO/epoch timestamp.
  - `class OfflineSyncQueue` with methods `enqueueProgress(checkpoint)`, `getPendingQueue()`, `clearFlushed(upToTimestamp)`, `saveLocalProgress(bookKey, checkpoint)`, `getLocalProgress(bookKey)`, `getAllLocalProgress()`.
- Produces in `src/services/supabase-sync.js`:
  - `SUPABASE_CONFIG` (`url: 'https://ycokzejqpenvlamvzhrm.supabase.co'`, `publishableKey: 'sb_publishable_YzLKM2MCjKhqrc91vgmsFA_8RZlzyOZ'`).
  - `class SupabaseSyncService` with methods:
    - `signInWithGoogle()` / `signOut()` / `getUserProfile()`
    - `pushProgress(checkpoint)` / `fetchAllProgress()`
    - `saveBookmark(bookKey, bookmark)` / `fetchBookmarks(bookKey)`
    - `broadcastPlaybackState(statePayload)` / `onRemotePlaybackEvent(callback)`
    - `handleRemoteEvent(localState, remoteEvent)` -> returns `{ shouldPauseLocal, updatedPositionSec, updatedChapterIndex, activeDeviceName }`.

- [ ] **Step 1: Write unit tests in `tests/sync.test.mjs`**
  - Test `resolveProgressConflict` when local offline timestamp is newer than cloud vs. when cloud is newer.
  - Test `OfflineSyncQueue` queueing while offline and deduplicating multiple ticks for the same `bookKey` so only the newest position is flushed.
  - Test `handleRemoteEvent` pausing local playback when another device on the same account emits `PLAYBACK_STARTED`.

- [ ] **Step 2: Implement `src/services/offline-queue.js` and `src/services/supabase-sync.js`**
  - Run `node --test tests/sync.test.mjs` and confirm all tests pass.

---

### Task 3: Smart Library Scanner, Local+Drive Deduplication, Tag Parser & Cover Image Search (`coder-library`)

**Files:**
- Create: `d:\Code\Audiobook\src\services\library-scanner.js`
- Create: `d:\Code\Audiobook\src\services\metadata-enrichment.js`
- Create: `d:\Code\Audiobook\src\services\cover-search.js`
- Test: `d:\Code\Audiobook\tests\library.test.mjs`

**Interfaces:**
- Produces in `src/services/library-scanner.js`:
  - `normalizeBookKey(title, author)` -> deterministic slug (e.g. `'project-hail-mary::andy-weir'`).
  - `deduplicateLibraryItems(items)` -> merges items sharing the same `bookKey` across `'drive'` and `'local'`, combining `sources` array (`['drive', 'local']`), preserving chapters/bookmarks, and setting `preferredPlaybackSource: 'local'` whenever a local copy exists.
  - `scanLocalFiles(fileList)` -> groups `.m4b`, `.mp3`, `.m4a`, `.ogg`, `.flac` files into audiobook objects with extracted tags and chapters.
  - `scanGoogleDriveFolder(accessToken, folderId)` -> fetches audio files from Google Drive API v3 and builds streaming URLs.
- Produces in `src/services/metadata-enrichment.js`:
  - `parseAudioTags(uint8ArrayOrBuffer, filename)` -> parses ID3v2 (`TIT2`, `TPE1`, `TALB`, `TCOM`) and MP4/M4B (`©nam`, `©ART`, `©wrt`) atoms, falling back gracefully to filename parsing.
  - `enrichBookMetadata(book)` -> queries iTunes Search API (`https://itunes.apple.com/search?media=audiobook&term=...`), Audnexus, and Open Library to fill missing `author`, `narrator`, `description`, and `coverUrl`.
- Produces in `src/services/cover-search.js`:
  - `searchCoverImages(query)` -> queries iTunes Audiobook Artwork (high-res `600x600`/`1200x1200`), Open Library Covers, and Google Books / Image search endpoints, plus styled SVG cover fallbacks so it works both online and offline.

- [ ] **Step 1: Write unit tests in `tests/library.test.mjs`**
  - Test `normalizeBookKey` and `deduplicateLibraryItems` merging a Google Drive `.m4b` and a Local `.mp3` folder of *Project Hail Mary* into a single book with `sources: ['drive', 'local']` and `preferredPlaybackSource: 'local'`.
  - Test `parseAudioTags` extracting title/author from a synthetic ID3v2 header buffer AND falling back cleanly on an empty/corrupt buffer.
  - Test `searchCoverImages` returning valid cover candidate objects.

- [ ] **Step 2: Implement `src/services/library-scanner.js`, `src/services/metadata-enrichment.js`, and `src/services/cover-search.js`**
  - Run `node --test tests/library.test.mjs` and confirm all tests pass.

---

### Task 4: Audio Engine, MediaSession/Watch/Car Bridge & Minimalist UI Controller (`coder-player`)

**Files:**
- Create: `d:\Code\Audiobook\src\player\audio-engine.js`
- Create: `d:\Code\Audiobook\src\player\media-session-bridge.js`
- Create: `d:\Code\Audiobook\src\ui\icons.js`
- Create: `d:\Code\Audiobook\src\ui\app.js`

**Interfaces:**
- Consumes:
  - `OfflineSyncQueue`, `SupabaseSyncService` from `src/services/offline-queue.js` and `src/services/supabase-sync.js`.
  - `deduplicateLibraryItems`, `scanLocalFiles`, `scanGoogleDriveFolder` from `src/services/library-scanner.js`.
  - `enrichBookMetadata` from `src/services/metadata-enrichment.js`.
  - `searchCoverImages` from `src/services/cover-search.js`.
- Produces:
  - Complete interactive `Audiobook Player` application mounted into `#appRoot` in `index.html`.

- [ ] **Step 1: Implement `src/player/audio-engine.js` and `src/player/media-session-bridge.js`**
  - `AudioEngine` supports playing local `File`/blob URLs, IndexedDB cached offline blobs, Google Drive stream URLs, and Web Audio synthesized voice/tone preview playback for built-in library items, plus `-15s`, `+30s`, chapter seek, speed (`1.0x`–`2.0x`), Sleep Timer, and IndexedDB offline caching.
  - `MediaSessionBridge` updates `navigator.mediaSession.metadata` and action handlers (`play`, `pause`, `seekbackward` `-15s`, `seekforward` `+30s`, `previoustrack`, `nexttrack`, `seekto`) for Android Notification Shade, Samsung Galaxy Watch (Wear OS), and Android Auto.

- [ ] **Step 2: Implement `src/ui/icons.js` and `src/ui/app.js`**
  - Render all views matching the approved minimalist design:
    1. **Top Theme & Preview Switcher**: Switch between `Midnight Black` (default), `Pitch Black`, and `Side-by-Side Compare`, plus `Notification Shade`, `Galaxy Watch`, conditional `Android Auto`, and `App Views`.
    2. **Android Mobile View** with pull-down **Android Notification Shade MediaStyle Mini-Player**, slide-up **Full-Screen Now Playing Sheet**, and **Gmail Profile & Settings Popover**.
    3. **Samsung Galaxy Watch (Wear OS) Circular Controller** with faded full-watch cover-art gradient backdrop, small `24×24px` mini cover thumbnail inside the title pill, bezel progress ring, `-15s`, `Play/Pause`, `+30s`, Speed, and Bookmark.
    4. **Conditional Android Auto Car View** (hidden unless Android Auto is connected; zero redundant helper text).
    5. **Windows Desktop 3-Column Spotify Web Layout** (collapsible library rail, quick-resume grid, "Jump back in" & "Library" shelves, Book Detail & Chapters view, Right Now Playing & Bookmarks panel, and bottom transport bar).
    6. **Live Cover Image Search Modal** (queries real iTunes/OpenLibrary/Google Books cover images via `searchCoverImages`, lets the user click any cover to apply & persist it, or upload a local image file) and **Local Folder Import** (`#localFolderInput` scanning real `.m4b`/`.mp3` files with automatic deduplication!).
  - Verify `node --check` on all `.js` files.
