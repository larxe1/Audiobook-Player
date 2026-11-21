# Live Podcasts & Automatic Episode Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use native `/swarm` orchestration with disjoint file ownership and shared contract verification. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified Spotify-style Podcasts experience with zero-RSS-hunting search & category browse, automatic RSS episode refresh, on-demand episode streaming, per-episode offline downloads, cross-device Supabase sync, and Windows/Android parity.

**Architecture:** A new `src/services/podcast-service.js` module handles Apple Podcasts search/category discovery (`itunes.apple.com/search?media=podcast&entity=podcast`), multi-tier CORS-resilient RSS fetching (Windows Tauri Rust `fetch_podcast_rss`, direct `fetch`, and CORS proxy fallbacks), and XML parsing into normalized podcast library items (`bookKey: 'podcast:<hash>'`, `isPodcast: true`, `chapters: episodes`). `AudioEngine` (`src/player/audio-engine.js`) gains per-episode streaming duration awareness and per-episode IndexedDB offline download caching (`${bookKey}::${episodeId}`). `src/ui/app.js` and `src/ui/icons.js` add the `Podcasts` filter chip, 1-tap category & search Podcast Finder modal, `"New Episodes"` Home shelf, and Podcast Show Detail episode list across Desktop (`>= 768px`), Android Mobile (`< 768px`), Notification Shade, Wear OS, and Android Auto.

**Tech Stack:** Vanilla ES Modules, Tailwind CSS, IndexedDB, HTML5 Audio, Supabase REST/Realtime, Tauri 2 (Rust), Capacitor Android / Android Auto.

**Spec:** `docs/superpowers/specs/2026-11-21-podcasts-design.md`

## Global Constraints

- Zero instructional subtitles next to section headings (`"New Episodes"` and `"Podcasts"` stand alone with no helper captions).
- Zero standard text emojis in UI labels; use crisp vector SVGs and `FLUENT_3D_PODCAST` for source badges.
- Strict text containment (`min-w-0`, `overflow-hidden`, `truncate`, `line-clamp-2`) on every podcast card and episode row.
- Users never have to hunt for, copy, or see raw RSS URLs; searching any show/topic or clicking a category chip (`Trending`, `Tech & AI`, `News`, `History`, `Science`, `True Crime`, `Comedy`, `Business`) automatically resolves `feedUrl` behind the scenes.
- Podcasts (`isPodcast: true`) must never be grouped into book franchises (`series: ''`).
- Mandatory Windows (`tauri.localhost` / `.exe`) <-> Android (`.apk` / mobile `< 768px` / Chrome PWA / Notification Shade / Wear OS / Android Auto) parity and 5-Step Release Parity Checklist.

## Review Focus

1. **CDATA, HTML tags, and XML entities in RSS feeds:** `<title>` and `<description>` containing `<![CDATA[<p>Episode &amp; Notes</p>]]>` must render as clean plain text (`Episode & Notes`) with zero raw HTML tags.
2. **Single-episode or multi-episode podcast duration in `AudioEngine`:** Loading a podcast with 1 or 50 episodes must set active `durationSec` to the active episode's `durationSec` (not the sum of all 50 episodes), and `_isMultiFileChapters` must return `true` for any podcast (`isPodcast === true` or chapter with `audioUrl`/`episodeId`).
3. **Feed refresh while an episode is actively playing or partially played:** When auto-refresh prepends a newer episode at `chapters[0]`, the user's active episode must be matched by `episodeId` so `chapterIndex` shifts to the right episode and `episodeProgress[episodeId]` preserves every episode's individual `positionSec` and `completed` state.
4. **Offline episode download when podcast CDN blocks browser CORS `fetch()`:** `cacheEpisodeOffline` must try direct `fetch(audioUrl)` first and fall back to CORS proxy (`https://corsproxy.io/?url=...` / `https://api.allorigins.win/raw?url=...`) so offline downloads succeed on Web/PWA/Android WebView.
5. **Direct Apple Podcasts URL or RSS URL pasted into search box:** If a user pastes an `https://...` feed URL or `podcasts.apple.com/.../id12345` link into the podcast search input, `searchPodcasts` / `subscribeToPodcast` must detect and resolve it automatically without requiring a separate RSS form.

---

### Task 1: Podcast Discovery, RSS Fetching & XML Parser Service (`src/services/podcast-service.js` + `src-tauri/src/main.rs`)

**Files:**
- Create: `src/services/podcast-service.js`
- Modify: `src-tauri/src/main.rs`
- Test: `tests/podcast.test.mjs`

