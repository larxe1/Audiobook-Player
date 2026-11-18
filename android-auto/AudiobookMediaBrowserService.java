package com.audiobook.player;

import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Bundle;
import android.support.v4.media.MediaBrowserCompat;
import android.support.v4.media.MediaDescriptionCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.media.MediaBrowserServiceCompat;
import androidx.media.session.MediaButtonReceiver;
import java.util.ArrayList;
import java.util.List;

/**
 * Native Android Auto / Wear OS / MediaStyle Notification MediaBrowserService.
 * Exposes audiobook browsing and MediaSession transport callbacks (-15s, +30s,
 * play/pause, bookmark, and automatic pause on Bluetooth/audio disconnect).
 */
public class AudiobookMediaBrowserService extends MediaBrowserServiceCompat {

    public static final String MEDIA_ROOT_ID = "audiobook_root";
    public static final String MEDIA_JUMP_BACK_IN_ID = "jump_back_in";
    public static final String MEDIA_LIBRARY_ID = "library";

    public static final long REWIND_STEP_MS = 15_000L;
    public static final long FAST_FORWARD_STEP_MS = 30_000L;

    public static final String CUSTOM_ACTION_REWIND_15 = "com.audiobook.player.ACTION_REWIND_15";
    public static final String CUSTOM_ACTION_FORWARD_30 = "com.audiobook.player.ACTION_FORWARD_30";
    public static final String CUSTOM_ACTION_BOOKMARK = "com.audiobook.player.ACTION_BOOKMARK";

    private MediaSessionCompat mediaSession;
    private long currentPositionMs = 0L;
    private long currentDurationMs = 0L;
    private float playbackSpeed = 1.0f;
    private boolean isPlaying = false;
    private String currentMediaId = null;
    private final List<Long> bookmarksMs = new ArrayList<>();

