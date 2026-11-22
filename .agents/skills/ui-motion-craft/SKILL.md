---
name: ui-motion-craft
description: Unified Design, UX, Progressive Disclosure, True Black Palette, Context Menus, Zero-Blink DOM Updates, and Fluid Motion Craft across Windows Desktop and Android Mobile in MultiPlayer.
---

# MultiPlayer — Unified Design, UX & Motion Craft

## Core Mandate
**Every UI interaction in MultiPlayer must feel intentional, uncluttered, and completely seamless across Windows Desktop and Android Mobile — zero abrupt DOM pops, zero selection blinks, zero keyboard pop-in/out on keystrokes, and zero header clutter.**

---

## 1. Visual System & True Black Default Canvas
- **True Black (`theme-amoled`, `#000000`) is the sole default theme** across `index.html` (`<body class="theme-amoled ...">`), `src/styles/theme.css` (`:root`), Capacitor/Android system bars (`#000000`), Tauri main window background (`#000000`), and `_loadTheme()` (auto-migrating any legacy `'pitch'` or `'midnight'` preference in `localStorage` to `'amoled'`).
- Do **not** offer or fall back to legacy `'pitch'` or `'midnight'` theme options in Settings or Profile.
- **Zero default row/card icon clutter**: Never render cloud (`☁️`) or folder badges on library rows/cards. Render **only** a crisp green checkmark (`ICON_OFFLINE_CHECK`) when an item is genuinely saved offline.

---

## 2. Progressive Disclosure & Uncluttered Navigation
- **2-Way Library Division**: Keep the main library filter cleanly divided into **`Audiobooks`** and **`Podcasts`** (no `Local`, `Drive`, `Downloaded`, or `Series` toggle pills).
- **Series Folders Collapsed by Default**: Keep series grouping always active, with all series folders collapsed/compressed by default until explicitly expanded by the user.
- **Tuck Rarely Used Actions into `Settings > Advanced Settings`**:
  - Keep `Devices` and `Settings` in the Profile Avatar menu (never place standalone `Devices` or `Wipe` buttons in the Mobile header or Desktop transport bar).
  - Tuck `Add Local Folder`, `Add Audio Files`, `Sync Google Drive`, `Search Cover Images`, `Auto-Match Tags`, and `Wipe Synced Files` inside **`Settings > Advanced Settings`** rather than crowding the Profile popover or library headers.
- **No Inline Notification Shade Toggle**: Do not place a `>` notification-shade toggle in the mobile top header; the mini/shade player lives in the OS notification bar and bottom transport bar.
- **Compact Continue Listening Pill**: Render the remote handoff prompt as a compact single-line pill whose `X` dismissal persists in `localStorage` by `deviceId:bookKey` (immune to heartbeat timestamps and page reloads).

---

## 3. Unified `🔍` Search & Android Keystroke Stability
- Use a unified **`🔍` Search** trigger and modal with filter pills: **`All`**, **`Audiobooks`**, and **`Podcasts to Follow`**.
- **In-Place Results Updates (No Keyboard Pop-In/Out)**: When typing in `#podcastSearchInput` or transitioning `loading: true -> false`, update **only** the inner results region (`#searchModalResultsRegion`) when the modal is already open. Never replace the `<input>` DOM node or `.modal-backdrop` on keystrokes.

---

## 4. Dual-Input Context Menus (PC Right-Click + Android Long-Press)
- Every library item (audiobook row/card, series folder, podcast show) must support **both** desktop `contextmenu` (right-click) and mobile ~480ms touch `long-press` (with scroll-movement cancellation, `-webkit-touch-callout: none` / `user-select: none`, and click suppression after opening).
- **Podcast actions**: `Unfollow Podcast`, `Refresh Episodes`, `Mark All Played`, `Download / Remove Offline`.
- **Audiobook / Series actions**: `Play / Resume`, `Save Offline / Remove Offline Copy`, `Mark Finished / Reset Progress`, `Edit Info / Search Cover / Auto-Match Tags`, `Remove from Library`.

---

## 5. Fluid Motion & Zero-Blink DOM Craft
1. **Exponential Ease-Out & Spring Tokens (`src/styles/theme.css`)**:
   - Use `--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)` and `--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`.
   - Timing tiers:
     - `140–180ms`: immediate button press/hover and exit transitions (exits must be faster than entrances).
     - `220–280ms`: filter chip transitions, view cross-fades, and popover/context-menu scale-in/out.
     - `320–420ms`: full-screen mobile sheets, modal dialogs, and staggered card grid reveals.
2. **Zero-Blink Same-View Updates**:
   - Track the current main view signature (`desktopView:filterSource:mobileSheetOpen`).
   - Only run `.ui-view-enter`, `.ui-stagger-item`, and `document.startViewTransition` when genuinely switching primary views or tabs (e.g., `Home <-> Detail`, `Audiobooks <-> Podcasts`) and when NOT typing in an input.
   - On same-view state updates (selecting a book, toggling play/pause, toggling a series folder, progress ticks), strip entrance animations (`_applyNoEnterAnimHtml`) and skip `startViewTransition` so cover artwork and cards **never** flash or blink to `opacity: 0` on Android WebView.
3. **Entry (`@starting-style`) AND Exit (`[data-closing]`) Animations for Overlays**:
   - Never rip modals, sheets, context menus, or popovers out of the DOM in `0ms` with `slotEl.innerHTML = ''`.
   - Use `@starting-style` + keyframe entrance on mount, and on close apply `data-closing` so its `180ms` fade + scale/slide exit completes smoothly before clearing the slot.
4. **Case-by-Case `prefers-reduced-motion: reduce`**:
   - Never apply a global `*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }` rule.
   - Inside `@media (prefers-reduced-motion: reduce)`, dampen spatial movement (`translate: none; transform: none;`) while preserving gentle opacity and color transitions (`120ms`).
5. **Hardware Back Button & Explicit `X` Close Controls**:
   - Every modal, full-screen player sheet, and detail view must have a clear `X` close button, and Android Back (`window.__audiobookApp.handleBackPress()` + `popstate`) must close open overlays/sheets/detail views in priority order before requiring a second press (`"Press back again to exit"`) at the root screen.
