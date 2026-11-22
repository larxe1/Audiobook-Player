package com.audiobook.player;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.BridgeActivity;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native Android Chrome Custom Tabs bridge for Google Sign-In & Drive OAuth inside Capacitor.
 * Exposed to the Capacitor WebView as `window.AudiobookOAuthNative`.
 */
public class AudiobookOAuthBridge {

    private static final String DEFAULT_SCOPE =
        "https://www.googleapis.com/auth/drive.readonly "
            + "https://www.googleapis.com/auth/drive.appdata "
            + "https://www.googleapis.com/auth/userinfo.email "
            + "https://www.googleapis.com/auth/userinfo.profile";
    private static final String DEFAULT_REDIRECT_URI =
        "https://larxe1.github.io/Audiobook-Player/oauth-callback.html";
    private static final String DEEP_LINK_SCHEME = "com.audiobook.player";
    private static final String DEEP_LINK_HOST = "oauth";
    private static final String REDIRECT_PREFIX = "com.audiobook.player://oauth";
    private static final long SILENT_OAUTH_TIMEOUT_MS = 6000L;
    private static final String DEFAULT_PROMPT = "select_account";
    private static final String PREFS_NAME = "audiobook_auth_prefs";
    private static final String KEY_AUTH_SESSION = "auth_session_v1";
    private static final String KEY_DEVICE_ID = "device_id_v1";

    private final BridgeActivity activity;
    private String pendingResultJson;
    private Runnable activeSilentCleanup;

