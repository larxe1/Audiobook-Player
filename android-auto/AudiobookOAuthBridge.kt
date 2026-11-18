package com.audiobook.player

import android.annotation.SuppressLint
import android.app.Dialog
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * Native Android WebView popup bridge for Google Sign-In & Drive OAuth inside Capacitor.
 * Exposes `window.__ANDROID_GOOGLE_OAUTH__(clientId, scope, hint)` to the web UI so
 * "Continue with Google" opens a clean in-app popup matching the Windows Tauri OAuth popup.
 */
class AudiobookOAuthBridge(private val activity: AppCompatActivity) {

    @SuppressLint("SetJavaScriptEnabled")
    fun openGoogleOAuthDialog(
        clientId: String,
        scope: String,
        loginHint: String,
        onResult: (accessToken: String?, error: String?) -> Unit
    ) {
        activity.runOnUiThread {
            val dialog = Dialog(activity, android.R.style.Theme_Material_NoActionBar)
            val webView = WebView(activity).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                setBackgroundColor(Color.parseColor("#060911"))
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
            }

            var settled = false
            fun finish(token: String?, error: String?) {
                if (settled) return
                settled = true
                activity.runOnUiThread {
                    if (dialog.isShowing) dialog.dismiss()
                    webView.destroy()
                    onResult(token, error)
                }
            }

            webView.addJavascriptInterface(object {
                @JavascriptInterface
                fun onToken(token: String) = finish(token, null)

                @JavascriptInterface
                fun onError(err: String) = finish(null, err)
            }, "AudiobookOAuthNative")

            webView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val urlStr = request?.url?.toString() ?: return false
                    extractAccessToken(urlStr)?.let { token ->
                        finish(token, null)
                        return true
                    }
                    if (urlStr.startsWith("storagerelay://") || urlStr.contains("error=")) {
                        finish(null, "oauth_cancelled")
                        return true
                    }
                    return false
                }
            }

            val authUri = Uri.parse("https://accounts.google.com/o/oauth2/v2/auth")
                .buildUpon()
                .appendQueryParameter("gsiwebsdk", "3")
                .appendQueryParameter("client_id", clientId)
                .appendQueryParameter("scope", scope)
                .appendQueryParameter("redirect_uri", "storagerelay://https/notetaking-app.pages.dev?id=auth123456")
                .appendQueryParameter("response_type", "token")
                .appendQueryParameter("include_granted_scopes", "true")
                .appendQueryParameter("prompt", "select_account")
                .apply {
                    if (loginHint.isNotBlank()) appendQueryParameter("login_hint", loginHint)
                }
                .build()

            dialog.setOnCancelListener { finish(null, "popup_closed") }
            dialog.setContentView(webView)
            dialog.show()
            webView.loadUrl(authUri.toString())
        }
    }

    private fun extractAccessToken(raw: String): String? {
        val decoded = Uri.decode(raw)
        val match = Regex("""ya29\.[A-Za-z0-9_\-.]{20,}""").find(decoded)
        return match?.value
    }

    fun toJsonPayload(token: String?, error: String?): String = JSONObject().apply {
        if (token != null) put("access_token", token)
        if (error != null) put("error", error)
    }.toString()
}
