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

    this.audio = typeof Audio !== 'undefined' ? new Audio() : null;
    if (this.audio) {
      this.audio.preload = 'metadata';
      this._bindAudioEvents();
    }

    this.currentBook = null;
    this.playing = false;
    this.playbackRate = 1.0;
    this.positionSec = 0;
    this.durationSec = 0;
    this.chapterIndex = 0;
    this.usingSynth = false;
    this.activeObjectUrl = null;
    this.driveAccessToken = null;

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
      this.onTimeUpdate(this.getSnapshot());
    });

    this.audio.addEventListener('loadedmetadata', () => {
      if (this.usingSynth) return;
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        this.durationSec = this.audio.duration;
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
      // Graceful fallback to Web Audio synthesizer if remote/demo stream fails
      this._activateSynthFallback();
    });
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

  async isBookCachedOffline(bookKey) {
    if (!bookKey) return false;
    if (this._memoryOfflineSet.has(bookKey)) return true;
    const record = await this._readCachedBlob(bookKey);
    return Boolean(record);
  }

  async _resolveChapterMediaUrl(book, chapterIndex = 0) {
    const ch = Array.isArray(book?.chapters) ? book.chapters[chapterIndex] : null;
    if (ch?.localFile && typeof URL !== 'undefined') {
      const url = URL.createObjectURL(ch.localFile);
      this.activeObjectUrl = url;
      return url;
    }
    if (ch?.localUrl) {
      return ch.localUrl;
    }
    if (book.localFile && typeof URL !== 'undefined') {
      const url = URL.createObjectURL(book.localFile);
      this.activeObjectUrl = url;
      return url;
    }
    if (book.localUrl) {
      return book.localUrl;
    }

    const cacheKey = ch?.driveFileId ? `${book.bookKey}::${ch.driveFileId}` : book.bookKey;
    const cached = (await this._readCachedBlob(cacheKey)) || (await this._readCachedBlob(book.bookKey));
    if (cached && cached.blob && typeof URL !== 'undefined') {
      const url = URL.createObjectURL(cached.blob);
      this.activeObjectUrl = url;
      return url;
    }

    const streamUrl = ch?.driveStreamUrl || book.driveStreamUrl;
    if (streamUrl) {
      if (this.driveAccessToken && streamUrl.includes('googleapis.com')) {
        try {
          const resp = await fetch(streamUrl, {
            headers: {
              Authorization: `Bearer ${this.driveAccessToken}`
            }
          });
          if (resp.ok) {
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            this.activeObjectUrl = url;
            return url;
          }
        } catch {
          return null;
        }
      } else {
        return streamUrl;
      }
    }
    return null;
  }

  async loadBook(book, startPositionSec = null) {
    if (!book) return;
    this.pause();
    this._revokeObjectUrl();

    this.currentBook = book;
    this.durationSec = Math.max(60, Number(book.totalDurationSec || 0));
    const initialPos = startPositionSec !== null && startPositionSec !== undefined
      ? Number(startPositionSec)
      : Number(book.positionSec || 0);
    this.positionSec = Math.max(0, Math.min(this.durationSec, initialPos));
    this.chapterIndex = Number.isInteger(book.chapterIndex)
      ? Math.max(0, Math.min((book.chapters?.length || 1) - 1, book.chapterIndex))
      : this.computeChapterIndex(this.positionSec, book.chapters);
    this.usingSynth = false;

    const mediaUrl = await this._resolveChapterMediaUrl(book, this.chapterIndex);

    if (mediaUrl && this.audio) {
      this.usingSynth = false;
      this.audio.src = mediaUrl;
      this.audio.playbackRate = this.playbackRate;
      try {
        this.audio.currentTime = this.positionSec;
      } catch {
        // Applied on loadedmetadata
      }
    } else {
      this._activateSynthFallback();
    }

    this.onStateChange(this.getSnapshot());
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
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.022, ctx.currentTime + 0.35);

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
      lfoGain.gain.setValueAtTime(0.008, ctx.currentTime);

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
          this.pause();
          this.onTimeUpdate(this.getSnapshot());
          this.onEnded(this.getSnapshot());
          return;
        }
        const prevChapter = this.chapterIndex;
        this._syncChapterFromPosition();
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
      await this.audio.play();
      this.onStateChange(this.getSnapshot());
    } catch {
      // Fallback cleanly to synth playback if browser blocks/fails audio element
      this._activateSynthFallback();
      this._startSynthTone();
      this.onStateChange(this.getSnapshot());
    }
  }

  pause() {
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
    this.onTimeUpdate(this.getSnapshot());
    this.onStateChange(this.getSnapshot());
  }

  skipSeconds(delta) {
    const next = (this.positionSec || 0) + Number(delta || 0);
    this.seekToSeconds(next);
  }

  async jumpToChapter(index) {
    const chapters = this.currentBook?.chapters || [];
    if (!chapters.length) return;
    const clampedIdx = Math.max(0, Math.min(chapters.length - 1, index));
    const targetChapter = chapters[clampedIdx];
    const hasOwnTrack = Boolean(
      targetChapter?.driveStreamUrl || targetChapter?.localUrl || targetChapter?.localFile
    );

    if (hasOwnTrack && clampedIdx !== this.chapterIndex) {
      const wasPlaying = this.playing;
      this.pause();
      this._revokeObjectUrl();
      this.chapterIndex = clampedIdx;
      this.positionSec = 0;
      const mediaUrl = await this._resolveChapterMediaUrl(this.currentBook, clampedIdx);
      if (mediaUrl && this.audio) {
        this.usingSynth = false;
        this.audio.src = mediaUrl;
        this.audio.playbackRate = this.playbackRate;
        try {
          this.audio.currentTime = 0;
        } catch {
          // ignore
        }
        if (wasPlaying) {
          await this.play();
        }
      }
      this.onChapterChange(clampedIdx, targetChapter);
      this.onTimeUpdate(this.getSnapshot());
      this.onStateChange(this.getSnapshot());
      return;
    }

    const targetSec = Number(targetChapter.startSec || 0);
    this.chapterIndex = clampedIdx;
    this.seekToSeconds(targetSec);
    this.onChapterChange(clampedIdx, targetChapter);
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
      if (next) {
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

  computeChapterIndex(positionSec, chapters = []) {
    if (!Array.isArray(chapters) || chapters.length === 0) return 0;
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

  destroy() {
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
