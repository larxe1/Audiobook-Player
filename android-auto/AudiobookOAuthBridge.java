package com.audiobook.player;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.BridgeActivity;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;
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
    private static final String DEFAULT_PROMPT = "select_account";
    private static final String PREFS_NAME = "audiobook_auth_prefs";
    private static final String KEY_AUTH_SESSION = "auth_session_v1";

    private final BridgeActivity activity;
    private String pendingResultJson;

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

        intent.setData(null);
        storeAndDispatchResult(accessToken, error, errorDescription, state);
        return true;
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
        if ("select_account".equals(normalized)
            || "select_account consent".equals(normalized)
            || "consent".equals(normalized)) {
            return normalized;
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
