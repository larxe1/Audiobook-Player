# Audiobook Player — System & Product Design Specification

**Date:** 2026-11-18  
**App Name:** `Audiobook Player`  
**Target Platforms:** Android (Primary — Installable PWA + Capacitor Android `.apk` with Android Auto support) & Windows Desktop (Standalone Tauri `.exe` + Web UI)

---

## 1. Intent & Why
Build a personal, cross-platform **Audiobook Player** modeled after Spotify's modern Web and Mobile experience where:
- **Google Drive** serves as the primary cloud audiobook library (streaming `.m4b`, `.mp3`, `.m4a`, `.ogg`, and `.flac` files directly without requiring full upfront downloads, while also supporting 1-click full offline downloads).
- **Local device folders** work seamlessly alongside Google Drive on both Android and Windows, with **automatic deduplication** when the same audiobook exists in both Local storage and Google Drive.
- **Cross-device playback sync & live device handoff ("Spotify Connect" style)** allow the user to sign in with **Gmail**, listen on their Android phone (or in the car on **Android Auto**), pause, and immediately resume from the exact second on their Windows PC — or remotely pause one device when starting playback on another.
- **Offline playback** queues timestamp progress and bookmarks locally when driving or disconnected, and automatically reconciles and syncs to the cloud in the background as soon as connectivity returns.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
1. **Minimalist Spotify Dark UI & Zero-Handholding Copy Philosophy:**
   - Deep dark-mode-first palette (`#060607` canvas, `#101012` panels, `#151518` cards, `#1ed760` accent, and dynamic cover-art ambient glow) with smooth spring/cubic-bezier animations (`cubic-bezier(0.22, 1, 0.36, 1)`).
   - **Less is Better (Treat the User as Intelligent):**
     - Zero instructional subtitles next to section headings (`"Jump back in"` and `"Library"` stand alone with no explanatory captions).
     - Zero verbose status banners (`"Synced across devices"`, `"Offline Ready • No Mobile Data Needed"`, `"Auto-saves timestamp"`, or `"Remote Sync: Paused..."` are strictly forbidden).
     - Zero sub-labels under self-explanatory buttons (`-15s`, `+30s`, Play/Pause, and Bookmark icons need no sub-captions).
     - Replace `"Offline"` text pills with Spotify's compact **`14px` green downward-arrow-in-circle icon** next to the time remaining.
     - Enforce strict text containment (`min-w-0`, `overflow-hidden`, `truncate`, `line-clamp-2`) on every card, cover thumbnail, and row so long titles (e.g., *The Fellowship of the Ring*) never overflow outside their container.
   - **Iconography Discipline:** Zero standard text emojis in UI labels. Use crisp vector SVG icons for all controls, and use **Microsoft Fluent 3D Emoji** style 3D icons strictly for compact source badges (**Local Folder** vs. **Google Drive Cloud**).
2. **Gmail Profile Avatar & Nested Settings / Sync Menu:**
   - The top-right profile button displays the user's actual **Gmail profile photo** (`picture` from Google OAuth) to save header space.
   - Clicking the Gmail profile avatar opens a compact **Profile & Settings Popover** housing:
     - Account identity + subtle 3D Fluent Cloud sync status
     - Connected Devices & active playback transfer
     - Library Folder management (Google Drive folder + Local folders)
     - Auto-Match Metadata & Cover Art tools
     - App Settings
3. **Dual Responsive Layout + Android Notification Mini-Player + Galaxy Watch (Wear OS) + Conditional Android Auto Mode:**
   - **Theme Support:** **Midnight Black** (`#060911` canvas, `#0d1322` panel, `#131b2e` card) is the default theme, with a toggle in the Profile menu to switch between **Midnight Black** and **Pitch Black** (`#050506` canvas, `#101012` panel, `#161619` card) anytime.
   - **Android Mobile View (Primary):** Minimal filter chips + Gmail avatar on top, 2-column quick-resume grid, "Jump back in" carousel, "Library" list, floating Mini-Player bar, and slide-up Full-Screen Now Playing sheet.
   - **Android Pull-Down Notification Shade Mini-Player (`MediaStyle` / `MediaSession`):**
     - Publishes rich Android 13/14/15 `MediaStyle` notifications with book cover art tint, interactive seek bar, Play/Pause FAB, `-15s` / `+30s` / Bookmark custom action buttons, and audio output device routing pill.
   - **Samsung Galaxy Watch (Wear OS) Integration:**
     - **Automatic Wear OS Media Controls:** Full Android `MediaSession` metadata + custom actions (`-15s`, `+30s`, `Bookmark`, hardware rotating bezel volume) automatically power the Galaxy Watch built-in Media Controller and auto-launch watch tile while playing.
     - **Circular Wear OS Companion / Web Tile View:** Dedicated circular `270×270` watch layout with a faded full-watch cover-art gradient backdrop, compact `24×24px` mini cover thumbnail pill next to the title, bezel progress ring, `-15s`, `Play/Pause`, `+30s`, playback speed cycler, and 1-tap Bookmark.
   - **Android Auto Car Mode (Only Visible When Android Auto is Connected):**
     - Car Mode UI is completely hidden during normal phone/desktop usage and activates automatically **only when Android Auto is connected** (or via native Android Auto head-unit projection through `MediaBrowserServiceCompat` + `MediaSession`).
     - Features clean cover art, title/chapter, progress bar, and 4 oversized touch buttons (`-15s`, `Play/Pause`, `+30s`, `Bookmark`) with zero redundant helper text.
   - **Windows Desktop View:** Spotify Web 3-column layout (collapsible "Your Library" left sidebar, main feed with quick-resume grid + shelves + book/chapter detail view, toggleable right "Now Playing" panel, and bottom transport bar).
