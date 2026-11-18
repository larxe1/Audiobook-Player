/**
 * MediaSessionBridge — Integrates browser MediaSession API (Android Notification
 * Shade MediaStyle, Samsung Galaxy Watch Wear OS Media Controller, and Android Auto)
 * plus Bluetooth / audio output devicechange auto-pause & timestamp persistence.
 */

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildFallbackArtworkDataUrl(book) {
  const title = escapeXml((book?.title || 'Audiobook').slice(0, 22));
  const c1 = book?.accentHex || '#1e3a8a';
  const c2 = book?.accentSecondaryHex || '#0b1020';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
    <rect width="512" height="512" rx="48" fill="url(#g)"/>
    <text x="40" y="430" fill="#ffffff" font-family="system-ui,sans-serif" font-size="38" font-weight="700">${title}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const WIRED_PRIORITY_KEYWORDS = [
  'wired',
  '3.5mm',
  'aux',
  'usb audio',
  'realtek hd audio 2nd output'
];

const BLUETOOTH_KEYWORDS = [
  'bluetooth',
  'airpods',
  'buds',
  'sony',
  'bose',
  'hands-free'
];

const WIRED_DEVICE_KEYWORDS = [
  'headphone',
  'wired',
  'headset',
  '3.5mm',
  'aux',
  'usb audio',
  'earphone',
  'realtek hd audio 2nd output'
];

function stripDevicePrefix(rawLabel = '') {
  return String(rawLabel || '')
    .trim()
    .replace(/^(default|communications)\s*-\s*/i, '')
    .trim();
}

function cleanBluetoothName(strippedLabel = '') {
  let cleaned = strippedLabel
    .replace(/\((?:hands-free(?:\s+ag\s+audio)?|stereo|avrcp[^)]*)\)/gi, '')
    .replace(/^(?:headphones?|headset)\s*\((.+)\)$/i, '$1')
    .replace(/\bhands-free(?:\s+ag\s+audio)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
    .trim();

  if (!cleaned || /^bluetooth(\s+audio)?$/i.test(cleaned)) {
    return 'Bluetooth';
  }
  return cleaned;
}

export function classifyAudioOutputDevice(device) {
  const rawLabel = String(device?.label || '').trim();
  const stripped = stripDevicePrefix(rawLabel);
  const lower = stripped.toLowerCase();

  if (WIRED_PRIORITY_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { label: 'Wired', category: 'wired', rawLabel };
  }

  if (BLUETOOTH_KEYWORDS.some((kw) => lower.includes(kw))) {
    return {
      label: cleanBluetoothName(stripped),
      category: 'bluetooth',
      rawLabel
    };
  }

  if (WIRED_DEVICE_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { label: 'Wired', category: 'wired', rawLabel };
  }

  if (
    !stripped ||
    /^(default|speakers?|system(\s+audio)?|internal(\s+speakers?)?|built-in(\s+output)?)$/i.test(stripped)
  ) {
    return { label: 'System Audio', category: 'system', rawLabel };
  }

  if (/speakers?/i.test(stripped) && /realtek|high definition audio/i.test(stripped)) {
    return { label: 'System Audio', category: 'system', rawLabel };
  }

  return { label: stripped, category: 'system', rawLabel };
}

export class MediaSessionBridge {
  constructor(options = {}) {
    this.onPlay = options.onPlay || (() => {});
    this.onPause = options.onPause || (() => {});
    this.onSeekBackward = options.onSeekBackward || (() => {});
    this.onSeekForward = options.onSeekForward || (() => {});
    this.onPreviousTrack = options.onPreviousTrack || (() => {});
    this.onNextTrack = options.onNextTrack || (() => {});
    this.onSeekTo = options.onSeekTo || (() => {});
    this.onAutoPause = options.onAutoPause || (() => {});
    this.onAndroidAutoChange = options.onAndroidAutoChange || (() => {});
    this.onAudioOutputChange = options.onAudioOutputChange || (() => {});

    this.knownAudioOutputs = new Set();
    this.audioOutputs = [];
    this.selectedOutputDeviceId = 'default';
    this.activeOutput = { deviceId: 'default', label: 'System Audio', category: 'system', rawLabel: '' };
    this.androidAutoConnected = false;
    this._boundDeviceChange = null;
    this._boundVisibility = null;
    this._boundPageHide = null;

    this._registerHandlers();
    this._bindDeviceListeners();
  }

  _registerHandlers() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const actions = [
      ['play', () => this.onPlay()],
      ['pause', () => this.onPause()],
      ['seekbackward', (details) => this.onSeekBackward(details?.seekOffset || 15)],
      ['seekforward', (details) => this.onSeekForward(details?.seekOffset || 30)],
      ['previoustrack', () => this.onPreviousTrack()],
      ['nexttrack', () => this.onNextTrack()],
      ['seekto', (details) => {
        if (typeof details?.seekTime === 'number') {
          this.onSeekTo(details.seekTime);
        }
      }]
    ];

    for (const [action, handler] of actions) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Some browsers do not support all MediaSession action types
      }
    }
  }

  _syncOutputDevices(devices = [], notifyAutoPause = false) {
    const rawOutputs = (Array.isArray(devices) ? devices : []).filter(
      (d) => d && d.kind === 'audiooutput'
    );
    const currentIds = new Set(rawOutputs.map((d) => d.deviceId));

    if (notifyAutoPause && this.knownAudioOutputs.size > 0) {
      let disconnected = false;
      for (const prevId of this.knownAudioOutputs) {
        if (!currentIds.has(prevId)) {
          disconnected = true;
          break;
        }
      }
      if (disconnected) {
        this.onPause();
        this.onAutoPause('bluetooth_disconnect');
      }
    }

    this.knownAudioOutputs = currentIds;

    const defaultRaw = rawOutputs.find((d) => d.deviceId === 'default') || rawOutputs[0] || null;
    const defaultStripped = defaultRaw ? stripDevicePrefix(defaultRaw.label).toLowerCase() : '';

    const seenLabels = new Set();
    const cleanOutputs = [];

    for (const dev of rawOutputs) {
      if (dev.deviceId === 'communications') continue;
      const stripped = stripDevicePrefix(dev.label).toLowerCase();
      if (dev.deviceId !== 'default' && defaultStripped && stripped === defaultStripped) {
        continue;
      }
      const dedupeKey = stripped || dev.deviceId;
      if (seenLabels.has(dedupeKey) && dev.deviceId !== 'default') continue;
      seenLabels.add(dedupeKey);

      const classified = classifyAudioOutputDevice(dev);
      cleanOutputs.push({
        deviceId: dev.deviceId,
        label: classified.label,
        category: classified.category,
        rawLabel: classified.rawLabel,
        isDefault: dev.deviceId === 'default'
      });
    }

    this.audioOutputs = cleanOutputs;

    const selectedRaw =
      this.selectedOutputDeviceId && this.selectedOutputDeviceId !== 'default'
        ? rawOutputs.find((d) => d.deviceId === this.selectedOutputDeviceId)
        : null;

    const effectiveRaw = selectedRaw || defaultRaw;
    if (!selectedRaw) {
      this.selectedOutputDeviceId = effectiveRaw?.deviceId || 'default';
    }

    if (effectiveRaw) {
      const classified = classifyAudioOutputDevice(effectiveRaw);
      this.activeOutput = {
        deviceId: effectiveRaw.deviceId,
        label: classified.label,
        category: classified.category,
        rawLabel: classified.rawLabel
      };
    } else {
      this.activeOutput = {
        deviceId: 'default',
        label: 'System Audio',
        category: 'system',
        rawLabel: ''
      };
    }

    this.onAudioOutputChange(this.getAudioOutputState());
    return this.getAudioOutputState();
  }

  async refreshAudioOutputs() {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.enumerateDevices !== 'function'
    ) {
      return this.getAudioOutputState();
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return this._syncOutputDevices(devices, false);
    } catch {
      return this.getAudioOutputState();
    }
  }

  getAudioOutputState() {
    return {
      activeDeviceId: this.activeOutput.deviceId,
      activeLabel: this.activeOutput.label,
      activeCategory: this.activeOutput.category,
      devices: this.audioOutputs.slice()
    };
  }

  selectAudioOutput(deviceId) {
    if (!deviceId) return this.getAudioOutputState();
    this.selectedOutputDeviceId = deviceId;
    const match = this.audioOutputs.find((d) => d.deviceId === deviceId);
    if (match) {
      this.activeOutput = {
        deviceId: match.deviceId,
        label: match.label,
        category: match.category,
        rawLabel: match.rawLabel
      };
    }
    this.onAudioOutputChange(this.getAudioOutputState());
    return this.getAudioOutputState();
  }

  _bindDeviceListeners() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      if (typeof navigator.mediaDevices.enumerateDevices === 'function') {
        navigator.mediaDevices
          .enumerateDevices()
          .then((devices) => this._syncOutputDevices(devices, false))
          .catch(() => {});
      }

      this._boundDeviceChange = async () => {
        try {
          if (typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
          const devices = await navigator.mediaDevices.enumerateDevices();
          this._syncOutputDevices(devices, true);
        } catch {
          // Ignore permission errors in restricted contexts
        }
      };

      if (typeof navigator.mediaDevices.addEventListener === 'function') {
        navigator.mediaDevices.addEventListener('devicechange', this._boundDeviceChange);
      }
    }

    if (typeof document !== 'undefined') {
      this._boundVisibility = () => {
        if (document.visibilityState === 'hidden') {
          this.onAutoPause('background_checkpoint');
        }
      };
      document.addEventListener('visibilitychange', this._boundVisibility);
    }

    if (typeof window !== 'undefined') {
      this._boundPageHide = () => {
        this.onAutoPause('pagehide');
      };
      window.addEventListener('pagehide', this._boundPageHide);

      // Detect Android Auto projection flag injected by Capacitor native bridge or query param
      const params = new URLSearchParams(window.location.search || '');
      if (params.get('androidAuto') === '1' || window.__ANDROID_AUTO_CONNECTED__ === true) {
        this.setAndroidAutoConnected(true);
      }
    }
  }

  setAndroidAutoConnected(connected) {
    const next = Boolean(connected);
    if (this.androidAutoConnected !== next) {
      this.androidAutoConnected = next;
      this.onAndroidAutoChange(next);
    }
  }

  isAndroidAutoConnected() {
    return this.androidAutoConnected;
  }

  simulateBluetoothDisconnect() {
    this.onPause();
    this.onAutoPause('bluetooth_disconnect');
  }

  updateMetadata(book, chapterTitle = '') {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !book) return;
    const ms = navigator.mediaSession;
    const artSrc = book.coverUrl || buildFallbackArtworkDataUrl(book);

    const artwork = [
      { src: artSrc, sizes: '96x96', type: 'image/png' },
      { src: artSrc, sizes: '192x192', type: 'image/png' },
      { src: artSrc, sizes: '512x512', type: 'image/png' }
    ];

    const albumLabel = chapterTitle
      ? `${book.series || book.title} — ${chapterTitle}`
      : book.series || 'Audiobook Player';

    try {
      if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({
          title: book.title || 'Audiobook Player',
          artist: book.author || 'Unknown Author',
          album: albumLabel,
          artwork
        });
      }
    } catch {
      // ignore environments without MediaMetadata constructor
    }
  }

  updatePlaybackState({ playing, positionSec = 0, durationSec = 0, playbackRate = 1.0 }) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.playbackState = playing ? 'playing' : 'paused';
    } catch {
      // ignore
    }

    if (typeof ms.setPositionState === 'function' && durationSec > 0) {
      try {
        const safePos = Math.max(0, Math.min(durationSec, Number(positionSec) || 0));
        ms.setPositionState({
          duration: Number(durationSec),
          playbackRate: Number(playbackRate) || 1.0,
          position: safePos
        });
      } catch {
        // ignore invalid position state
      }
    }
  }

  destroy() {
    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      this._boundDeviceChange &&
      typeof navigator.mediaDevices.removeEventListener === 'function'
    ) {
      navigator.mediaDevices.removeEventListener('devicechange', this._boundDeviceChange);
    }
    if (typeof document !== 'undefined' && this._boundVisibility) {
      document.removeEventListener('visibilitychange', this._boundVisibility);
    }
    if (typeof window !== 'undefined' && this._boundPageHide) {
      window.removeEventListener('pagehide', this._boundPageHide);
    }
  }
}
