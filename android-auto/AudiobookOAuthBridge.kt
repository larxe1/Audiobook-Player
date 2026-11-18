package com.audiobook.player

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.webkit.JavascriptInterface
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.BridgeActivity
import java.net.URLDecoder
import org.json.JSONObject

/**
 * Native Android Chrome Custom Tabs bridge for Google Sign-In & Drive OAuth inside Capacitor.
 * Exposed to the Capacitor WebView as `window.AudiobookOAuthNative`.
 */
class AudiobookOAuthBridge(private val activity: BridgeActivity) {

    @Volatile
    private var pendingResultJson: String? = null

    companion object {
        private const val DEFAULT_SCOPE =
            "https://www.googleapis.com/auth/drive.readonly " +
                "https://www.googleapis.com/auth/userinfo.email " +
                "https://www.googleapis.com/auth/userinfo.profile"
        private const val DEFAULT_REDIRECT_URI =
            "https://larxe1.github.io/Audiobook-Player/oauth-callback.html"
        private const val DEEP_LINK_SCHEME = "com.audiobook.player"
        private const val DEEP_LINK_HOST = "oauth"
    }

    @JavascriptInterface
    fun startGoogleOAuth(
        clientId: String?,
        scope: String?,
        loginHint: String?,
        state: String?,
        redirectUri: String?
    ) {
        synchronized(this) {
            pendingResultJson = null
        }

        val safeClientId = clientId?.trim().orEmpty()
        val safeScope = scope?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_SCOPE
        val safeRedirectUri = redirectUri?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_REDIRECT_URI
        val safeState = state?.trim().orEmpty()
        val safeHint = loginHint?.trim().orEmpty()

        val authUri = Uri.parse("https://accounts.google.com/o/oauth2/v2/auth")
            .buildUpon()
            .appendQueryParameter("client_id", safeClientId)
            .appendQueryParameter("redirect_uri", safeRedirectUri)
            .appendQueryParameter("response_type", "token")
            .appendQueryParameter("scope", safeScope)
            .appendQueryParameter("include_granted_scopes", "true")
            .appendQueryParameter("prompt", "select_account")
            .apply {
                if (safeState.isNotEmpty()) appendQueryParameter("state", safeState)
                if (safeHint.isNotEmpty()) appendQueryParameter("login_hint", safeHint)
            }
            .build()

        activity.runOnUiThread {
            try {
                val colorParams = CustomTabColorSchemeParams.Builder()
                    .setToolbarColor(Color.parseColor("#060911"))
                    .build()
                val customTabsIntent = CustomTabsIntent.Builder()
                    .setDefaultColorSchemeParams(colorParams)
                    .setShowTitle(true)
                    .build()
                customTabsIntent.launchUrl(activity, authUri)
            } catch (_: Exception) {
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, authUri))
                } catch (fallbackError: Exception) {
                    storeAndDispatchResult(
                        accessToken = null,
                        error = "custom_tabs_launch_failed",
                        errorDescription = fallbackError.message,
                        state = safeState
                    )
                }
            }
        }
    }

    @JavascriptInterface
    @Synchronized
    fun consumePendingResult(): String? {
        val result = pendingResultJson
        pendingResultJson = null
        return result
    }

    fun handleRedirectIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (!DEEP_LINK_SCHEME.equals(data.scheme, ignoreCase = true) ||
            !DEEP_LINK_HOST.equals(data.host, ignoreCase = true)
        ) {
            return false
        }

        val params = LinkedHashMap<String, String>()
        parseFormEncoded(data.encodedQuery, params)
        parseFormEncoded(data.encodedFragment, params)

        val accessToken = params["access_token"]
        var error = params["error"]
        var errorDescription = params["error_description"]
        val state = params["state"]

        if (accessToken.isNullOrEmpty() && error.isNullOrEmpty()) {
            error = "missing_token"
            errorDescription = "Google OAuth callback did not include an access token."
        }

        intent.data = null
        storeAndDispatchResult(accessToken, error, errorDescription, state)
        return true
    }

    private fun storeAndDispatchResult(
        accessToken: String?,
        error: String?,
        errorDescription: String?,
        state: String?
    ) {
        val json = JSONObject().apply {
            if (!accessToken.isNullOrEmpty()) put("access_token", accessToken)
            if (!error.isNullOrEmpty()) put("error", error)
            if (!errorDescription.isNullOrEmpty()) put("error_description", errorDescription)
            if (!state.isNullOrEmpty()) put("state", state)
        }.toString()

        synchronized(this) {
            pendingResultJson = json
        }

        activity.runOnUiThread {
            val webView = activity.bridge?.webView ?: return@runOnUiThread
            val safeJsonLiteral = json
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029")
            val script =
                "window.__onAndroidGoogleOAuthResult && window.__onAndroidGoogleOAuthResult($safeJsonLiteral);"
            webView.evaluateJavascript(script, null)
        }
    }

    private fun parseFormEncoded(raw: String?, out: MutableMap<String, String>) {
        if (raw.isNullOrEmpty()) return
        for (pair in raw.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val rawKey = if (eq >= 0) pair.substring(0, eq) else pair
            val rawVal = if (eq >= 0) pair.substring(eq + 1) else ""
            val key = urlDecode(rawKey)
            val value = urlDecode(rawVal)
            if (key.isNotEmpty()) {
                out[key] = value
            }
        }
    }

    private fun urlDecode(value: String): String = try {
        URLDecoder.decode(value, "UTF-8")
    } catch (_: Exception) {
        value
    }
}