    public AudiobookOAuthBridge(BridgeActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void startGoogleOAuth(
        String clientId,
        String scope,
        String loginHint,
        String state,
        String redirectUri
    ) {
        startGoogleOAuth(clientId, scope, loginHint, state, redirectUri, DEFAULT_PROMPT);
    }

    @JavascriptInterface
    public void startGoogleOAuth(
        String clientId,
        String scope,
        String loginHint,
        String state,
        String redirectUri,
        String prompt
    ) {
        synchronized (this) {
            pendingResultJson = null;
        }

        String safeClientId = clientId != null ? clientId.trim() : "";
        String safeScope = (scope != null && !scope.trim().isEmpty()) ? scope.trim() : DEFAULT_SCOPE;
        String safeRedirectUri =
            (redirectUri != null && !redirectUri.trim().isEmpty())
                ? redirectUri.trim()
                : DEFAULT_REDIRECT_URI;
        String safeState = state != null ? state.trim() : "";
        String safeHint = loginHint != null ? loginHint.trim() : "";
        String safePrompt = normalizePrompt(prompt);

        Uri.Builder builder = Uri.parse("https://accounts.google.com/o/oauth2/v2/auth")
            .buildUpon()
            .appendQueryParameter("client_id", safeClientId)
            .appendQueryParameter("redirect_uri", safeRedirectUri)
            .appendQueryParameter("response_type", "token")
            .appendQueryParameter("scope", safeScope)
            .appendQueryParameter("include_granted_scopes", "true")
            .appendQueryParameter("prompt", safePrompt);

        if (!safeState.isEmpty()) {
            builder.appendQueryParameter("state", safeState);
        }
        if (!safeHint.isEmpty()) {
            builder.appendQueryParameter("login_hint", safeHint);
        }

        final Uri authUri = builder.build();
        activity.runOnUiThread(
            () -> {
                try {
                    CustomTabColorSchemeParams colorParams =
                        new CustomTabColorSchemeParams.Builder()
                            .setToolbarColor(Color.parseColor("#060911"))
                            .build();
                    CustomTabsIntent customTabsIntent =
                        new CustomTabsIntent.Builder()
                            .setDefaultColorSchemeParams(colorParams)
                            .setShowTitle(true)
                            .build();
                    customTabsIntent.launchUrl(activity, authUri);
                } catch (Exception primaryError) {
                    try {
                        Intent fallbackIntent = new Intent(Intent.ACTION_VIEW, authUri);
                        activity.startActivity(fallbackIntent);
                    } catch (Exception fallbackError) {
                        storeAndDispatchResult(
                            null,
                            "custom_tabs_launch_failed",
                            fallbackError.getMessage(),
                            safeState
                        );
                    }
                }
            }
        );
    }

    @JavascriptInterface
    public void startSilentGoogleOAuth(final String authUrl) {
        synchronized (this) {
            pendingResultJson = null;
        }

        if (authUrl == null || authUrl.trim().isEmpty()) {
            storeAndDispatchResult(
                null,
                "invalid_auth_url",
                "Silent Google OAuth URL is empty.",
                null
            );
            return;
        }

        final String trimmedUrl = authUrl.trim();
        String parsedState = null;
        try {
            parsedState = Uri.parse(trimmedUrl).getQueryParameter("state");
        } catch (Exception ignored) {
        }
        final String fallbackState = parsedState;

        activity.runOnUiThread(
            () -> {
                if (activeSilentCleanup != null) {
                    activeSilentCleanup.run();
                }

                final Handler mainHandler = new Handler(Looper.getMainLooper());
                final AtomicBoolean completed = new AtomicBoolean(false);
                final WebView[] webViewRef = new WebView[1];
                final Runnable[] timeoutRef = new Runnable[1];

                final Runnable cleanupWebView =
                    () -> {
                        if (timeoutRef[0] != null) {
                            mainHandler.removeCallbacks(timeoutRef[0]);
                            timeoutRef[0] = null;
                        }
                        WebView wv = webViewRef[0];
                        webViewRef[0] = null;
                        if (wv != null) {
                            try {
                                wv.stopLoading();
                                if (wv.getParent() instanceof ViewGroup) {
                                    ((ViewGroup) wv.getParent()).removeView(wv);
                                }
                                wv.loadUrl("about:blank");
                                wv.clearHistory();
                                wv.removeAllViews();
                                wv.destroy();
                            } catch (Exception ignored) {
                            }
                        }
                    };

                activeSilentCleanup =
                    () -> {
                        completed.set(true);
                        cleanupWebView.run();
                    };

                try {
                    final WebView silentWebView = new WebView(activity);
                    webViewRef[0] = silentWebView;
                    silentWebView.setVisibility(View.INVISIBLE);
                    silentWebView.setFocusable(false);
                    silentWebView.setClickable(false);

                    WebSettings settings = silentWebView.getSettings();
                    settings.setJavaScriptEnabled(true);
                    settings.setDomStorageEnabled(true);
                    settings.setDatabaseEnabled(true);

                    try {
                        CookieManager cookieManager = CookieManager.getInstance();
                        cookieManager.setAcceptCookie(true);
                        cookieManager.setAcceptThirdPartyCookies(silentWebView, true);
                    } catch (Exception ignored) {
                    }

                    View rootContent = activity.findViewById(android.R.id.content);
                    if (rootContent instanceof ViewGroup) {
                        ((ViewGroup) rootContent)
                            .addView(silentWebView, new ViewGroup.LayoutParams(1, 1));
                    }

                    timeoutRef[0] =
                        () -> {
                            if (completed.compareAndSet(false, true)) {
                                activeSilentCleanup = null;
                                cleanupWebView.run();
                                storeAndDispatchResult(
                                    null,
                                    "silent_oauth_timeout",
                                    "Silent Google OAuth refresh timed out.",
                                    fallbackState
                                );
                            }
                        };
                    mainHandler.postDelayed(timeoutRef[0], SILENT_OAUTH_TIMEOUT_MS);

                    silentWebView.setWebViewClient(
                        new WebViewClient() {
                            private boolean handleInterceptedUrl(String url) {
                                if (!isSilentOAuthCallbackUrl(url)) {
                                    return false;
                                }
                                if (completed.compareAndSet(false, true)) {
                                    activeSilentCleanup = null;
                                    if (timeoutRef[0] != null) {
                                        mainHandler.removeCallbacks(timeoutRef[0]);
                                        timeoutRef[0] = null;
                                    }
                                    mainHandler.post(cleanupWebView);
                                    try {
                                        deliverOAuthRedirect(Uri.parse(url));
                                    } catch (Exception err) {
                                        storeAndDispatchResult(
                                            null,
                                            "silent_oauth_parse_error",
                                            err.getMessage(),
                                            fallbackState
                                        );
                                    }
                                }
                                return true;
                            }

                            @Override
                            public boolean shouldOverrideUrlLoading(
                                WebView view,
                                WebResourceRequest request
                            ) {
                                String url =
                                    request != null && request.getUrl() != null
                                        ? request.getUrl().toString()
                                        : null;
                                return handleInterceptedUrl(url);
                            }

                            @Override
                            @SuppressWarnings("deprecation")
                            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                                return handleInterceptedUrl(url);
                            }

                            @Override
                            public void onPageStarted(
                                WebView view,
                                String url,
                                Bitmap favicon
                            ) {
                                if (!handleInterceptedUrl(url)) {
                                    super.onPageStarted(view, url, favicon);
                                }
                            }

                            @Override
                            public void onPageFinished(WebView view, String url) {
                                if (!handleInterceptedUrl(url)) {
                                    super.onPageFinished(view, url);
                                }
                            }
                        }
                    );

                    silentWebView.loadUrl(trimmedUrl);
                } catch (Exception err) {
                    if (completed.compareAndSet(false, true)) {
                        activeSilentCleanup = null;
                        cleanupWebView.run();
                        storeAndDispatchResult(
                            null,
                            "silent_oauth_init_failed",
                            err.getMessage(),
                            fallbackState
                        );
                    }
                }
            }
        );
    }