**Interfaces:**
- Produces in `src/services/podcast-service.js`:
  - `PODCAST_CATEGORIES`: `Array<{ id: string, label: string, query: string }>` (`Trending`, `Tech & AI`, `News`, `History`, `Science`, `True Crime`, `Comedy`, `Business`)
  - `hashFeedUrl(feedUrl: string) -> string` (deterministic lowercase alphanumeric slug/hash, prefixing `bookKey` as `podcast:${hashFeedUrl(feedUrl)}`)
  - `searchPodcasts(query: string, options?: { fetchImpl?: typeof fetch, limit?: number }) -> Promise<Array<{ id: string, title: string, author: string, feedUrl: string, coverUrl: string, genre: string, episodeCount: number }>>`
  - `fetchPodcastFeedXml(feedUrl: string, options?: { fetchImpl?: typeof fetch, tauriInvoke?: Function }) -> Promise<string>`
  - `parsePodcastRssXml(xmlText: string, feedUrl?: string) -> { title: string, author: string, description: string, coverUrl: string, feedUrl: string, episodes: Array<{ episodeId: string, title: string, audioUrl: string, durationSec: number, publishedAt: string, description: string }> }`
  - `parseItunesDuration(raw: string | number) -> number`
  - `stripHtmlToText(raw: string) -> string`
  - `createPodcastBookItem(parsedFeed: object, existingBook?: object | null) -> object`
  - `subscribeToPodcastFromChoice(choiceOrFeedUrl: object | string, options?: { existingBook?: object, fetchImpl?: typeof fetch, tauriInvoke?: Function }) -> Promise<object>`
- Produces in `src-tauri/src/main.rs`:
  - `#[tauri::command] fn fetch_podcast_rss(url: String) -> Result<String, String>` registered in `tauri::generate_handler![...]`

- [ ] **Step 1: Write unit tests in `tests/podcast.test.mjs`** covering `searchPodcasts` (Apple Podcasts API query, direct RSS URL auto-detection, Apple `id12345` lookup, offline curated podcast fallback), `parseItunesDuration`, `stripHtmlToText` (CDATA + HTML tags + entities), `parsePodcastRssXml` (RSS 2.0 `<item><enclosure>`), and `createPodcastBookItem` (preserving `episodeId` -> `chapterIndex` and `episodeProgress` across feed refreshes).
- [ ] **Step 2: Implement `src/services/podcast-service.js`** with multi-tier RSS fetching (Tauri `fetch_podcast_rss` -> direct `fetch` -> `api.allorigins.win/raw` -> `corsproxy.io` -> offline sample episode fallback if all network tiers fail in offline test mode) and pure-JS XML parsing.
- [ ] **Step 3: Add `fetch_podcast_rss` command in `src-tauri/src/main.rs`** (validating `http://` or `https://` scheme and fetching UTF-8 RSS XML via PowerShell `Invoke-WebRequest -UseBasicParsing` on Windows) and register it in `invoke_handler`.
- [ ] **Step 4: Run `node --test tests/podcast.test.mjs`** and verify all tests pass.

---

### Task 2: AudioEngine Per-Episode Streaming, Duration & Offline Downloads + Cloud Sync Metadata (`src/player/audio-engine.js`, `src/services/supabase-sync.js`, `src/services/library-scanner.js`)

**Files:**
- Modify: `src/player/audio-engine.js`
- Modify: `src/services/supabase-sync.js`
- Modify: `src/services/library-scanner.js`
- Test: `tests/podcast.test.mjs`

**Interfaces:**
- Produces in `src/player/audio-engine.js`:
  - `_isMultiFileChapters(chapters)` returns `true` if `this.currentBook?.isPodcast` is true or any chapter has `ch?.audioUrl` or `ch?.episodeId`.
  - `loadBook(book, startPositionSec)` and `setChapter(index)` use active episode `durationSec` (`Number(ch?.durationSec) || 1800`) when `book.isPodcast` or `_isMultiFileChapters(book.chapters)` is true, and restore/save per-episode `book.episodeProgress[ch.episodeId]`.
  - `_resolveChapterMediaUrl(book, chapterIndex)` checks IndexedDB offline cache key `${book.bookKey}::${ch.episodeId || ch.driveFileId || chapterIndex}` first, then falls back to `ch.audioUrl || ch.driveStreamUrl`.
  - `cacheEpisodeOffline(book, chapterIndex) -> Promise<{ ok: boolean, cacheKey?: string }>` (fetches `ch.audioUrl` with CORS-proxy fallback, stores blob in IndexedDB under `${book.bookKey}::${ch.episodeId || chapterIndex}`, sets `ch.offlineCached = true` and `book.hasOfflineEpisodes = true`).
  - `removeEpisodeOffline(book, chapterIndex) -> Promise<{ ok: boolean }>`
  - `isEpisodeCachedOffline(bookKey, episodeId) -> Promise<boolean>`