4. **Automatic File Tag Extraction + Online Audiobook Metadata Lookup:**
   - **Primary (Embedded Audio Tags):** Automatically parses ID3v2 (`.mp3`) and MP4/iTunes atoms (`.m4b` / `.m4a`) from local files or Google Drive HTTP Range headers (`bytes=0-131071`) to extract Title, Author, Narrator, Series, Year, Synopsis, Chapter list (`chpl`/`CHAP`), and embedded Cover Art (`covr`/`APIC`).
   - **Secondary (Automatic Online Metadata Completion):** When file tags are missing or incomplete, automatically queries audiobook & book metadata APIs (**iTunes Search API `media=audiobook`**, **Audnexus API `api.audnex.us`**, **Google Books API**, and **Open Library API** — since Goodreads shut down its public developer API) to populate Narrator, Author, Series, Description, and high-res square cover art.
5. **Built-in Cover Image Search Picker (Online Image Search + Manual Upload):**
   - When a book lacks cover art (or when the user clicks the cover / `Search Cover`), an in-app **Cover Image Search Modal** searches **Google Images (via Custom Search / image proxy) + iTunes Audiobook Artwork + Google Books + Open Library Covers** using the book's title/author, displays a visual grid of candidate covers for the user to pick from, and downloads + saves the selected image as the book's cover (alongside manual file upload).
6. **Smart Duplicate Deduplication (Local + Google Drive Merged):**
   - If the same audiobook exists in both a **Local Folder** and **Google Drive** (matched via normalized `Title + Author` or filename/duration signature), the library merges them into **one unified book entry** displaying both the 3D Folder and 3D Cloud badges.
   - Playback automatically prioritizes the **Local file** when present on that device (instant scrubbing, zero mobile data), while syncing progress and bookmarks to the shared `book_key`.

### Non-Goals
- Public social network or multi-tenant commercial storefront.
- DRM decryption of proprietary `.aax` files inside the player.

### Anti-Goals (What Would Make This a Failure)
- Over-explaining UI features with helper sentences, subtitles on headings, or `"Offline"` / `"Synced"` text banners.
- Text overflowing outside book cover cards or wrapping into cramped multi-line collisions.
- Showing duplicate cards when the same audiobook is present in both Local storage and Google Drive.
- Showing Car Mode tabs/buttons when Android Auto is not connected.

---

## 3. Architectural Approaches & Backend Selection

- **Platform Packaging (Option 3 Selected):** Single shared UI codebase packaged into both an **Android `.apk` (Capacitor + Native Android Auto `MediaBrowserServiceCompat`)**, an installable **PWA**, and a **Windows Desktop `.exe` (Tauri)**.
- **Sync & Cloud Backend (Plan A Selected):**
  - **Target Supabase Project:** Existing `Wallet` project (`ref: ycokzejqpenvlamvzhrm`, region `ap-south-1`), strictly isolated using `audiobook_*` table prefixes (`audiobook_progress`, `audiobook_bookmarks`, `audiobook_devices`, `audiobook_library_items`) with Row-Level Security so existing `Wallet` tables are untouched.
  - **Google Drive API v3:** Streams audio files via HTTP Range requests and backs up `.audiobook-sync.json` + custom downloaded cover art.
  - **Offline Sync Queue (`IndexedDB`):** Queues playback timestamps and bookmarks while offline and reconciles automatically upon reconnection without noisy UI banners.
