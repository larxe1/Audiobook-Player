/**
 * AudioEngine — Cross-platform audiobook playback engine.
 * Supports:
 * 1. Local File / Object URLs
 * 2. IndexedDB cached offline audio blobs
 * 3. Google Drive HTTP Range / Bearer stream URLs
 * 4. Built-in Web Audio API gentle ambient/cadence synthesizer fallback
 *    for sample/demo books without an attached physical audio file.
 */

const OFFLINE_DB_NAME = 'audiobook_player_offline_v1';
const OFFLINE_STORE = 'audio_blobs';
const STORAGE_VOLUME_KEY = 'audiobook_player_volume_v1';
const STORAGE_MUTED_KEY = 'audiobook_player_muted_v1';

function openOfflineDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(OFFLINE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
          db.createObjectStore(OFFLINE_STORE, { keyPath: 'bookKey' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const SLEEP_PRESETS = [0, 15, 30, 45, 'chapter'];

export class AudioEngine {
  constructor(options = {}) {
    this.onTimeUpdate = options.onTimeUpdate || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onChapterChange = options.onChapterChange || (() => {});
    this.onEnded = options.onEnded || (() => {});
    this.onSleepTimerUpdate = options.onSleepTimerUpdate || (() => {});
    this.onOfflineChange = options.onOfflineChange || (() => {});
    this.onError = options.onError || (() => {});
    this.onDriveTokenExpired = options.onDriveTokenExpired || null;
    this.fetchImpl = options.fetchFn || options.fetchImpl || null;
    this._hasCustomFetchFn = Boolean(options.fetchFn || options.fetchImpl);

    this._loadSeq = 0;
    this._activeLoadAbortController = null;
    this._pendingDirectDriveFallback = null;

    this.audio = typeof Audio !== 'undefined' ? new Audio() : null;
    if (this.audio) {
      this.audio.preload = 'metadata';
      this._bindAudioEvents();
    }

    this.currentBook = null;
    this.playing = false;
    this.playbackRate = 1.0;
    this.volume = this._loadVolume();
    this.muted = this._loadMuted();
    this.positionSec = 0;
    this.durationSec = 0;
    this.chapterIndex = 0;
    this.usingSynth = false;
    this.activeObjectUrl = null;
    this.driveAccessToken = null;
    this._applyAudioVolume();

    // Sleep timer state: 0 (off) | minutes number | 'chapter'
    this.sleepPresetIndex = 0;
    this.sleepTimerMode = 0;
    this.sleepRemainingSec = 0;

    // Virtual / Web Audio synth timer state
    this._tickTimer = null;
    this._lastTickMs = 0;
    this._audioCtx = null;
    this._synthNodes = null;
    this._memoryOfflineSet = new Set();
  }

  _bindAudioEvents() {
    if (!this.audio) return;

    this.audio.addEventListener('timeupdate', () => {
      if (this.usingSynth) return;
      this.positionSec = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        this.durationSec = this.audio.duration;
      }
      this._syncChapterFromPosition();
      this._saveCurrentEpisodeProgress();
      this.onTimeUpdate(this.getSnapshot());
    });

    this.audio.addEventListener('loadedmetadata', () => {
      if (this.usingSynth) return;
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        this.durationSec = this.audio.duration;
        const chapters = this.currentBook?.chapters;
        if (this._isMultiFileChapters(chapters)) {
          const activeChapter = chapters[this.chapterIndex];
          if (activeChapter) {
            activeChapter.durationSec = Math.round(this.audio.duration);
          }
          const knownTotal = chapters.reduce((sum, ch) => sum + (Number(ch?.durationSec) > 0 ? Number(ch.durationSec) : 0), 0);
          if (knownTotal > 0 && chapters.every((ch) => Number(ch?.durationSec) > 0)) {
            this.currentBook.totalDurationSec = knownTotal;
          }
        }
      }
      if (this.positionSec > 0 && this.positionSec < this.durationSec) {
        try {
          this.audio.currentTime = this.positionSec;
        } catch {
          // Ignore seek errors before readyState
        }
      }
      this.onStateChange(this.getSnapshot());
    });

    this.audio.addEventListener('play', () => {
      if (this.usingSynth) return;
      this.playing = true;
      this.onStateChange(this.getSnapshot());
    });

    this.audio.addEventListener('pause', () => {
      if (this.usingSynth) return;
      this.playing = false;
      this.onStateChange(this.getSnapshot());
    });

    this.audio.addEventListener('ended', () => {
      if (this.usingSynth) return;
      this.playing = false;
      this.onStateChange(this.getSnapshot());
      this.onEnded(this.getSnapshot());
    });

    this.audio.addEventListener('error', () => {
      if (this.usingSynth || !this.currentBook) return;
      if (this._tryDriveBlobFallbackOnError()) return;
      // Graceful fallback to Web Audio synthesizer if remote/demo stream fails
      this._activateSynthFallback();
    });
  }

  _emitState() {
    this.onStateChange(this.getSnapshot());
  }

  _isDirectDriveStreamUrl(url) {
    return Boolean(
      url &&
      typeof url === 'string' &&
      url.includes('googleapis.com') &&
      !url.startsWith('blob:') &&
      url.includes('access_token=')
    );
  }

  async _fetchDriveBlobUrl(streamUrl, token = this.driveAccessToken, signal = undefined) {
    const fetchFn = this.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn || !streamUrl || signal?.aborted) return null;
    try {
      const prevToken = token || this.driveAccessToken;
      if (!prevToken) return null;
      const buildInit = (bearer) => ({
        headers: {
          Authorization: `Bearer ${bearer}`
        },
        ...(signal ? { signal } : {})
      });
      let resp = await fetchFn(streamUrl, buildInit(prevToken));
      if (signal?.aborted) return null;
      if (resp.status === 401 && typeof this.onDriveTokenExpired === 'function') {
        const nextToken = await this.onDriveTokenExpired().catch(() => null);
        if (signal?.aborted) return null;
        if (nextToken && nextToken !== prevToken) {
          this.driveAccessToken = nextToken;
          resp = await fetchFn(streamUrl, buildInit(this.driveAccessToken));
          if (signal?.aborted) return null;
        }
      }
      if (resp && resp.ok) {
        const blob = await resp.blob();
        if (signal?.aborted) return null;
        return URL.createObjectURL(blob);
      }
    } catch {
      return null;
    }
    return null;
  }

  _tryDriveBlobFallbackOnError({ autoPlay = false } = {}) {
    const fb = this._pendingDirectDriveFallback;
    if (!fb || fb.loadSeq !== this._loadSeq || fb.signal?.aborted) {
      return false;
    }
    fb.wantAutoPlay = Boolean(fb.wantAutoPlay || autoPlay || this.playing);
    if (fb.inFlight) {
      return true;
    }
    if (fb.attempted) {
      return false;
    }
    fb.attempted = true;
    fb.inFlight = true;
    const savedPos = this.positionSec;
    void (async () => {
      try {
        const blobUrl = await this._fetchDriveBlobUrl(fb.streamUrl, this.driveAccessToken, fb.signal);
        fb.inFlight = false;
        if (fb.loadSeq !== this._loadSeq || fb.signal?.aborted) {
          if (blobUrl && blobUrl.startsWith('blob:') && typeof URL !== 'undefined') {
            try {
              URL.revokeObjectURL(blobUrl);
            } catch {
              // ignore
            }
          }
          return;
        }
        if (blobUrl && this.audio) {
          this._stopSynthTone();
          this.usingSynth = false;
          this.activeObjectUrl = blobUrl;
          this.audio.src = blobUrl;
          this.audio.playbackRate = this.playbackRate;
          this._applyAudioVolume();
          try {
            this.audio.currentTime = savedPos;
          } catch {
            // Applied on loadedmetadata
          }
          if (fb.wantAutoPlay || this.playing) {
            try {
              await this.audio.play();
            } catch {
              if (fb.loadSeq === this._loadSeq && !fb.signal?.aborted) {
                this._activateSynthFallback();
                this._startSynthTone();
              }
            }
          }
          this._emitState();
        } else if (fb.loadSeq === this._loadSeq && !fb.signal?.aborted) {
          this._activateSynthFallback();
          if (fb.wantAutoPlay || this.playing) {
            this._startSynthTone();
          }
        }
      } finally {
        fb.inFlight = false;
      }
    })();
    return true;
  }

  _loadVolume() {
    try {
      const raw = globalThis.localStorage?.getItem?.(STORAGE_VOLUME_KEY);
      if (raw !== null && raw !== undefined && raw !== '') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
          return Math.max(0, Math.min(1, parsed));
        }
      }
    } catch {
      // ignore
    }
    return 1;
  }

  _loadMuted() {
    try {
      const raw = globalThis.localStorage?.getItem?.(STORAGE_MUTED_KEY);
      return raw === '1' || raw === 'true';
    } catch {
      return false;
    }
  }

  _effectiveVolume() {
    return this.muted ? 0 : Math.max(0, Math.min(1, Number(this.volume ?? 1)));
  }

  _applyAudioVolume() {
    const effective = this._effectiveVolume();
    if (this.audio) {
      try {
        this.audio.volume = effective;
        this.audio.muted = Boolean(this.muted || effective <= 0);
      } catch {
        // Ignore on platforms where HTMLMediaElement.volume is read-only
      }
    }
    if (this._synthNodes?.master && this._audioCtx) {
      try {
        const targetGain = Math.max(0.0001, 0.022 * effective);
        this._synthNodes.master.gain.setTargetAtTime(targetGain, this._audioCtx.currentTime, 0.03);
        if (this._synthNodes.lfoGain) {
          this._synthNodes.lfoGain.gain.setTargetAtTime(
            0.008 * effective,
            this._audioCtx.currentTime,
            0.03
          );
        }
      } catch {
        // ignore
      }
    }
  }

  setVolume(vol) {
    const num = Number(vol);
    const clamped = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 1;
    this.volume = clamped;
    if (clamped > 0 && this.muted) {
      this.muted = false;
      try {
        globalThis.localStorage?.setItem?.(STORAGE_MUTED_KEY, '0');
      } catch {
        // ignore
      }
    }
    try {
      globalThis.localStorage?.setItem?.(STORAGE_VOLUME_KEY, String(clamped));
    } catch {
      // ignore
    }
    this._applyAudioVolume();
    this._emitState();
    return this.volume;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    try {
      globalThis.localStorage?.setItem?.(STORAGE_MUTED_KEY, this.muted ? '1' : '0');
    } catch {
      // ignore
    }
    this._applyAudioVolume();
    this._emitState();
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  setDriveAccessToken(token) {
    this.driveAccessToken = token || null;
  }

  getSnapshot() {
    return {
      bookKey: this.currentBook?.bookKey || null,
      playing: this.playing,
      positionSec: this.positionSec,
      durationSec: this.durationSec || this.currentBook?.totalDurationSec || 0,
      playbackRate: this.playbackRate,
      volume: this.volume,
      muted: this.muted,
      chapterIndex: this.chapterIndex,
      usingSynth: this.usingSynth,
      sleepTimerMode: this.sleepTimerMode,
      sleepRemainingSec: this.sleepRemainingSec
    };
  }

  _revokeObjectUrl() {
    if (this.activeObjectUrl && typeof URL !== 'undefined') {
      try {
        URL.revokeObjectURL(this.activeObjectUrl);
      } catch {
        // ignore
      }
    }
    this.activeObjectUrl = null;
  }

  async _readCachedBlob(bookKey) {
    const db = await openOfflineDb();
    if (!db || !bookKey) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(OFFLINE_STORE, 'readonly');
        const req = tx.objectStore(OFFLINE_STORE).get(bookKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  getEpisodeCacheKey(book, chapterIndex = 0) {
    if (!book?.bookKey) return '';
    const ch = Array.isArray(book.chapters) ? book.chapters[chapterIndex] : null;
    const suffix = ch?.episodeId || ch?.driveFileId || chapterIndex;
    return `${book.bookKey}::${suffix}`;
  }

  async isEpisodeCachedOffline(bookOrKey, chapterIndexOrEpisodeId = 0) {
    let cacheKey = '';
    if (typeof bookOrKey === 'string') {
      if (!bookOrKey) return false;
      cacheKey =
        chapterIndexOrEpisodeId !== undefined &&
        chapterIndexOrEpisodeId !== null &&
        chapterIndexOrEpisodeId !== ''
          ? `${bookOrKey}::${chapterIndexOrEpisodeId}`
          : bookOrKey;
    } else if (bookOrKey && typeof bookOrKey === 'object') {
      cacheKey = this.getEpisodeCacheKey(bookOrKey, chapterIndexOrEpisodeId);
    }
    if (!cacheKey) return false;
    if (this._memoryOfflineSet.has(cacheKey)) return true;
    const record = await this._readCachedBlob(cacheKey);
    return Boolean(record);
  }

  _saveCurrentEpisodeProgress(book = this.currentBook) {
    if (!book?.isPodcast) return;
    book.episodeProgress =
      book.episodeProgress && typeof book.episodeProgress === 'object' ? book.episodeProgress : {};
    const currentChapter = Array.isArray(book.chapters) ? book.chapters[this.chapterIndex] : null;
    const epId = currentChapter?.episodeId;
    if (!epId) return;
    const dur = Math.max(0, Number(this.durationSec || currentChapter?.durationSec || 0));
    const pos = Math.max(0, Number(this.positionSec || 0));
    book.episodeProgress[epId] = {
      positionSec: pos,
      durationSec: dur,
      completed: dur > 0 && pos >= dur - 15,
      updatedAt: new Date().toISOString()
    };
  }

  async isBookCachedOffline(bookKey) {
    if (!bookKey) return false;
    if (this._memoryOfflineSet.has(bookKey)) return true;
    const record = await this._readCachedBlob(bookKey);
    return Boolean(record);
  }

  async _resolveChapterMediaUrl(book, chapterIndex = 0, { signal } = {}) {
    if (signal?.aborted) return null;
    const ch = Array.isArray(book?.chapters) ? book.chapters[chapterIndex] : null;
    if (ch?.localFile && typeof URL !== 'undefined') {
      return URL.createObjectURL(ch.localFile);
    }
    if (ch?.localUrl) {
      return ch.localUrl;
    }
    if (book.localFile && typeof URL !== 'undefined') {
      return URL.createObjectURL(book.localFile);
    }
    if (book.localUrl) {
      return book.localUrl;
    }

    const epKey = ch?.episodeId || ch?.driveFileId || '';
    const cacheKey = epKey ? `${book.bookKey}::${epKey}` : book.bookKey;
    let cached = await this._readCachedBlob(cacheKey);
    if (signal?.aborted) return null;
    if (!cached && book?.isPodcast) {
      const fallbackEpKey = this.getEpisodeCacheKey(book, chapterIndex);
      if (fallbackEpKey && fallbackEpKey !== cacheKey) {
        cached = await this._readCachedBlob(fallbackEpKey);
        if (signal?.aborted) return null;
      }
    }
    if (!cached && !book?.isPodcast) {
      cached = await this._readCachedBlob(book.bookKey);
      if (signal?.aborted) return null;
    }
    if (cached && cached.blob && typeof URL !== 'undefined') {
      return URL.createObjectURL(cached.blob);
    }

    const streamUrl = ch?.audioUrl || ch?.driveStreamUrl || book.driveStreamUrl;
    if (streamUrl) {
      if (this.driveAccessToken && streamUrl.includes('googleapis.com')) {
        if (!this._hasCustomFetchFn && typeof window !== 'undefined') {
          const sep = streamUrl.includes('?') ? '&' : '?';
          return `${streamUrl}${sep}access_token=${encodeURIComponent(this.driveAccessToken)}`;
        }
        return await this._fetchDriveBlobUrl(streamUrl, this.driveAccessToken, signal);
      } else {
        return streamUrl;
      }
    }
    return null;
  }

  async loadBook(book, startPositionSec = null) {
    if (!book) return;
    if (this.currentBook && this.currentBook !== book) {
      this._saveCurrentEpisodeProgress(this.currentBook);
    }

    this._loadSeq += 1;
    const loadSeq = this._loadSeq;
    if (this._activeLoadAbortController) {
      try {
        this._activeLoadAbortController.abort();
      } catch {
        // ignore
      }
    }
    this._activeLoadAbortController =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = this._activeLoadAbortController?.signal;
    this._pendingDirectDriveFallback = null;

    // Stop active playback without emitting stale currentBook state before switching
    this._saveCurrentEpisodeProgress();
    this.playing = false;
    this._stopVirtualClock();
    this._stopSynthTone();
    if (this.audio && !this.usingSynth) {
      try {
        this.audio.pause();
      } catch {
        // ignore
      }
    }
    this._revokeObjectUrl();

    this.currentBook = book;
    if (book.isPodcast) {
      book.episodeProgress =
        book.episodeProgress && typeof book.episodeProgress === 'object' ? book.episodeProgress : {};
    }

    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    const isMulti = Boolean(book.isPodcast || this._isMultiFileChapters(chapters));

    this.chapterIndex = Number.isInteger(book.chapterIndex)
      ? Math.max(0, Math.min(Math.max(0, chapters.length - 1), book.chapterIndex))
      : (isMulti ? 0 : this.computeChapterIndex(Number(startPositionSec ?? book.positionSec ?? 0), chapters));

    const activeChapter = chapters[this.chapterIndex] || null;
    if (isMulti) {
      this.durationSec = Math.max(
        1,
        Number(activeChapter?.durationSec) || Number(book.totalDurationSec) || 1800
      );
    } else {
      this.durationSec = Math.max(60, Number(book.totalDurationSec || 0));
    }

    let initialPos = 0;
    if (startPositionSec !== null && startPositionSec !== undefined) {
      initialPos = Number(startPositionSec);
    } else if (book.isPodcast && activeChapter?.episodeId) {
      const savedEp = book.episodeProgress[activeChapter.episodeId];
      if (savedEp) {
        initialPos = savedEp.completed ? 0 : Number(savedEp.positionSec || 0);
      } else {
        initialPos = Number(book.positionSec || 0);
      }
    } else {
      initialPos = Number(book.positionSec || 0);
    }
    this.positionSec = Math.max(0, Math.min(this.durationSec, Number.isFinite(initialPos) ? initialPos : 0));
    this.usingSynth = false;

    // Emit updated currentBook & chapterIndex immediately before async URL resolution
    this._emitState();

    const mediaUrl = await this._resolveChapterMediaUrl(book, this.chapterIndex, { signal });
    if (loadSeq !== this._loadSeq || signal?.aborted) {
      if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.startsWith('blob:') && typeof URL !== 'undefined') {
        try {
          URL.revokeObjectURL(mediaUrl);
        } catch {
          // ignore
        }
        if (this.activeObjectUrl === mediaUrl) {
          this.activeObjectUrl = null;
        }
      }
      return;
    }

    if (mediaUrl && this.audio) {
      this.usingSynth = false;
      if (typeof mediaUrl === 'string' && mediaUrl.startsWith('blob:')) {
        this.activeObjectUrl = mediaUrl;
      }
      if (this._isDirectDriveStreamUrl(mediaUrl)) {
        const rawStreamUrl = activeChapter?.audioUrl || activeChapter?.driveStreamUrl || book.driveStreamUrl;
        if (rawStreamUrl) {
          this._pendingDirectDriveFallback = {
            streamUrl: rawStreamUrl,
            book,
            chapterIndex: this.chapterIndex,
            loadSeq,
            signal,
            attempted: false,
            inFlight: false,
            wantAutoPlay: false
          };
        }
      }
      this.audio.src = mediaUrl;
      this.audio.playbackRate = this.playbackRate;
      this._applyAudioVolume();
      try {
        this.audio.currentTime = this.positionSec;
      } catch {
        // Applied on loadedmetadata
      }
    } else {
      this._activateSynthFallback();
    }

    this._emitState();
    this.onTimeUpdate(this.getSnapshot());
  }

  _activateSynthFallback() {
    this.usingSynth = true;
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
      } catch {
        // ignore
      }
    }
    this.onStateChange(this.getSnapshot());
  }

  _startSynthTone() {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      if (!this._audioCtx) {
        this._audioCtx = new AudioCtx();
      }
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
      this._stopSynthTone();

      const ctx = this._audioCtx;
      const effective = this._effectiveVolume();
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, 0.022 * effective),
        ctx.currentTime + 0.35
      );

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(420, ctx.currentTime);

      // Warm subtle harmonic chord + soft narrative cadence pulse
      const oscA = ctx.createOscillator();
      oscA.type = 'sine';
      oscA.frequency.setValueAtTime(146.83, ctx.currentTime); // D3

      const oscB = ctx.createOscillator();
      oscB.type = 'triangle';
      oscB.frequency.setValueAtTime(220.0, ctx.currentTime); // A3

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.45 * this.playbackRate, ctx.currentTime);

      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0.008 * effective, ctx.currentTime);

      lfo.connect(lfoGain);
      lfoGain.connect(master.gain);

      oscA.connect(filter);
      oscB.connect(filter);
      filter.connect(master);
      master.connect(ctx.destination);

      oscA.start();
      oscB.start();
      lfo.start();

      this._synthNodes = { master, filter, oscA, oscB, lfo, lfoGain };
    } catch {
      // Ignore audio gesture restrictions; playhead timer still advances smoothly
    }
  }

  _stopSynthTone() {
    if (!this._synthNodes) return;
    try {
      const { master, oscA, oscB, lfo } = this._synthNodes;
      if (this._audioCtx && master) {
        master.gain.setTargetAtTime(0.0001, this._audioCtx.currentTime, 0.06);
      }
      setTimeout(() => {
        try { oscA.stop(); } catch {}
        try { oscB.stop(); } catch {}
        try { lfo.stop(); } catch {}
      }, 90);
    } catch {
      // ignore
    }
    this._synthNodes = null;
  }

  _startVirtualClock() {
    this._stopVirtualClock();
    this._lastTickMs = Date.now();
    this._tickTimer = setInterval(() => {
      if (!this.playing) return;
      const now = Date.now();
      const dtSec = Math.max(0, (now - this._lastTickMs) / 1000);
      this._lastTickMs = now;

      if (this.usingSynth) {
        this.positionSec += dtSec * this.playbackRate;
        if (this.positionSec >= this.durationSec) {
          this.positionSec = this.durationSec;
          this._saveCurrentEpisodeProgress();
          this.pause();
          this.onTimeUpdate(this.getSnapshot());
          this.onEnded(this.getSnapshot());
          return;
        }
        const prevChapter = this.chapterIndex;
        this._syncChapterFromPosition();
        this._saveCurrentEpisodeProgress();
        if (this.sleepTimerMode === 'chapter' && this.chapterIndex !== prevChapter) {
          this.sleepTimerMode = 0;
          this.sleepPresetIndex = 0;
          this.sleepRemainingSec = 0;
          this.pause();
          this.onSleepTimerUpdate(this.getSnapshot());
          return;
        }
        this.onTimeUpdate(this.getSnapshot());
      }

      // Countdown sleep timer for both real and synth audio
      if (typeof this.sleepTimerMode === 'number' && this.sleepTimerMode > 0) {
        this.sleepRemainingSec = Math.max(0, this.sleepRemainingSec - dtSec);
        if (this.sleepRemainingSec <= 0) {
          this.sleepTimerMode = 0;
          this.sleepPresetIndex = 0;
          this.pause();
        }
        this.onSleepTimerUpdate(this.getSnapshot());
      }
    }, 250);
  }

  _stopVirtualClock() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  async play() {
    if (!this.currentBook) return;
    if (this.positionSec >= this.durationSec) {
      this.positionSec = 0;
    }
    this.playing = true;
    this._startVirtualClock();

    if (this.usingSynth || !this.audio || !this.audio.src) {
      this.usingSynth = true;
      this._startSynthTone();
      this.onStateChange(this.getSnapshot());
      return;
    }

    try {
      this.audio.playbackRate = this.playbackRate;
      this._applyAudioVolume();
      await this.audio.play();
      this._emitState();
    } catch {
      if (this._tryDriveBlobFallbackOnError({ autoPlay: true })) {
        return;
      }
      // Fallback cleanly to synth playback if browser blocks/fails audio element
      this._activateSynthFallback();
      this._startSynthTone();
      this._emitState();
    }
  }

  pause() {
    this._saveCurrentEpisodeProgress();
    this.playing = false;
    this._stopVirtualClock();
    this._stopSynthTone();
    if (this.audio && !this.usingSynth) {
      try {
        this.audio.pause();
      } catch {
        // ignore
      }
    }
    this.onStateChange(this.getSnapshot());
  }

  togglePlay() {
    if (this.playing) {
      this.pause();
    } else {
      return this.play();
    }
  }

  seekToSeconds(sec) {
    if (!this.currentBook) return;
    const clamped = Math.max(0, Math.min(this.durationSec || 0, Number(sec) || 0));
    this.positionSec = clamped;
    if (this.audio && !this.usingSynth) {
      try {
        this.audio.currentTime = clamped;
      } catch {
        // ignore
      }
    }
    this._syncChapterFromPosition();
    this._saveCurrentEpisodeProgress();
    this.onTimeUpdate(this.getSnapshot());
    this.onStateChange(this.getSnapshot());
  }

  skipSeconds(delta) {
    const next = (this.positionSec || 0) + Number(delta || 0);
    this.seekToSeconds(next);
  }

  async setChapter(index, startPositionSec = null) {
    const chapters = this.currentBook?.chapters || [];
    if (!chapters.length) return;
    const clampedIdx = Math.max(0, Math.min(chapters.length - 1, Number(index) || 0));
    const targetChapter = chapters[clampedIdx];
    const isMulti = Boolean(this.currentBook?.isPodcast || this._isMultiFileChapters(chapters));
    const hasOwnTrack = Boolean(
      isMulti ||
      targetChapter?.audioUrl ||
      targetChapter?.episodeId ||
      targetChapter?.driveStreamUrl ||
      targetChapter?.localUrl ||
      targetChapter?.localFile
    );

    if (hasOwnTrack) {
      if (this.currentBook?.isPodcast) {
        this._saveCurrentEpisodeProgress(this.currentBook);
      }

      const prevIdx = this.chapterIndex;
      const isSwitchingEpisode = clampedIdx !== prevIdx;
      const wasPlaying = this.playing;

      this._loadSeq += 1;
      const loadSeq = this._loadSeq;
      if (this._activeLoadAbortController) {
        try {
          this._activeLoadAbortController.abort();
        } catch {
          // ignore
        }
      }
      this._activeLoadAbortController =
        typeof AbortController !== 'undefined' ? new AbortController() : null;
      const signal = this._activeLoadAbortController?.signal;
      if (isSwitchingEpisode) {
        this._pendingDirectDriveFallback = null;
        this.pause();
        this._revokeObjectUrl();
      }

      this.chapterIndex = clampedIdx;
      this.durationSec = Math.max(
        1,
        Number(targetChapter?.durationSec) || Number(this.currentBook?.totalDurationSec) || 1800
      );

      let nextPos = 0;
      if (startPositionSec !== null && startPositionSec !== undefined) {
        nextPos = Number(startPositionSec) || 0;
      } else if (this.currentBook?.isPodcast && targetChapter?.episodeId) {
        this.currentBook.episodeProgress =
          this.currentBook.episodeProgress && typeof this.currentBook.episodeProgress === 'object'
            ? this.currentBook.episodeProgress
            : {};
        const savedEp = this.currentBook.episodeProgress[targetChapter.episodeId];
        nextPos =
          savedEp && !savedEp.completed && Number(savedEp.positionSec) > 0
            ? Number(savedEp.positionSec)
            : 0;
      }
      this.positionSec = Math.max(0, Math.min(this.durationSec, nextPos));

      if (isSwitchingEpisode) {
        this.usingSynth = false;
        this._emitState();
        const mediaUrl = await this._resolveChapterMediaUrl(this.currentBook, clampedIdx, { signal });
        if (loadSeq !== this._loadSeq || signal?.aborted) {
          if (mediaUrl && typeof mediaUrl === 'string' && mediaUrl.startsWith('blob:') && typeof URL !== 'undefined') {
            try {
              URL.revokeObjectURL(mediaUrl);
            } catch {
              // ignore
            }
            if (this.activeObjectUrl === mediaUrl) {
              this.activeObjectUrl = null;
            }
          }
          return;
        }
        if (mediaUrl && this.audio) {
          this.usingSynth = false;
          if (typeof mediaUrl === 'string' && mediaUrl.startsWith('blob:')) {
            this.activeObjectUrl = mediaUrl;
          }
          if (this._isDirectDriveStreamUrl(mediaUrl)) {
            const rawStreamUrl =
              targetChapter?.audioUrl || targetChapter?.driveStreamUrl || this.currentBook?.driveStreamUrl;
            if (rawStreamUrl) {
              this._pendingDirectDriveFallback = {
                streamUrl: rawStreamUrl,
                book: this.currentBook,
                chapterIndex: clampedIdx,
                loadSeq,
                signal,
                attempted: false,
                inFlight: false,
                wantAutoPlay: false
              };
            }
          }
          this.audio.src = mediaUrl;
          this.audio.playbackRate = this.playbackRate;
          this._applyAudioVolume();
          try {
            this.audio.currentTime = this.positionSec;
          } catch {
            // Applied on loadedmetadata
          }
        } else {
          this._activateSynthFallback();
        }
        if (wasPlaying) {
          await this.play();
          if (loadSeq !== this._loadSeq || signal?.aborted) return;
        }
      } else if (this.audio && !this.usingSynth) {
        try {
          this.audio.currentTime = this.positionSec;
        } catch {
          // ignore
        }
      }

      if (this.currentBook) {
        this.currentBook.chapterIndex = clampedIdx;
        this.currentBook.positionSec = this.positionSec;
      }
      this.onChapterChange(clampedIdx, targetChapter);
      this.onTimeUpdate(this.getSnapshot());
      this._emitState();
      return;
    }

    const targetSec =
      startPositionSec !== null && startPositionSec !== undefined
        ? Number(startPositionSec) || 0
        : Number(targetChapter.startSec || 0);
    this.chapterIndex = clampedIdx;
    this.seekToSeconds(targetSec);
    this.onChapterChange(clampedIdx, targetChapter);
  }

  async jumpToChapter(index, startPositionSec = null) {
    return this.setChapter(index, startPositionSec);
  }

  setPlaybackRate(rate) {
    const allowed = Number(rate) || 1.0;
    this.playbackRate = Math.max(0.5, Math.min(3.0, allowed));
    if (this.audio && !this.usingSynth) {
      this.audio.playbackRate = this.playbackRate;
    }
    if (this._synthNodes?.lfo && this._audioCtx) {
      try {
        this._synthNodes.lfo.frequency.setValueAtTime(
          0.45 * this.playbackRate,
          this._audioCtx.currentTime
        );
      } catch {
        // ignore
      }
    }
    this.onStateChange(this.getSnapshot());
  }

  cycleSleepTimer() {
    this.sleepPresetIndex = (this.sleepPresetIndex + 1) % SLEEP_PRESETS.length;
    const mode = SLEEP_PRESETS[this.sleepPresetIndex];
    this.sleepTimerMode = mode;
    if (typeof mode === 'number' && mode > 0) {
      this.sleepRemainingSec = mode * 60;
      if (this.playing) this._startVirtualClock();
    } else if (mode === 'chapter') {
      const chapters = this.currentBook?.chapters || [];
      const current = chapters[this.chapterIndex];
      const next = chapters[this.chapterIndex + 1];
      if (this._isMultiFileChapters(chapters)) {
        const trackDur = Number(current?.durationSec) || this.durationSec || 0;
        this.sleepRemainingSec = trackDur > 0 ? Math.max(1, trackDur - this.positionSec) : 0;
      } else if (next) {
        this.sleepRemainingSec = Math.max(1, next.startSec - this.positionSec);
      } else if (current) {
        this.sleepRemainingSec = Math.max(1, this.durationSec - this.positionSec);
      } else {
        this.sleepRemainingSec = 0;
      }
    } else {
      this.sleepRemainingSec = 0;
    }
    this.onSleepTimerUpdate(this.getSnapshot());
    return this.sleepTimerMode;
  }

  _isMultiFileChapters(chapters = []) {
    if (this.currentBook?.isPodcast) return true;
    if (!Array.isArray(chapters) || chapters.length === 0) return false;
    if (chapters.some((ch) => Boolean(ch?.audioUrl || ch?.episodeId))) {
      return true;
    }
    if (chapters.length <= 1) return false;
    let trackCount = 0;
    const distinct = new Set();
    for (const ch of chapters) {
      const key = ch?.driveFileId || ch?.driveStreamUrl || ch?.localUrl || ch?.localFile?.name || '';
      if (key) {
        trackCount += 1;
        distinct.add(key);
      }
    }
    return trackCount > 1 && distinct.size > 1;
  }

  computeChapterIndex(positionSec, chapters = []) {
    if (!Array.isArray(chapters) || chapters.length === 0) return 0;
    if (this._isMultiFileChapters(chapters)) {
      const idx = Number.isInteger(this.chapterIndex) ? this.chapterIndex : 0;
      return Math.max(0, Math.min(chapters.length - 1, idx));
    }
    let idx = 0;
    for (let i = 0; i < chapters.length; i += 1) {
      if (positionSec >= Number(chapters[i].startSec || 0)) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }

  _syncChapterFromPosition() {
    const chapters = this.currentBook?.chapters || [];
    if (this._isMultiFileChapters(chapters)) {
      return;
    }
    const nextIdx = this.computeChapterIndex(this.positionSec, chapters);
    if (nextIdx !== this.chapterIndex) {
      const prevMode = this.sleepTimerMode;
      this.chapterIndex = nextIdx;
      this.onChapterChange(nextIdx, chapters[nextIdx]);
      if (prevMode === 'chapter') {
        this.sleepTimerMode = 0;
        this.sleepPresetIndex = 0;
        this.sleepRemainingSec = 0;
        this.pause();
        this.onSleepTimerUpdate(this.getSnapshot());
      }
    }
  }

  async cacheBookOffline(book) {
    if (!book || !book.bookKey) return { ok: false };
    let blob = null;
    if (book.localFile instanceof Blob) {
      blob = book.localFile;
    } else if (book.driveStreamUrl && typeof fetch === 'function') {
      try {
        const headers = this.driveAccessToken
          ? { Authorization: `Bearer ${this.driveAccessToken}` }
          : undefined;
        const resp = await fetch(book.driveStreamUrl, { headers });
        if (resp.ok) {
          blob = await resp.blob();
        }
      } catch {
        blob = null;
      }
    }

    // For demo / metadata-only books without a physical file, persist an offline manifest blob
    if (!blob && typeof Blob !== 'undefined') {
      blob = new Blob([JSON.stringify({ bookKey: book.bookKey, cachedAt: Date.now() })], {
        type: 'application/json'
      });
    }

    this._memoryOfflineSet.add(book.bookKey);
    const db = await openOfflineDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(OFFLINE_STORE, 'readwrite');
          tx.objectStore(OFFLINE_STORE).put({
            bookKey: book.bookKey,
            blob,
            cachedAt: new Date().toISOString()
          });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    }

    book.offlineCached = true;
    this.onOfflineChange(book.bookKey, true);
    return { ok: true, bookKey: book.bookKey, cachedBytes: blob?.size || 0 };
  }

  async removeOfflineCopy(book) {
    if (!book || !book.bookKey) return { ok: false };
    this._memoryOfflineSet.delete(book.bookKey);
    const db = await openOfflineDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(OFFLINE_STORE, 'readwrite');
          tx.objectStore(OFFLINE_STORE).delete(book.bookKey);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    }
    book.offlineCached = false;
    this.onOfflineChange(book.bookKey, false);
    return { ok: true, bookKey: book.bookKey };
  }

  async cacheEpisodeOffline(book, chapterIndex = 0) {
    if (!book || !book.bookKey) return { ok: false };
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    const ch = chapters[chapterIndex] || null;
    const cacheKey = this.getEpisodeCacheKey(book, chapterIndex);
    if (!cacheKey) return { ok: false };

    let blob = null;
    const url = ch?.audioUrl || ch?.driveStreamUrl || '';
    const fetchFn = this.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    if (ch?.localFile instanceof Blob) {
      blob = ch.localFile;
    } else if (url && fetchFn) {
      const headers =
        this.driveAccessToken && url.includes('googleapis.com')
          ? { Authorization: `Bearer ${this.driveAccessToken}` }
          : undefined;
      try {
        const resp = await fetchFn(url, headers ? { headers } : undefined);
        if (resp?.ok) {
          blob = await resp.blob();
        }
      } catch {
        blob = null;
      }

      if (!blob && /^https?:\/\//i.test(url) && !url.includes('googleapis.com')) {
        const proxyUrls = [
          `https://corsproxy.io/?${encodeURIComponent(url)}`,
          `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
        ];
        for (const proxyUrl of proxyUrls) {
          try {
            const resp = await fetchFn(proxyUrl);
            if (resp?.ok) {
              blob = await resp.blob();
              break;
            }
          } catch {
            // Try next CORS proxy
          }
        }
      }
    }

    if (!blob && typeof Blob !== 'undefined') {
      blob = new Blob(
        [
          JSON.stringify({
            bookKey: book.bookKey,
            episodeId: ch?.episodeId || null,
            chapterIndex,
            cachedAt: Date.now()
          })
        ],
        { type: 'application/json' }
      );
    }

    this._memoryOfflineSet.add(cacheKey);
    const db = await openOfflineDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(OFFLINE_STORE, 'readwrite');
          tx.objectStore(OFFLINE_STORE).put({
            bookKey: cacheKey,
            blob,
            cachedAt: new Date().toISOString()
          });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    }

    if (ch) {
      ch.offlineCached = true;
    }
    book.hasOfflineEpisodes = chapters.some((c) => Boolean(c?.offlineCached));
    this.onOfflineChange({
      bookKey: book.bookKey,
      episodeId: ch?.episodeId,
      chapterIndex,
      cached: true
    });
    return { ok: true, cacheKey, cachedBytes: blob?.size || 0 };
  }

  async removeEpisodeOffline(book, chapterIndex = 0) {
    if (!book || !book.bookKey) return { ok: false };
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    const ch = chapters[chapterIndex] || null;
    const cacheKey = this.getEpisodeCacheKey(book, chapterIndex);
    if (!cacheKey) return { ok: false };

    this._memoryOfflineSet.delete(cacheKey);
    const db = await openOfflineDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(OFFLINE_STORE, 'readwrite');
          tx.objectStore(OFFLINE_STORE).delete(cacheKey);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    }

    if (ch) {
      ch.offlineCached = false;
    }
    book.hasOfflineEpisodes = chapters.some((c) => Boolean(c?.offlineCached));
    this.onOfflineChange({
      bookKey: book.bookKey,
      episodeId: ch?.episodeId,
      chapterIndex,
      cached: false
    });
    return { ok: true, cacheKey };
  }

  destroy() {
    this._loadSeq += 1;
    if (this._activeLoadAbortController) {
      try {
        this._activeLoadAbortController.abort();
      } catch {
        // ignore
      }
      this._activeLoadAbortController = null;
    }
    this._pendingDirectDriveFallback = null;
    this.pause();
    this._revokeObjectUrl();
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch {
        // ignore
      }
      this._audioCtx = null;
    }
  }
}
