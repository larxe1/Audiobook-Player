package com.audiobook.player;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native Android APK downloader and package installer bridge for Capacitor.
 * Exposed to the WebView as `window.AudiobookUpdaterNative`.
 */
public class AudiobookUpdaterBridge {

    private static final String ALLOWED_PREFIX_GITHUB =
        "https://github.com/larxe1/Audiobook-Player/";
    private static final String ALLOWED_PREFIX_OBJECTS =
        "https://objects.githubusercontent.com/";
    private static final String APK_FILENAME = "Audiobook-Player-update.apk";
    private static final long MIN_APK_BYTES = 500_000L;
    private static final int MAX_REDIRECTS = 8;

    private final BridgeActivity activity;
    private final AtomicBoolean downloadInProgress = new AtomicBoolean(false);

    public AudiobookUpdaterBridge(BridgeActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void startApkUpdate(final String apkUrl) {
        final String trimmedUrl = apkUrl != null ? apkUrl.trim() : "";
        if (!isAllowedInitialUrl(trimmedUrl)) {
            dispatchProgress("error", -1, "Untrusted APK download URL.");
            return;
        }

        if (Build.VERSION.SDK_INT >= 26) {
            boolean canInstall = false;
            try {
                canInstall = activity.getPackageManager().canRequestPackageInstalls();
            } catch (Exception ignored) {
                canInstall = false;
            }
            if (!canInstall) {
                dispatchProgress(
                    "permission_required",
                    -1,
                    "Allow Install unknown apps for Audiobook Player, then tap Update again."
                );
                activity.runOnUiThread(
                    () -> {
                        try {
                            Intent settingsIntent = new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName())
                            );
                            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            activity.startActivity(settingsIntent);
                        } catch (Exception e) {
                            dispatchProgress(
                                "error",
                                -1,
                                "Unable to open Install unknown apps settings: " + e.getMessage()
                            );
                        }
                    }
                );
                return;
            }
        }

        if (!downloadInProgress.compareAndSet(false, true)) {
            dispatchProgress("downloading", 0, "Update download is already in progress.");
            return;
        }

