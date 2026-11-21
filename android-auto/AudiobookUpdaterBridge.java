package com.audiobook.player;

import android.content.Intent;
import android.content.pm.PackageInfo;
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
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native Android APK and Web OTA updater bridge for Capacitor.
 * Exposed to the WebView as `window.AudiobookUpdaterNative`.
 */
public class AudiobookUpdaterBridge {

    private static final String ALLOWED_PREFIX_GITHUB =
        "https://github.com/larxe1/Audiobook-Player/";
    private static final String ALLOWED_PREFIX_OBJECTS =
        "https://objects.githubusercontent.com/";
    private static final String APK_FILENAME = "Audiobook-Player-update.apk";
    private static final String WEB_OTA_FILENAME = "web-bundle-update.zip";
    private static final long MIN_APK_BYTES = 500_000L;
    private static final long MIN_WEB_OTA_BYTES = 10_000L;
    private static final int MAX_REDIRECTS = 8;

    private final BridgeActivity activity;
    private final AtomicBoolean downloadInProgress = new AtomicBoolean(false);

    public AudiobookUpdaterBridge(BridgeActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    @SuppressWarnings("deprecation")
    public int getNativeBuild() {
        try {
            PackageInfo info = activity
                .getPackageManager()
                .getPackageInfo(activity.getPackageName(), 0);
            if (info == null) {
                return 0;
            }
            if (Build.VERSION.SDK_INT >= 28) {
                return (int) info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (Exception ignored) {
            return 0;
        }
    }

    @JavascriptInterface
    public void startWebOtaUpdate(final String zipUrl) {
        final String trimmedUrl = zipUrl != null ? zipUrl.trim() : "";
        if (!isAllowedInitialUrl(trimmedUrl)) {
            dispatchProgress("error", -1, "Untrusted Web OTA download URL.");
            return;
        }

        if (!downloadInProgress.compareAndSet(false, true)) {
            dispatchProgress("downloading", 0, "Update download is already in progress.");
            return;
        }

        new Thread(
            () -> {
                File zipFile = null;
                File stagingDir = null;
                try {
                    dispatchProgress("downloading", 0, "Downloading fast in-app update...");
                    File cacheRoot = activity.getCacheDir();
                    if (cacheRoot == null) {
                        cacheRoot = activity.getExternalCacheDir();
                    }
                    if (cacheRoot == null) {
                        throw new IOException("No cache directory available for Web OTA download.");
                    }
                    if (!cacheRoot.exists()) {
                        cacheRoot.mkdirs();
                    }

                    zipFile = new File(cacheRoot, WEB_OTA_FILENAME);
                    if (zipFile.exists()) {
                        zipFile.delete();
                    }

                    downloadWithRedirects(trimmedUrl, zipFile);

                    if (!zipFile.exists() || zipFile.length() <= MIN_WEB_OTA_BYTES) {
                        long len = zipFile.exists() ? zipFile.length() : 0L;
                        throw new IOException(
                            "Downloaded Web OTA bundle is invalid or too small (" + len + " bytes)."
                        );
                    }

                    if (!hasZipPkHeader(zipFile)) {
                        throw new IOException(
                            "Downloaded Web OTA bundle is not a valid ZIP archive (missing PK header)."
                        );
                    }

                    File filesRoot = activity.getFilesDir();
                    if (filesRoot == null) {
                        throw new IOException("No internal files directory available for Web OTA.");
                    }

                    stagingDir = new File(filesRoot, "ota-web-staging");
                    deleteRecursive(stagingDir);
                    if (!stagingDir.mkdirs() && !stagingDir.isDirectory()) {
                        throw new IOException("Failed to create Web OTA staging directory.");
                    }

                    final String stagingCanonical = stagingDir.getCanonicalPath();
                    unzipToStaging(zipFile, stagingDir, stagingCanonical);

                    File stagedIndex = new File(stagingDir, "index.html");
                    File stagedVersion = new File(stagingDir, "version.json");
                    if (!stagedIndex.isFile() || !stagedVersion.isFile()) {
                        throw new IOException("Web OTA bundle missing index.html or version.json.");
                    }

                    File otaDir = new File(filesRoot, "ota-web");
                    File oldDir = new File(filesRoot, "ota-web-old");
                    deleteRecursive(oldDir);
                    if (otaDir.exists() && !otaDir.renameTo(oldDir)) {
                        deleteRecursive(otaDir);
                    }
                    if (!stagingDir.renameTo(otaDir)) {
                        if (oldDir.exists() && !otaDir.exists()) {
                            oldDir.renameTo(otaDir);
                        }
                        throw new IOException("Failed to swap Web OTA update into place.");
                    }
                    deleteRecursive(oldDir);

                    if (zipFile.exists()) {
                        zipFile.delete();
                    }

                    dispatchProgress("reloading", 100, "Applying update...");
                    final String otaPath = otaDir.getAbsolutePath();
                    activity.runOnUiThread(
                        () -> {
                            try {
                                if (activity.getBridge() != null) {
                                    WebView webView = activity.getBridge().getWebView();
                                    if (webView != null) {
                                        webView.clearCache(true);
                                    }
                                    activity.getBridge().setServerBasePath(otaPath);
                                    if (webView != null) {
                                        webView.reload();
                                    }
                                }
                            } catch (Exception e) {
                                dispatchProgress(
                                    "error",
                                    -1,
                                    "Failed to apply Web OTA bundle: " + e.getMessage()
                                );
                            }
                        }
                    );
                } catch (Exception e) {
                    if (zipFile != null && zipFile.exists()) {
                        zipFile.delete();
                    }
                    if (stagingDir != null && stagingDir.exists()) {
                        deleteRecursive(stagingDir);
                    }
                    String msg = e.getMessage();
                    if (msg == null || msg.trim().isEmpty()) {
                        msg = "Web OTA update failed.";
                    }
                    dispatchProgress("error", -1, msg);
                } finally {
                    downloadInProgress.set(false);
                }
            },
            "AudiobookWebOtaUpdater"
        ).start();
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
                    "Allow Install unknown apps for MultiPlayer, then tap Update again."
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

    private static void unzipToStaging(File zipFile, File stagingDir, String stagingCanonical)
        throws IOException {
        try (
            ZipInputStream zis = new ZipInputStream(
                new BufferedInputStream(new FileInputStream(zipFile))
            )
        ) {
            ZipEntry entry;
            byte[] buffer = new byte[16384];
            while ((entry = zis.getNextEntry()) != null) {
                String entryName = entry.getName();
                if (entryName == null || entryName.trim().isEmpty()) {
                    zis.closeEntry();
                    continue;
                }
                File dest = new File(stagingDir, entryName);
                String destCanonical = dest.getCanonicalPath();
                if (entry.isDirectory() && destCanonical.equals(stagingCanonical)) {
                    zis.closeEntry();
                    continue;
                }
                if (!destCanonical.startsWith(stagingCanonical + File.separator)) {
                    throw new IOException("Blocked unsafe ZIP entry path: " + entryName);
                }
                if (entry.isDirectory()) {
                    if (!dest.exists() && !dest.mkdirs()) {
                        throw new IOException("Failed to create directory: " + entryName);
                    }
                } else {
                    File parent = dest.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs()) {
                        throw new IOException("Failed to create parent directory for: " + entryName);
                    }
                    try (FileOutputStream fos = new FileOutputStream(dest, false)) {
                        int count;
                        while ((count = zis.read(buffer)) != -1) {
                            fos.write(buffer, 0, count);
                        }
                        fos.flush();
                    }
                }
                zis.closeEntry();
            }
        }
    }

    private static void deleteRecursive(File target) {
        if (target == null || !target.exists()) {
            return;
        }
        File[] children = target.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursive(child);
            }
        }
        target.delete();
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