    private final BroadcastReceiver noisyAndBluetoothReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) {
                return;
            }
            String action = intent.getAction();
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(action)
                || BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(action)) {
                if (isPlaying) {
                    pausePlayback();
                }
            }
        }
    };

    private final MediaSessionCompat.Callback mediaSessionCallback = new MediaSessionCompat.Callback() {
        @Override
        public void onPlay() {
            startPlayback();
        }

        @Override
        public void onPause() {
            pausePlayback();
        }

        @Override
        public void onStop() {
            pausePlayback();
            ServiceCompat.stopForeground(
                AudiobookMediaBrowserService.this,
                ServiceCompat.STOP_FOREGROUND_DETACH
            );
        }

        @Override
        public void onRewind() {
            seekRelative(-REWIND_STEP_MS);
        }

        @Override
        public void onFastForward() {
            seekRelative(FAST_FORWARD_STEP_MS);
        }

        @Override
        public void onSeekTo(long pos) {
            long upperBound = currentDurationMs > 0L ? currentDurationMs : Long.MAX_VALUE;
            currentPositionMs = Math.max(0L, Math.min(pos, upperBound));
            updatePlaybackState(
                isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED
            );
        }

        @Override
        public void onPlayFromMediaId(String mediaId, Bundle extras) {
            currentMediaId = mediaId;
            if (extras != null) {
                String title = extras.getString(MediaMetadataCompat.METADATA_KEY_TITLE);
                String author = extras.getString(MediaMetadataCompat.METADATA_KEY_ARTIST);
                currentDurationMs = extras.getLong(MediaMetadataCompat.METADATA_KEY_DURATION, 0L);
                mediaSession.setMetadata(
                    new MediaMetadataCompat.Builder()
                        .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, mediaId)
                        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, author)
                        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDurationMs)
                        .build()
                );
            }
            startPlayback();
        }

        @Override
        public void onCustomAction(String action, Bundle extras) {
            if (CUSTOM_ACTION_REWIND_15.equals(action)) {
                seekRelative(-REWIND_STEP_MS);
            } else if (CUSTOM_ACTION_FORWARD_30.equals(action)) {
                seekRelative(FAST_FORWARD_STEP_MS);
            } else if (CUSTOM_ACTION_BOOKMARK.equals(action)) {
                addBookmark(currentPositionMs);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();

        mediaSession = new MediaSessionCompat(this, "AudiobookMediaSession");
        mediaSession.setCallback(mediaSessionCallback);
        mediaSession.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setActive(true);

        setSessionToken(mediaSession.getSessionToken());
        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED);

        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        ContextCompat.registerReceiver(
            this,
            noisyAndBluetoothReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaButtonReceiver.handleIntent(mediaSession, intent);
        return super.onStartCommand(intent, flags, startId);
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(noisyAndBluetoothReceiver);
        } catch (IllegalArgumentException ignored) {
            // Receiver already unregistered
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public BrowserRoot onGetRoot(
        @NonNull String clientPackageName,
        int clientUid,
        @Nullable Bundle rootHints
    ) {
        return new BrowserRoot(MEDIA_ROOT_ID, null);
    }

    @Override
    public void onLoadChildren(
        @NonNull String parentId,
        @NonNull Result<List<MediaBrowserCompat.MediaItem>> result
    ) {
        List<MediaBrowserCompat.MediaItem> items = new ArrayList<>();

        if (MEDIA_ROOT_ID.equals(parentId)) {
            items.add(
                new MediaBrowserCompat.MediaItem(
                    new MediaDescriptionCompat.Builder()
                        .setMediaId(MEDIA_JUMP_BACK_IN_ID)
                        .setTitle("Jump back in")
                        .build(),
                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                )
            );
            items.add(
                new MediaBrowserCompat.MediaItem(
                    new MediaDescriptionCompat.Builder()
                        .setMediaId(MEDIA_LIBRARY_ID)
                        .setTitle("Library")
                        .build(),
                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
                )
            );
        } else if (MEDIA_JUMP_BACK_IN_ID.equals(parentId) || MEDIA_LIBRARY_ID.equals(parentId)) {
            if (currentMediaId != null) {
                items.add(
                    new MediaBrowserCompat.MediaItem(
                        new MediaDescriptionCompat.Builder()
                            .setMediaId(currentMediaId)
                            .setTitle("Current Audiobook")
                            .build(),
                        MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
                    )
                );
            }
        }

        result.sendResult(items);
    }

    private void startPlayback() {
        isPlaying = true;
        mediaSession.setActive(true);
        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING);
    }

    private void pausePlayback() {
        isPlaying = false;
        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED);
    }

    private void seekRelative(long deltaMs) {
        long upperBound = currentDurationMs > 0L ? currentDurationMs : Long.MAX_VALUE;
        currentPositionMs = Math.max(0L, Math.min(currentPositionMs + deltaMs, upperBound));
        updatePlaybackState(
            isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED
        );
    }

    private void addBookmark(long positionMs) {
        bookmarksMs.add(positionMs);
        Bundle extras = new Bundle();
        extras.putLong("lastBookmarkMs", positionMs);
        extras.putInt("bookmarkCount", bookmarksMs.size());
        mediaSession.setExtras(extras);
    }

    private void updatePlaybackState(int state) {
        long actions =
            PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_STOP
                | PlaybackStateCompat.ACTION_REWIND
                | PlaybackStateCompat.ACTION_FAST_FORWARD
                | PlaybackStateCompat.ACTION_SEEK_TO;

        PlaybackStateCompat.Builder stateBuilder = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(
                state,
                currentPositionMs,
                state == PlaybackStateCompat.STATE_PLAYING ? playbackSpeed : 0f
            )
            .addCustomAction(
                new PlaybackStateCompat.CustomAction.Builder(
                    CUSTOM_ACTION_REWIND_15,
                    "-15s",
                    android.R.drawable.ic_media_rew
                ).build()
            )
            .addCustomAction(
                new PlaybackStateCompat.CustomAction.Builder(
                    CUSTOM_ACTION_FORWARD_30,
                    "+30s",
                    android.R.drawable.ic_media_ff
                ).build()
            )
            .addCustomAction(
                new PlaybackStateCompat.CustomAction.Builder(
                    CUSTOM_ACTION_BOOKMARK,
                    "Bookmark",
                    android.R.drawable.btn_star_big_on
                ).build()
            );

        mediaSession.setPlaybackState(stateBuilder.build());
    }
}