        new Thread(
            () -> {
                File apkFile = null;
                try {
                    dispatchProgress("downloading", 0, "Downloading update...");
                    File cacheRoot = activity.getCacheDir();
                    if (cacheRoot == null) {
                        cacheRoot = activity.getExternalCacheDir();
                    }
                    if (cacheRoot == null) {
                        throw new IOException("No cache directory available for APK download.");
                    }
                    if (!cacheRoot.exists()) {
                        cacheRoot.mkdirs();
                    }

                    apkFile = new File(cacheRoot, APK_FILENAME);
                    if (apkFile.exists()) {
                        apkFile.delete();
                    }

                    downloadWithRedirects(trimmedUrl, apkFile);

                    if (!apkFile.exists() || apkFile.length() <= MIN_APK_BYTES) {
                        long len = apkFile.exists() ? apkFile.length() : 0L;
                        throw new IOException(
                            "Downloaded APK is invalid or too small (" + len + " bytes)."
                        );
                    }

                    if (!hasZipPkHeader(apkFile)) {
                        throw new IOException(
                            "Downloaded file is not a valid APK archive (missing PK header)."
                        );
                    }

                    final Uri contentUri = FileProvider.getUriForFile(
                        activity,
                        activity.getPackageName() + ".fileprovider",
                        apkFile
                    );

                    dispatchProgress("installing", 100, "Opening Android installer...");

                    activity.runOnUiThread(
                        () -> {
                            try {
                                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                                installIntent.setDataAndType(
                                    contentUri,
                                    "application/vnd.android.package-archive"
                                );
                                installIntent.addFlags(
                                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                                        | Intent.FLAG_ACTIVITY_NEW_TASK
                                );
                                activity.startActivity(installIntent);
                            } catch (Exception e) {
                                dispatchProgress(
                                    "error",
                                    -1,
                                    "Failed to launch Android package installer: " + e.getMessage()
                                );
                            }
                        }
                    );
                } catch (Exception e) {
                    if (apkFile != null && apkFile.exists()) {
                        apkFile.delete();
                    }
                    String msg = e.getMessage();
                    if (msg == null || msg.trim().isEmpty()) {
                        msg = "APK update download failed.";
                    }
                    dispatchProgress("error", -1, msg);
                } finally {
                    downloadInProgress.set(false);
                }
            },
            "AudiobookApkUpdater"
        ).start();
    }

    private static boolean isAllowedInitialUrl(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        return url.startsWith(ALLOWED_PREFIX_GITHUB) || url.startsWith(ALLOWED_PREFIX_OBJECTS);
    }

    private void downloadWithRedirects(String initialUrl, File outFile) throws IOException {
        String currentUrl = initialUrl;
        HttpURLConnection conn = null;

        for (int redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
            if (!currentUrl.startsWith("https://")) {
                throw new IOException("Refusing non-HTTPS redirect URL.");
            }

            URL url = new URL(currentUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream, */*");
            conn.setRequestProperty("User-Agent", "AudiobookPlayer-AndroidUpdater");

            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_MOVED_PERM
                || code == HttpURLConnection.HTTP_MOVED_TEMP
                || code == HttpURLConnection.HTTP_SEE_OTHER
                || code == 307
                || code == 308) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                conn = null;
                if (location == null || location.trim().isEmpty()) {
                    throw new IOException("Redirect response missing Location header (HTTP " + code + ").");
                }
                currentUrl = new URL(url, location.trim()).toString();
                continue;
            }

            if (code < 200 || code >= 300) {
                conn.disconnect();
                throw new IOException("Download failed with HTTP " + code + ".");
            }

            long totalBytes = -1L;
            String contentLengthHeader = conn.getHeaderField("Content-Length");
            if (contentLengthHeader != null) {
                try {
                    totalBytes = Long.parseLong(contentLengthHeader.trim());
                } catch (NumberFormatException ignored) {
                    totalBytes = -1L;
                }
            }

            try (
                InputStream in = new BufferedInputStream(conn.getInputStream());
                FileOutputStream out = new FileOutputStream(outFile, false)
            ) {
                byte[] buffer = new byte[16384];
                long downloaded = 0L;
                int lastPct = 0;
                long lastEmitMs = 0L;
                int bytesRead;

                while ((bytesRead = in.read(buffer)) != -1) {
                    out.write(buffer, 0, bytesRead);
                    downloaded += bytesRead;

                    long now = System.currentTimeMillis();
                    if (totalBytes > 0L) {
                        int pct = (int) Math.min(100L, (downloaded * 100L) / totalBytes);
                        if ((pct - lastPct >= 2 && now - lastEmitMs >= 180L) || now - lastEmitMs >= 500L) {
                            lastPct = pct;
                            lastEmitMs = now;
                            dispatchProgress("downloading", pct, null);
                        }
                    } else if (now - lastEmitMs >= 500L) {
                        lastEmitMs = now;
                        dispatchProgress("downloading", -1, null);
                    }
                }
                out.flush();
            } finally {
                conn.disconnect();
            }
            return;
        }

        throw new IOException("Too many HTTP redirects while downloading APK.");
    }

    private static boolean hasZipPkHeader(File file) throws IOException {
        byte[] header = new byte[2];
        try (FileInputStream fis = new FileInputStream(file)) {
            int read = fis.read(header);
            return read == 2 && header[0] == 0x50 && header[1] == 0x4B;
        }
    }

    private void dispatchProgress(String status, int progress, String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("status", status);
            if (progress >= 0) {
                payload.put("progress", progress);
            }
            if (message != null && !message.isEmpty()) {
                payload.put("message", message);
            }
        } catch (JSONException ignored) {
            return;
        }

        final String json = payload.toString();
        activity.runOnUiThread(
            () -> {
                if (activity.getBridge() == null) {
                    return;
                }
                WebView webView = activity.getBridge().getWebView();
                if (webView == null) {
                    return;
                }
                String safeJsonLiteral =
                    json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
                String script =
                    "window.__onAndroidUpdateProgress && window.__onAndroidUpdateProgress("
                        + safeJsonLiteral
                        + ");";
                webView.evaluateJavascript(script, null);
            }
        );
    }
}
