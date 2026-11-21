# Audiobook Player — Live Podcasts & Automatic Episode Refresh Design Specification

**Date:** 2026-11-21  
**Feature:** Unified Spotify-Style Podcasts (Live RSS Feeds, Auto-Refresh, On-Demand Streaming & Per-Episode Offline Downloads)  
**Target Platforms:** Windows Desktop (Tauri `.exe` / `tauri.localhost` / Desktop `>= 768px`) & Android (Capacitor `.apk` / Mobile `< 768px` / Chrome PWA / Notification Shade / Wear OS / Android Auto)

---

## 1. Intent & Why

Extend **Audiobook Player** so it works just like Spotify's unified **Audiobooks + Podcasts** experience:
- Users can discover and follow live podcasts just like Spotify — simply type any podcast name, host, or topic (or tap a category chip like `Top Podcasts`, `Tech & AI`, `History`, `Science`, `News`, `True Crime`, `Comedy`) and tap **Follow / Play**. The app automatically resolves the podcast's live feed behind the scenes using the Apple Podcasts directory API (`itunes.apple.com/search?media=podcast&entity=podcast`, which already returns `feedUrl` + `artworkUrl600` with CORS enabled) — **users never have to hunt for, copy, or see an RSS URL**.
- Subscribed podcast feeds **automatically refresh** on app startup and periodically in the background so new episodes appear automatically without manual file management.
- Episodes **stream on demand by default** (keeping device storage near zero), while offering a **1-tap offline download button per episode** (using the app's existing IndexedDB offline blob store and `14px` Spotify green downloaded icon) for flights, commutes, or Android Auto driving.
- Subscriptions, episode listening positions, played state, and live device handoff ("Spotify Connect" style) sync seamlessly across Windows PC and Android devices.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
1. **Spotify-Unified Navigation & Zero-RSS-Hunting Discovery (`Podcasts` Filter Chip + Automatic Podcast Finder):**
   - Add a **`Podcasts`** filter chip alongside `All`, `Local`, `Drive`, and `Saved` in both the Windows Desktop left sidebar and Android Mobile top filter bar.
   - **Zero-RSS-Hunting Search & Instant Category Browse:**
     - Users never need to look up or paste RSS links. Opening the **Explore / Find Podcasts** modal (or selecting the `Podcasts` chip when empty, or searching while on the `Podcasts` filter) lets the user type any keyword, show name, host, or topic into a single search bar (`"Search podcasts, hosts, or topics..."`).
     - Behind the scenes, the app queries Apple's live podcast directory (`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=20&term=...`, the same CORS-enabled iTunes API family Neon already uses in `src/services/cover-search.js`), which automatically returns each show's cover art, title, host, genre, episode count, and its hidden `feedUrl`.
     - Before the user even types, display **1-Tap Discovery Category Chips** (`Trending`, `Tech & AI`, `News`, `History`, `Science`, `True Crime`, `Comedy`, `Business`) that automatically populate real, live podcasts ready to follow in one tap.
     - Clicking **Follow** (or clicking a show card) automatically grabs `feedUrl` in the background, fetches and parses its live episodes, adds the show to the library, and opens its episodes ready to play — zero RSS URLs ever shown to the user. (If a user ever pastes an Apple Podcasts link or direct feed URL into that same search box, it is auto-detected seamlessly without a separate RSS input field.)
2. **Automatic Feed Refresh & `"New Episodes"` Home Shelf:**
   - Automatically poll subscribed podcast RSS feeds on app launch and on a background timer (every 30 minutes while active, plus a manual **Refresh Feeds** button in the podcast view).
   - Surface the latest unplayed episodes across all subscribed shows in a horizontal **"New Episodes"** shelf on the Home view (visible under `All` and `Podcasts`, hidden under `Local`/`Drive` audiobook-only filters) so users can jump straight into today's episodes in one tap.
3. **Podcast Show Detail & Per-Episode Streaming + Offline Download:**
   - Represent each subscribed podcast as a unified library item (`isPodcast: true`, `mediaType: 'podcast'`, `sources: ['podcast']`, `bookKey: 'podcast:<feedHash>'`) where its episodes map cleanly to `chapters` (ordered newest-first).
   - Display a distinct **Microsoft Fluent 3D Microphone / Podcast badge** on podcast cards and rows (matching the existing 3D Folder and 3D Cloud source badges).
   - In the Show Detail / Episode List view (and Now Playing chapter/episode drawer):
     - Show each episode's title, release date (`Today`, `Yesterday`, `Nov 18`), duration, progress bar / played checkmark, expandable show notes summary, and a **per-episode Offline Download toggle button** (`↓` to download, spinner while downloading, Spotify `14px` green checkmark circle when saved offline, click again to remove offline copy).
     - Include an **Unsubscribe** button and a **Refresh Feed** button in the show header.
4. **Full Cross-Platform Parity (Windows, Android Mobile, PWA, Notification Shade, Wear OS & Android Auto):**
   - **Windows Tauri (`.exe`):** Add a native Rust command `fetch_podcast_rss(url: String)` (using PowerShell/`System.Net.WebClient` or native HTTP in `src-tauri/src/main.rs`) and `AudiobookUpdaterNative` / multi-tier fetch fallback on Android/Web so RSS feeds never fail due to third-party podcast host CORS restrictions.
   - **Android Auto (`android-auto/` & `?androidAuto=1`) & Wear OS (`?watch=1`) & Notification Shade:** Because podcast shows normalize into the existing `books` + `chapters` structure and `AudioEngine`, active podcast episodes automatically work with `-15s`, `Play/Pause`, `+30s`, `Bookmark`, sleep timer, playback speed, Wear OS circular controller, Android 13/14/15 `MediaStyle` notification shade, and Android Auto browse/playback.
5. **Cross-Device Cloud Sync (Zero Database Migration Required):**
   - Persist podcast subscriptions (`feedUrl`, `title`, `author`, `coverUrl`, and latest episodes metadata) through the existing `audiobook_library_items` table (`metadata_json.feedUrl`, `metadata_json.isPodcast = true`, `sources: ['podcast']`) and Google Drive `appDataFolder` sync JSON.
   - Sync active episode index (`chapterIndex`) and timestamp (`positionSec`) across devices via the existing `audiobook_progress` and live Realtime handoff channel.

### Non-Goals
- Building a podcast hosting/publishing studio or social comment section.
- Automatically downloading gigabytes of back-catalog episodes without user consent (streaming is the default; offline download is user-triggered per episode).

### Anti-Goals (Must Never Happen)
- Verbose helper subtitles or instructional banners (`"Auto-refreshes every 30m"`, `"Streaming from RSS"`, etc.) — keep the strict **"Less is Better"** zero-handholding Spotify copy discipline from `2026-11-18-audiobook-player-design.md`.
- Raw XML/HTML tags (`<p>`, `<![CDATA[`, `&amp;`) leaking into episode titles or show notes.
- Failing silently when a podcast RSS host lacks browser CORS headers.
- Breaking existing audiobook series grouping (podcasts must never be grouped into book franchises like *The Expanse* or *The Sandman*).

---

## 3. Approaches Considered

1. **Approach 1: Unified Spotify-Style Library with `Podcasts` Chip, `New Episodes` Shelf & Multi-Track Episode Mapping (Selected)**
   - Models each subscribed podcast as a library item (`bookKey: "podcast:<hash>"`, `isPodcast: true`, `sources: ['podcast']`) whose episodes map to `chapters` with per-episode `audioUrl`, `episodeId`, `publishedAt`, `description`, and `offlineCached` state.
   - *Pros:* Seamless Spotify feel; reuses 100% of `AudioEngine`, `MediaSession`, Android Auto, Wear OS, Notification Shade, and Supabase `audiobook_library_items` / `audiobook_progress` sync without database schema migrations.
2. **Approach 2: Separate Top-Level `Audiobooks` vs. `Podcasts` App Mode Switcher (Rejected)**
   - Splits the app into two isolated modes with separate home screens and player queues.
   - *Cons:* Adds extra navigation friction and moves away from Spotify's unified home & library experience.
3. **Approach 3: Server-Side RSS Polling via Supabase Edge Functions & New `podcast_*` Tables (Rejected)**
   - Moves RSS polling and storage to backend cron jobs and new database tables.
   - *Cons:* Requires backend deployment/migrations and prevents local/guest mode users from subscribing to or refreshing feeds offline/locally.

---

## 4. Technical Architecture & Data Contracts

### 4.1 Podcast Service (`src/services/podcast-service.js`)
A dedicated, unit-tested ES module responsible for:
1. **Podcast Discovery (`searchPodcasts(query, options)`):**
   - Queries `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=15&term=<encoded>` (with fallback handling).
   - Returns normalized search results: `{ id, title, author, feedUrl, coverUrl, genre, episodeCount }`.
2. **Multi-Tier CORS-Resilient RSS Fetching (`fetchPodcastFeedXml(feedUrl, options)`):**
   - **Tier 1 (Windows Tauri Desktop):** If `window.__TAURI_INTERNALS__` is available, invokes Tauri command `fetch_podcast_rss({ url: feedUrl })` so Windows `.exe` fetches any RSS feed natively without browser CORS limits.
   - **Tier 2 (Direct Fetch):** Attempts direct `fetch(feedUrl, { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } })` (works for CORS-enabled hosts like Anchor/Spotify, Transistor, Pinecast, Megaphone, etc.).
   - **Tier 3 (CORS Proxy Fallback for Web / PWA / Android WebView):** Falls back sequentially to `https://api.allorigins.win/raw?url=<encoded>` and `https://corsproxy.io/?url=<encoded>` so any RSS feed loads reliably in Chrome PWA and Android WebView.
3. **Pure JS RSS 2.0 / Atom / iTunes XML Parser (`parsePodcastRssXml(xmlText, feedUrl)`):**
   - Works in both browser (`DOMParser`) and Node.js unit test environments (regex/lightweight tag parser fallback so `node --test` runs with zero external npm dependencies).
   - Extracts show metadata: `title`, `author` (`<itunes:author>` / `<author>` / `<managingEditor>`), `description` (stripped of HTML tags & decoded entities), `coverUrl` (`<itunes:image href="...">` / `<image><url>`).
   - Extracts episodes (capped at the latest 50 episodes per feed to keep localStorage and Supabase payloads fast and compact):
     - Extracts `<enclosure url="..." type="..." length="..." />`.
     - Parses `<itunes:duration>` (`HH:MM:SS`, `MM:SS`, or raw seconds integer) into `durationSec` (defaulting to `1800` until `loadedmetadata` refines it).
     - Parses `<guid>` (or enclosure URL fallback) into stable `episodeId`.
     - Parses `<pubDate>` into ISO string `publishedAt`.
     - Sanitizes `<description>` / `<itunes:summary>` into clean plain text `description`.
4. **Podcast Item Normalization (`createPodcastBookItem(parsedFeed, existingBook)`):**
   - Produces a library item compatible with `app.js`, `AudioEngine`, and `SupabaseSyncService`:
     ```js
     {
       bookKey: `podcast:${hashFeedUrl(feedUrl)}`,
       title: parsedFeed.title,
       author: parsedFeed.author || 'Podcast',
       narrator: parsedFeed.author || 'Podcast Host',
       series: '', // Never grouped into book franchises
       description: parsedFeed.description,
       coverUrl: parsedFeed.coverUrl,
       isPodcast: true,
       mediaType: 'podcast',
       feedUrl: parsedFeed.feedUrl,
       lastFeedRefreshAt: new Date().toISOString(),
       sources: ['podcast'],
       source: 'podcast',
       chapterIndex: preservedChapterIndex,
       positionSec: preservedPositionSec,
       totalDurationSec: sumOfEpisodeDurations,
       chapters: episodes.map((ep, idx) => ({
         index: idx,
         title: ep.title,
         startSec: 0,
         durationSec: ep.durationSec,
         episodeId: ep.episodeId,
         audioUrl: ep.audioUrl,
         driveStreamUrl: ep.audioUrl, // Compatible with AudioEngine stream resolution
         publishedAt: ep.publishedAt,
         description: ep.description
       }))
     }
     ```
   - Preserves the user's current active episode (`episodeId` -> updated `chapterIndex`) and `positionSec` when new episodes prepend to index `0`!

### 4.2 Per-Episode Streaming, Progress Memory & Offline Downloads (`src/player/audio-engine.js`)
- Extend `_isMultiFileChapters(chapters)` to return `true` whenever `this.currentBook?.isPodcast` is `true` or any chapter has `ch?.audioUrl` or `ch?.episodeId` (even if a feed has only 1 episode).
- In `loadBook()` and `setChapter()`, when `book.isPodcast` or `_isMultiFileChapters(book.chapters)` is true, initialize `this.durationSec` from the active chapter/episode (`Number(book.chapters?.[this.chapterIndex]?.durationSec) || 1800`) rather than the sum of all 50 episodes.
- Maintain a per-episode progress map on podcast items (`book.episodeProgress = { [episodeId]: { positionSec, durationSec, completed, updatedAt } }`) so switching between episodes of a show remembers the exact resume timestamp and played checkmark for every individual episode.
- Extend `_resolveChapterMediaUrl(book, chapterIndex)`:
  - Checks per-episode offline cache key `${book.bookKey}::${ch.episodeId || ch.driveFileId || chapterIndex}` in IndexedDB first. If cached, plays the offline `Blob` via `URL.createObjectURL(cached.blob)` with zero network traffic.
  - Otherwise streams `ch.audioUrl || ch.driveStreamUrl` directly in HTML5 `<audio>`.
- Add per-episode offline cache methods:
  - `cacheEpisodeOffline(book, chapterIndex)`: downloads the episode audio (`ch.audioUrl`, with CORS-proxy fallback if direct `fetch` is blocked by the podcast CDN), stores the `Blob` in IndexedDB under `${book.bookKey}::${ch.episodeId || chapterIndex}`, marks `ch.offlineCached = true`, and updates `book.hasOfflineEpisodes` / `book.offlineCached`.
  - `removeEpisodeOffline(book, chapterIndex)`: deletes that episode's cached `Blob` from IndexedDB and clears `ch.offlineCached`.
  - `isEpisodeCachedOffline(bookKey, episodeId)`: checks whether a specific episode is saved offline.

### 4.3 UI & Interaction Additions (`src/ui/app.js` & `src/ui/icons.js`)
- **3D Podcast Badge (`FLUENT_3D_PODCAST` in `src/ui/icons.js`):** Crisp 3D vector SVG microphone/broadcast icon matching `FLUENT_3D_FOLDER` and `FLUENT_3D_CLOUD`.
- **Filter Chips:**
  - Desktop Sidebar & Mobile Header filters: `All`, `Local`, `Drive`, `Podcasts`, `Saved`.
  - `+ Podcast` button opens the **Podcast Discovery & RSS Modal** (`this.state.podcastModal`).
- **"New Episodes" Home Shelf:**
  - When 1+ podcasts are subscribed, displays up to 8 recent episodes across subscribed shows on Home (`All` or `Podcasts` filter).
  - Clicking an episode card starts streaming that exact episode immediately; clicking the download icon on the card/row downloads that episode for offline use.
- **Podcast Show Detail View (Desktop & Mobile Sheet):**
  - Displays show cover, host, description, **Refresh** button, **Unsubscribe** button, and the episode list.
  - Each episode row shows episode title, relative publish date (`Today`, `3d ago`, `Nov 12`), duration, per-episode **Download / Offline Saved** button, and expandable show notes.
- **Auto-Refresh Lifecycle:**
  - On app initialization (after library restore) and every `30 minutes` (`setInterval`), silently refreshes subscribed podcast feeds in the background, updates episodes while preserving the currently playing episode index/timestamp, and persists to `localStorage` (`audiobook_podcasts_v1`) + Supabase sync.

### 4.4 Cross-Device Sync & Native Windows / Android Bridges
- **Supabase Sync (`src/services/supabase-sync.js`):**
  - Include `isPodcast`, `mediaType`, `feedUrl`, and `lastFeedRefreshAt` inside `metadata_json` in `_normalizeLibraryItemForCloud` and `normalizeCloudBook` so subscribing on Windows automatically syncs the podcast subscription to Android (and vice versa).
- **Windows Tauri Native Command (`src-tauri/src/main.rs`):**
  - Register `#[tauri::command] fn fetch_podcast_rss(url: String) -> Result<String, String>` allowing `https://` / `http://` RSS URLs to be fetched natively from Rust on Windows without WebView CORS issues.
