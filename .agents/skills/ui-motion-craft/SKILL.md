---
name: ui-motion-craft
description: Enforces fluid, choreographed UI animations, entry/exit transitions, View Transitions, and uncluttered Spotify-style navigation across Windows Desktop and Android Mobile in Audiobook Player.
---

# UI Motion Craft & Intuitive Spotify Navigation

## Core Mandate
**Every UI interaction, view change, filter switch, modal/sheet/popover open AND close, and card reveal in Audiobook Player must be smoothly animated — never snappy or abrupt.**

## Required Motion & UX Techniques

1. **Exponential Ease-Out & Spring Tokens (`src/styles/theme.css`)**:
   - Use `--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)` and `--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`.
   - Timing tiers:
     - `140–180ms`: immediate button press/hover and exit transitions (exits must be faster than entrances).
     - `220–280ms`: filter chip transitions, view cross-fades, and popover scale-in/out.
     - `320–420ms`: full-screen mobile sheets, modal dialogs, and staggered card grid reveals.

2. **Progressive View Transitions (`document.startViewTransition`)**:
   - When switching primary views (`desktopView: 'home' <-> 'detail'`, `filterSource` changes, sidebar/right-panel collapse, or series folder toggle) and the user is NOT actively typing in a text input, wrap DOM updates in `document.startViewTransition` with smooth `::view-transition-old(root)` / `::view-transition-new(root)` cross-fade and spatial slide, and preserve/route focus after completion.

3. **Entry (`@starting-style`) AND Exit (`[data-closing]`) Animations for Overlays**:
   - Never rip modals, sheets, notification shades, or popovers out of the DOM in `0ms` with `slotEl.innerHTML = ''`.
   - Use `@starting-style` + keyframe entrance on mount, and on close in browser contexts apply `data-closing` on the backdrop/modal so its `180ms` fade + scale/slide exit completes smoothly before clearing the slot.

4. **Staggered Card & List Choreography (`.ui-stagger-item`, `.ui-view-enter`)**:
   - Apply `--stagger-idx` (capped at `8` items / `240ms` max total delay) to quick-resume grids, `"New Episodes"` shelves, library lists, and Podcast Finder search results so content cascades in fluidly instead of popping in abruptly.

5. **Case-by-Case `prefers-reduced-motion: reduce`**:
   - Never apply a global `*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }` rule, which makes state changes jarring.
   - Instead, inside `@media (prefers-reduced-motion: reduce)`, dampen spatial movement (`translate: none; transform: none;`) while preserving gentle opacity and color transitions (`120ms`).

6. **Uncluttered Header & Intuitive Podcast Discovery**:
   - Keep `Devices` inside the Profile Avatar popover menu (never as a standalone icon button in the Mobile top bar or Desktop transport bar eating horizontal space).
   - Keep Podcast discovery unmistakable: provide an inline Podcast Search & Category Hub right at the top of the `Podcasts` view (even when shows are already followed), a prominent `Discover Podcasts` button next to the main search bar on Desktop, and a pinned/accessible trigger on Mobile.