- Produces in `src/services/supabase-sync.js` & `src/services/library-scanner.js`:
  - Preserves `isPodcast`, `mediaType`, `feedUrl`, `lastFeedRefreshAt`, and `episodeProgress` in `_normalizeLibraryItemForCloud`, `normalizeCloudBook`, and `deduplicateBooks` (never merging podcast items into non-podcast audiobooks).

- [ ] **Step 1: Extend `tests/podcast.test.mjs`** with behavioral tests for `AudioEngine` single-episode and multi-episode podcast loading, per-episode duration and `episodeProgress` switching, `cacheEpisodeOffline` / `removeEpisodeOffline`, and `SupabaseSyncService` cloud normalization of podcast items.
- [ ] **Step 2: Update `src/player/audio-engine.js`, `src/services/supabase-sync.js`, and `src/services/library-scanner.js`**.
- [ ] **Step 3: Run `node --test`** to verify all new and existing unit tests pass.

---

### Task 3: Spotify-Style Podcasts UI, Automatic Finder Modal, "New Episodes" Shelf & 30-Min Auto-Refresh (`src/ui/icons.js`, `src/ui/app.js`)

**Files:**
- Modify: `src/ui/icons.js`
- Modify: `src/ui/app.js`
- Test: `tests/ui-stability.test.mjs`

**Interfaces:**
- Consumes: `PODCAST_CATEGORIES`, `searchPodcasts`, `subscribeToPodcastFromChoice`, `fetchPodcastFeedXml`, `parsePodcastRssXml`, `createPodcastBookItem` from `src/services/podcast-service.js`; `cacheEpisodeOffline`, `removeEpisodeOffline` from `src/player/audio-engine.js`.
- Produces in `src/ui/icons.js`:
  - `FLUENT_3D_PODCAST(size = 18)` (3D Fluent microphone/podcast badge SVG)
  - `ICON_PODCAST(size = 16)` (crisp vector broadcast/mic icon)
- Produces in `src/ui/app.js`:
  - `filterSource` supports `'podcasts'` alongside `'all' | 'local' | 'drive' | 'downloaded'` on both Windows Desktop sidebar and Android Mobile header.
  - `Podcasts` filter chip + `+ Podcast` button (`data-action="open-podcast-modal"`).
  - Automatic Podcast Finder Modal (`this.state.podcastModal`) with search-as-you-type input (`data-action="podcast-search-input"`), 1-tap category chips (`data-action="select-podcast-category"`), live podcast cards with 1-tap `Follow` / `Following` button (`data-action="subscribe-podcast"`), and zero required RSS URL inputs.
  - `"New Episodes"` horizontal shelf on Home (Desktop & Mobile when filter is `'all'` or `'podcasts'`) showing latest episodes across subscribed podcasts with 1-tap play (`data-action="play-podcast-episode"`) and 1-tap offline download (`data-action="toggle-episode-offline"`).
  - Podcast Show Detail view & Now Playing episode list showing publish date, duration, played checkmark, expandable show notes, per-episode offline download button (`↓` / spinner / green `ICON_DOWNLOADED_CIRCLE(14)`), manual `Refresh` (`data-action="refresh-podcast-feed"`), and `Following / Unfollow` (`data-action="unsubscribe-podcast"`).
  - Background auto-refresh on startup and every 30 minutes (`refreshAllPodcastFeeds({ silent: true })`), persisting subscriptions to `localStorage` (`audiobook_podcasts_v1`) and `syncService.syncLibraryItems`.
  - Never groups podcasts (`book.isPodcast`) into book series folders.

- [ ] **Step 1: Add `FLUENT_3D_PODCAST` and `ICON_PODCAST` to `src/ui/icons.js`**.
- [ ] **Step 2: Integrate podcast state, persistence, auto-refresh timer, filter chip, `"New Episodes"` shelf, Show Detail episode list, per-episode offline download actions, and Podcast Finder modal into `src/ui/app.js`**.
- [ ] **Step 3: Add UI stability & rendering tests for Podcasts filter, Finder modal, and New Episodes shelf in `tests/ui-stability.test.mjs` and run `node --test`**.
