/**
 * Clean vector SVG icons & Microsoft Fluent 3D source badges for Audiobook Player.
 * Zero standard text emojis are used anywhere in the UI.
 */

export const ICON_PLAY = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" class="${cls}" aria-hidden="true">
  <path d="M8 5.14v14l11-7-11-7z"/>
</svg>`;

export const ICON_PAUSE = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" class="${cls}" aria-hidden="true">
  <rect x="6" y="4" width="4.5" height="16" rx="1.2"/>
  <rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/>
</svg>`;

export const ICON_PREV = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" class="${cls}" aria-hidden="true">
  <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
</svg>`;

export const ICON_NEXT = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" class="${cls}" aria-hidden="true">
  <path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
</svg>`;

export const ICON_SKIP_BACK_15 = (size = 20, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
  <path d="M3 3v5h5"/>
  <text x="12" y="15.2" text-anchor="middle" fill="currentColor" stroke="none" font-size="7.4" font-weight="700" font-family="system-ui,sans-serif">15</text>
</svg>`;

export const ICON_SKIP_FORWARD_30 = (size = 20, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M21 12a9 9 0 1 1-3-6.7L21 8"/>
  <path d="M21 3v5h-5"/>
  <text x="12" y="15.2" text-anchor="middle" fill="currentColor" stroke="none" font-size="7.4" font-weight="700" font-family="system-ui,sans-serif">30</text>
</svg>`;

export const ICON_BOOKMARK = (size = 18, filled = false, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
</svg>`;

export const ICON_SEARCH = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <circle cx="11" cy="11" r="7.5"/>
  <path d="m20 20-3.5-3.5"/>
</svg>`;

export const ICON_HOME = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6.5h-5V21H4a1 1 0 0 1-1-1z"/>
</svg>`;

export const ICON_LIBRARY = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M4 19.5V4.5"/>
  <path d="M9.5 19.5V4.5"/>
  <path d="M15 5l5 14"/>
</svg>`;

export const ICON_COVER_IMAGE = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="3"/>
  <circle cx="8.5" cy="8.5" r="1.5"/>
  <path d="m21 15-5-5L5 21"/>
</svg>`;

export const ICON_CLOSE = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M18 6 6 18"/>
  <path d="m6 6 12 12"/>
</svg>`;

export const ICON_CHEVRON = (direction = 'right', size = 16, cls = '') => {
  const rotate =
    direction === 'left'
      ? 'rotate(180)'
      : direction === 'down'
        ? 'rotate(90)'
        : direction === 'up'
          ? 'rotate(-90)'
          : '';
  return `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="${cls}" style="transform:${rotate}" aria-hidden="true">
  <path d="m9 18 6-6-6-6"/>
</svg>`;
};

/**
 * Spotify 14px green downloaded arrow-in-circle SVG (replaces any "Offline" text badge).
 */
export const ICON_DOWNLOADED = (size = 14, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" class="${cls}" aria-label="Downloaded" role="img">
  <circle cx="8" cy="8" r="7.5" fill="#1ed760"/>
  <path d="M8 4.2v6.1M5.4 8l2.6 2.7L10.6 8" stroke="#060911" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const ICON_DOWNLOADED_CIRCLE = ICON_DOWNLOADED;

export const ICON_DOWNLOAD_CIRCLE = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <circle cx="12" cy="12" r="9"/>
  <path d="M12 8v7M9 12.5 12 15.5l3-3"/>
</svg>`;

export const ICON_SLEEP = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;

export const ICON_SPEAKER = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
</svg>`;

export const ICON_WATCH = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <circle cx="12" cy="12" r="6"/>
  <path d="M9 3h6l.7 3.2M9 21h6l.7-3.2M9 3l-.7 3.2M9 21l-.7-3.2"/>
</svg>`;

export const ICON_CAR = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M5 17h14v-5l-2-5H7L5 12v5z"/>
  <circle cx="7.5" cy="17.5" r="1.5"/>
  <circle cx="16.5" cy="17.5" r="1.5"/>
</svg>`;

export const ICON_SPARKLES = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>
  <path d="M19 3v3M20.5 4.5h-3"/>
</svg>`;

export const ICON_DEVICES = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <rect x="2" y="4" width="15" height="11" rx="2"/>
  <path d="M6 19h7"/>
  <rect x="16" y="9" width="6" height="11" rx="1.5"/>
</svg>`;

export const ICON_PANEL_RIGHT = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="2"/>
  <path d="M15 3v18"/>
</svg>`;

export const ICON_UPLOAD = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`;

export const ICON_REFRESH = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
  <path d="M3 3v5h5"/>
  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
  <path d="M16 16h5v5"/>
</svg>`;

/**
 * Microsoft Fluent 3D style Folder SVG for Local Folder source badges.
 */
export const FLUENT_3D_FOLDER = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" class="${cls}" aria-label="Local Folder" role="img">
  <defs>
    <linearGradient id="fldBack" x1="4" y1="4" x2="28" y2="24" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffd56b"/>
      <stop offset="100%" stop-color="#e58c19"/>
    </linearGradient>
    <linearGradient id="fldFront" x1="4" y1="10" x2="28" y2="28" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffe58f"/>
      <stop offset="55%" stop-color="#ffb938"/>
      <stop offset="100%" stop-color="#e38212"/>
    </linearGradient>
  </defs>
  <path d="M3 7.5C3 5.84 4.34 4.5 6 4.5h6.1c.9 0 1.75.4 2.32 1.1l1.28 1.55c.38.46.94.73 1.54.73H26c1.66 0 3 1.34 3 3v13.62c0 1.66-1.34 3-3 3H6c-1.66 0-3-1.34-3-3V7.5z" fill="url(#fldBack)"/>
  <rect x="5" y="8.5" width="22" height="4" rx="1.5" fill="#fff7dc" opacity="0.88"/>
  <path d="M2.5 12.2c0-1.49 1.21-2.7 2.7-2.7h21.6c1.49 0 2.7 1.21 2.7 2.7v12.1c0 1.77-1.43 3.2-3.2 3.2H5.7c-1.77 0-3.2-1.43-3.2-3.2V12.2z" fill="url(#fldFront)"/>
  <path d="M5.2 10h21.6c1.1 0 2 .65 2.4 1.55H2.8C3.2 10.65 4.1 10 5.2 10z" fill="#fff3c4" opacity="0.5"/>
</svg>`;

/**
 * Microsoft Fluent 3D style Cloud SVG for Google Drive Cloud source badges.
 */
export const FLUENT_3D_CLOUD = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" class="${cls}" aria-label="Google Drive" role="img">
  <defs>
    <linearGradient id="cldMain" x1="6" y1="6" x2="26" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#a8ecff"/>
      <stop offset="48%" stop-color="#48b7ff"/>
      <stop offset="100%" stop-color="#196be6"/>
    </linearGradient>
    <radialGradient id="cldGlow" cx="35%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <path d="M9.5 25.5h13.8c3.26 0 5.9-2.55 5.9-5.7 0-2.86-2.18-5.23-5.01-5.63C23.56 9.81 19.86 6.5 15.35 6.5c-4.7 0-8.57 3.55-8.98 8.08C3.78 15.17 2 17.42 2 20.08c0 3.01 2.52 5.42 5.65 5.42H9.5z" fill="url(#cldMain)"/>
  <circle cx="14.5" cy="13.5" r="7" fill="url(#cldGlow)"/>
  <path d="M7.8 25.5h15.5c2.9 0 5.3-2.1 5.7-4.8-.9 2-3 3.3-5.5 3.3H8.3c-2.8 0-5.1-1.6-5.9-3.9.4 3.05 2.7 5.4 5.4 5.4z" fill="#0d47a1" opacity="0.24"/>
</svg>`;

/**
 * Crisp vector podcast microphone with broadcast waves SVG icon.
 */
export const ICON_PODCAST = (size = 16, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="22"/>
  <line x1="8" y1="22" x2="16" y2="22"/>
</svg>`;

/**
 * Microsoft Fluent 3D style studio podcast microphone / broadcast badge SVG.
 */
export const FLUENT_3D_PODCAST = (size = 18, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" class="${cls}" aria-label="Podcast" role="img">
  <defs>
    <linearGradient id="podBg" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#a855f7"/>
      <stop offset="52%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#06b6d4"/>
    </linearGradient>
    <linearGradient id="podMic" x1="12" y1="6" x2="20" y2="20" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="60%" stop-color="#e2e8f0"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <linearGradient id="podAccent" x1="9" y1="14" x2="23" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="26" height="26" rx="8" fill="url(#podBg)"/>
  <path d="M7.5 11.5a10 10 0 0 1 0 7M24.5 11.5a10 10 0 0 0 0 7" stroke="#67e8f9" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>
  <rect x="12.2" y="6.5" width="7.6" height="12" rx="3.8" fill="url(#podMic)"/>
  <line x1="13.8" y1="10.2" x2="18.2" y2="10.2" stroke="#6366f1" stroke-width="1.2" stroke-linecap="round" opacity="0.55"/>
  <line x1="13.8" y1="12.8" x2="18.2" y2="12.8" stroke="#6366f1" stroke-width="1.2" stroke-linecap="round" opacity="0.55"/>
  <path d="M9.8 14.5v.8a6.2 6.2 0 0 0 12.4 0v-.8" stroke="url(#podAccent)" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M16 21.5v4M12.5 25.5h7" stroke="url(#podAccent)" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;