    @JavascriptInterface
    public synchronized String consumePendingResult() {
        String result = pendingResultJson;
        pendingResultJson = null;
        return result;
    }

    @JavascriptInterface
    public boolean saveAuthSession(String sessionJson) {
        if (sessionJson == null || sessionJson.trim().isEmpty()) {
            clearAuthSession();
            return true;
        }
        try {
            return activity
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_AUTH_SESSION, sessionJson)
                .commit();
        } catch (Exception ignored) {
            return false;
        }
    }

    @JavascriptInterface
    public String loadAuthSession() {
        try {
            return activity
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_AUTH_SESSION, null);
        } catch (Exception ignored) {
            return null;
        }
    }

    @JavascriptInterface
    public boolean clearAuthSession() {
        try {
            return activity
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .remove(KEY_AUTH_SESSION)
                .commit();
        } catch (Exception ignored) {
            return false;
        }
    }

    @JavascriptInterface
    public String getDeviceId() {
        try {
            SharedPreferences prefs =
                activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String androidId = null;
            try {
                androidId = Settings.Secure.getString(
                    activity.getContentResolver(),
                    Settings.Secure.ANDROID_ID
                );
            } catch (Exception ignored) {
            }
            if (androidId != null) {
                String cleaned = androidId.trim().toLowerCase(Locale.US).replaceAll("[^a-z0-9_-]", "");
                if (!cleaned.isEmpty() && !"9774d56d682e549c".equals(cleaned)) {
                    String cached = prefs.getString(KEY_DEVICE_ID, null);
                    if (!cleaned.equals(cached)) {
                        prefs.edit().putString(KEY_DEVICE_ID, cleaned).commit();
                    }
                    return cleaned;
                }
            }
            String saved = prefs.getString(KEY_DEVICE_ID, null);
            if (saved != null && !saved.trim().isEmpty()) {
                return saved.trim();
            }
            String generated = UUID.randomUUID().toString();
            prefs.edit().putString(KEY_DEVICE_ID, generated).commit();
            return generated;
        } catch (Exception ignored) {
            return "";
        }
    }

    @JavascriptInterface
    public String getDeviceName() {
        try {
            String manufacturer = Build.MANUFACTURER != null ? Build.MANUFACTURER.trim() : "";
            String model = Build.MODEL != null ? Build.MODEL.trim() : "";
            if (model.isEmpty() && manufacturer.isEmpty()) {
                return "Android Phone";
            }
            if (manufacturer.isEmpty()) {
                return model;
            }
            if (model.isEmpty()) {
                return formatManufacturer(manufacturer);
            }
            if (model.toLowerCase(Locale.US).startsWith(manufacturer.toLowerCase(Locale.US))) {
                return model;
            }
            return formatManufacturer(manufacturer) + " " + model;
        } catch (Exception ignored) {
            return "Android Phone";
        }
    }

    private static String formatManufacturer(String raw) {
        String trimmed = raw != null ? raw.trim() : "";
        if (trimmed.isEmpty()) {
            return "";
        }
        boolean hasUpper = false;
        boolean hasLower = false;
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (Character.isUpperCase(c)) hasUpper = true;
            if (Character.isLowerCase(c)) hasLower = true;
        }
        if (hasUpper && (hasLower || trimmed.length() <= 4)) {
            return trimmed;
        }
        return trimmed.substring(0, 1).toUpperCase(Locale.US)
            + trimmed.substring(1).toLowerCase(Locale.US);
    }

    public boolean handleRedirectIntent(Intent intent) {
        if (intent == null) {
            return false;
        }
        Uri data = intent.getData();
        if (data == null) {
            return false;
        }
        if (!DEEP_LINK_SCHEME.equalsIgnoreCase(data.getScheme())
            || !DEEP_LINK_HOST.equalsIgnoreCase(data.getHost())) {
            return false;
        }

        intent.setData(null);
        return deliverOAuthRedirect(data);
    }

    private boolean deliverOAuthRedirect(Uri data) {
        if (data == null) {
            return false;
        }
        Map<String, String> params = new HashMap<>();
        parseFormEncoded(data.getEncodedQuery(), params);
        parseFormEncoded(data.getEncodedFragment(), params);

        String accessToken = params.get("access_token");
        String error = params.get("error");
        String errorDescription = params.get("error_description");
        String state = params.get("state");

        if ((accessToken == null || accessToken.isEmpty()) && (error == null || error.isEmpty())) {
            error = "missing_token";
            errorDescription = "Google OAuth callback did not include an access token.";
        }

        if (accessToken != null && !accessToken.isEmpty()) {
            persistRefreshedGoogleToken(accessToken);
        }

        storeAndDispatchResult(accessToken, error, errorDescription, state);
        return true;
    }

    private void persistRefreshedGoogleToken(String accessToken) {
        if (accessToken == null || accessToken.isEmpty()) {
            return;
        }
        try {
            String existing = loadAuthSession();
            if (existing == null || existing.trim().isEmpty()) {
                return;
            }
            JSONObject sessionObj = new JSONObject(existing);
            sessionObj.put("provider_token", accessToken);
            sessionObj.put("googleAccessToken", accessToken);
            sessionObj.put("googleTokenObtainedAt", System.currentTimeMillis());
            saveAuthSession(sessionObj.toString());
        } catch (Exception ignored) {
        }
    }

    private static boolean isSilentOAuthCallbackUrl(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        if (url.regionMatches(true, 0, REDIRECT_PREFIX, 0, REDIRECT_PREFIX.length())) {
            return true;
        }
        try {
            Uri uri = Uri.parse(url);
            String path = uri.getPath();
            if (path != null && path.endsWith("oauth-callback.html")) {
                return url.contains("access_token=") || url.contains("error=");
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private void storeAndDispatchResult(
        String accessToken,
        String error,
        String errorDescription,
        String state
    ) {
        JSONObject payload = new JSONObject();
        try {
            if (accessToken != null && !accessToken.isEmpty()) {
                payload.put("access_token", accessToken);
            }
            if (error != null && !error.isEmpty()) {
                payload.put("error", error);
            }
            if (errorDescription != null && !errorDescription.isEmpty()) {
                payload.put("error_description", errorDescription);
            }
            if (state != null && !state.isEmpty()) {
                payload.put("state", state);
            }
        } catch (JSONException ignored) {
            return;
        }

        final String json = payload.toString();
        synchronized (this) {
            pendingResultJson = json;
        }

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
                    "window.__onAndroidGoogleOAuthResult && window.__onAndroidGoogleOAuthResult("
                        + safeJsonLiteral
                        + ");";
                webView.evaluateJavascript(script, null);
            }
        );
    }

    private static void parseFormEncoded(String raw, Map<String, String> out) {
        if (raw == null || raw.isEmpty()) {
            return;
        }
        String[] pairs = raw.split("&");
        for (String pair : pairs) {
            if (pair == null || pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String rawKey = eq >= 0 ? pair.substring(0, eq) : pair;
            String rawVal = eq >= 0 ? pair.substring(eq + 1) : "";
            String key = urlDecode(rawKey);
            String val = urlDecode(rawVal);
            if (!key.isEmpty()) {
                out.put(key, val);
            }
        }
    }

    private static String normalizePrompt(String prompt) {
        if (prompt == null) {
            return DEFAULT_PROMPT;
        }
        String normalized = prompt.trim().replaceAll("\\s+", " ");
        String lower = normalized.toLowerCase(Locale.US);
        if ("none".equals(lower)) {
            return "none";
        }
        if ("select_account".equals(lower)
            || "select_account consent".equals(lower)
            || "consent".equals(lower)) {
            return lower;
        }
        return DEFAULT_PROMPT;
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return value;
        }
    }
}
