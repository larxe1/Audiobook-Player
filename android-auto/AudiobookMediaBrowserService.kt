package com.audiobook.player

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.session.MediaButtonReceiver
import kotlin.math.max
import kotlin.math.min

/**
 * Native Android Auto / Wear OS / MediaStyle Notification MediaBrowserService.
 * Exposes audiobook browsing and MediaSession transport callbacks (-15s, +30s,
 * play/pause, bookmark, and automatic pause on Bluetooth/audio disconnect).
 */
class AudiobookMediaBrowserService : MediaBrowserServiceCompat() {

    companion object {
        const val MEDIA_ROOT_ID = "audiobook_root"
        const val MEDIA_JUMP_BACK_IN_ID = "jump_back_in"
        const val MEDIA_LIBRARY_ID = "library"

        const val REWIND_STEP_MS = 15_000L
        const val FAST_FORWARD_STEP_MS = 30_000L

        const val CUSTOM_ACTION_REWIND_15 = "com.audiobook.player.ACTION_REWIND_15"
        const val CUSTOM_ACTION_FORWARD_30 = "com.audiobook.player.ACTION_FORWARD_30"
        const val CUSTOM_ACTION_BOOKMARK = "com.audiobook.player.ACTION_BOOKMARK"
    }

    private lateinit var mediaSession: MediaSessionCompat
    private var currentPositionMs: Long = 0L
    private var currentDurationMs: Long = 0L
    private var playbackSpeed: Float = 1.0f
    private var isPlaying: Boolean = false
    private var currentMediaId: String? = null
    private val bookmarksMs = mutableListOf<Long>()

    private val noisyAndBluetoothReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioManager.ACTION_AUDIO_BECOMING_NOISY,
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                    if (isPlaying) {
                        pausePlayback()
                    }
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()

        mediaSession = MediaSessionCompat(this, "AudiobookMediaSession").apply {
            setCallback(mediaSessionCallback)
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            isActive = true
        }

        sessionToken = mediaSession.sessionToken
        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED)

        val filter = IntentFilter().apply {
            addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
        }
        registerReceiver(noisyAndBluetoothReceiver, filter)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        MediaButtonReceiver.handleIntent(mediaSession, intent)
        return super.onStartCommand(intent, flags, startId)
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(noisyAndBluetoothReceiver)
        } catch (_: IllegalArgumentException) {
            // Receiver already unregistered
        }
        mediaSession.isActive = false
        mediaSession.release()
        super.onDestroy()
    }

    override fun onGetRoot(
        clientPackageName: String,
        clientUid: Int,
        rootHints: Bundle?
    ): BrowserRoot {
        return BrowserRoot(MEDIA_ROOT_ID, null)
    }

    override fun onLoadChildren(
        parentId: String,
        result: Result<MutableList<MediaBrowserCompat.MediaItem>>
    ) {
        val items = mutableListOf<MediaBrowserCompat.MediaItem>()

        when (parentId) {
            MEDIA_ROOT_ID -> {
                items.add(
                    MediaBrowserCompat.MediaItem(
                        MediaDescriptionCompat.Builder()
                            .setMediaId(MEDIA_JUMP_BACK_IN_ID)
                            .setTitle("Jump back in")
                            .build(),
                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                    )
                )
                items.add(
                    MediaBrowserCompat.MediaItem(
                        MediaDescriptionCompat.Builder()
                            .setMediaId(MEDIA_LIBRARY_ID)
                            .setTitle("Library")
                            .build(),
                        MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                    )
                )
            }

            MEDIA_JUMP_BACK_IN_ID,
            MEDIA_LIBRARY_ID -> {
                currentMediaId?.let { activeId ->
                    items.add(
                        MediaBrowserCompat.MediaItem(
                            MediaDescriptionCompat.Builder()
                                .setMediaId(activeId)
                                .setTitle("Current Audiobook")
                                .build(),
                            MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                        )
                    )
                }
            }
        }

        result.sendResult(items)
    }

    private val mediaSessionCallback = object : MediaSessionCompat.Callback() {
        override fun onPlay() {
            startPlayback()
        }

        override fun onPause() {
            pausePlayback()
        }

        override fun onStop() {
            pausePlayback()
            stopForeground(STOP_FOREGROUND_DETACH)
        }

        override fun onRewind() {
            seekRelative(-REWIND_STEP_MS)
        }

        override fun onFastForward() {
            seekRelative(FAST_FORWARD_STEP_MS)
        }

        override fun onSeekTo(pos: Long) {
            val upperBound = if (currentDurationMs > 0L) currentDurationMs else Long.MAX_VALUE
            currentPositionMs = max(0L, min(pos, upperBound))
            updatePlaybackState(
                if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
            )
        }

        override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
            currentMediaId = mediaId
            extras?.let {
                val title = it.getString(MediaMetadataCompat.METADATA_KEY_TITLE)
                val author = it.getString(MediaMetadataCompat.METADATA_KEY_ARTIST)
                currentDurationMs = it.getLong(MediaMetadataCompat.METADATA_KEY_DURATION, 0L)
                mediaSession.setMetadata(
                    MediaMetadataCompat.Builder()
                        .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, mediaId)
                        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, author)
                        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDurationMs)
                        .build()
                )
            }
            startPlayback()
        }

        override fun onCustomAction(action: String?, extras: Bundle?) {
            when (action) {
                CUSTOM_ACTION_REWIND_15 -> seekRelative(-REWIND_STEP_MS)
                CUSTOM_ACTION_FORWARD_30 -> seekRelative(FAST_FORWARD_STEP_MS)
                CUSTOM_ACTION_BOOKMARK -> addBookmark(currentPositionMs)
            }
        }
    }

    private fun startPlayback() {
        isPlaying = true
        mediaSession.isActive = true
        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
    }

    private fun pausePlayback() {
        isPlaying = false
        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED)
    }

    private fun seekRelative(deltaMs: Long) {
        val upperBound = if (currentDurationMs > 0L) currentDurationMs else Long.MAX_VALUE
        currentPositionMs = max(0L, min(currentPositionMs + deltaMs, upperBound))
        updatePlaybackState(
            if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        )
    }

    private fun addBookmark(positionMs: Long) {
        bookmarksMs.add(positionMs)
        val extras = Bundle().apply {
            putLong("lastBookmarkMs", positionMs)
            putInt("bookmarkCount", bookmarksMs.size)
        }
        mediaSession.setExtras(extras)
    }

    private fun updatePlaybackState(state: Int) {
        val actions =
            PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_REWIND or
                PlaybackStateCompat.ACTION_FAST_FORWARD or
                PlaybackStateCompat.ACTION_SEEK_TO

        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(state, currentPositionMs, if (state == PlaybackStateCompat.STATE_PLAYING) playbackSpeed else 0f)
            .addCustomAction(
                PlaybackStateCompat.CustomAction.Builder(
                    CUSTOM_ACTION_REWIND_15,
                    "-15s",
                    android.R.drawable.ic_media_rew
                ).build()
            )
            .addCustomAction(
                PlaybackStateCompat.CustomAction.Builder(
                    CUSTOM_ACTION_FORWARD_30,
                    "+30s",
                    android.R.drawable.ic_media_ff
                ).build()
            )
            .addCustomAction(
                PlaybackStateCompat.CustomAction.Builder(
                    CUSTOM_ACTION_BOOKMARK,
                    "Bookmark",
                    android.R.drawable.btn_star_big_on
                ).build()
            )

        mediaSession.setPlaybackState(stateBuilder.build())
    }
}
