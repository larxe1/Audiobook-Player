#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use serde::Serialize;
use tauri::{window::Color, App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const GOOGLE_CLIENT_ID: &str =
    "572567924584-qj0m9fkkkjsrgva6dj32or7esbgkqvql.apps.googleusercontent.com";
const GOOGLE_OAUTH_REDIRECT_URI: &str =
    "storagerelay%3A%2F%2Fhttps%2Fnotetaking-app.pages.dev%3Fid%3Dauth123456";
const GOOGLE_OAUTH_SCOPE: &str =
    "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly%20email%20profile";

struct AppState {
    oauth_path: PathBuf,
    oauth_token: Arc<Mutex<Option<String>>>,
    oauth_status: Arc<Mutex<String>>,
}

#[derive(Serialize)]
struct OAuthPollResponse {
    status: String,
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

fn app_local_dir() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local).join("com.audiobook.player");
        let _ = fs::create_dir_all(&dir);
        return dir;
    }
    let fallback = std::env::temp_dir().join("com.audiobook.player");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log_startup(message: &str) {
    let log_path = app_local_dir().join("startup.log");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{ts} pid={}] {message}", std::process::id());
    }
}

fn percent_decode_simple(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn extract_ya29_token(s: &str) -> Option<String> {
    let decoded = percent_decode_simple(s);
    for candidate in [s, decoded.as_str()] {
        if let Some(idx) = candidate.find("ya29.") {
            let rest = &candidate[idx..];
            let token: String = rest
                .chars()
                .take_while(|c| {
                    c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.'
                })
                .collect();
            if token.len() > 20 {
                return Some(token);
            }
        }
    }
    None
}

fn url_encode_param(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn load_saved_oauth_token(oauth_path: &Path) -> Option<String> {
    let raw = fs::read_to_string(oauth_path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let token = json.get("access_token")?.as_str()?.to_string();
    let saved_at = json.get("saved_at_ms")?.as_u64()?;
    if now_ms().saturating_sub(saved_at) < 52 * 60 * 1000 && token.starts_with("ya29.") {
        Some(token)
    } else {
        None
    }
}

fn save_oauth_token(oauth_path: &Path, token: &str) {
    let payload = serde_json::json!({
        "access_token": token,
        "saved_at_ms": now_ms(),
    });
    if let Ok(s) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(oauth_path, s);
    }
}

const OAUTH_INIT_SCRIPT: &str = r#"
(function() {
  function reportToken(tok) {
    if (!tok || window.__TAURI_TOKEN_SENT__) return;
    window.__TAURI_TOKEN_SENT__ = true;
    try {
      window.location.replace('http://127.0.0.1:19877/__tauri_oauth?token=' + encodeURIComponent(tok));
    } catch (e) {}
  }

  function reportError(err) {
    if (window.__TAURI_TOKEN_SENT__) return;
    window.__TAURI_TOKEN_SENT__ = true;
    try {
      window.location.replace('http://127.0.0.1:19877/__tauri_oauth_error?error=' + encodeURIComponent(String(err || 'oauth_error')));
    } catch (e) {}
  }

  function inspectPayload(val) {
    if (!val) return false;
    try {
      var s = '';
      if (typeof val === 'string') {
        s = val;
      } else if (typeof val === 'object') {
        if (val.access_token && typeof val.access_token === 'string') {
          s = val.access_token;
        } else {
          try { s = JSON.stringify(val); } catch (e) {}
        }
      }
      if (!s) return false;
      var m = s.match(/ya29\.[A-Za-z0-9_\-\.]+/);
      if (m && m[0] && m[0].length > 20) {
        reportToken(m[0]);
        return true;
      }
      if (
        s.indexOf('interaction_required') !== -1 ||
        s.indexOf('login_required') !== -1 ||
        s.indexOf('consent_required') !== -1 ||
        s.indexOf('immediate_failed') !== -1 ||
        s.indexOf('account_selection_required') !== -1
      ) {
        reportError('needs_interactive');
        return true;
      }
    } catch (e) {}
    return false;
  }

  window.addEventListener('message', function(e) {
    try {
      if (e && e.data) inspectPayload(e.data);
    } catch (e) {}
  }, true);

  function checkUrl() {
    try {
      inspectPayload(window.location.href);
      inspectPayload(window.location.hash);
      inspectPayload(window.location.search);
    } catch (e) {}
  }
  window.addEventListener('hashchange', checkUrl);
  setInterval(checkUrl, 350);

  var fakeOpener = {
    closed: false,
    location: { href: 'https://notetaking-app.pages.dev/' },
    postMessage: function(msg) {
      inspectPayload(msg);
    },
    frames: []
  };

  try {
    Object.defineProperty(window, 'opener', {
      value: fakeOpener,
      writable: true,
      configurable: true
    });
  } catch (e) {
    try { window.opener = fakeOpener; } catch (e2) {}
  }
})();
"#;

#[tauri::command]
async fn desktop_start_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    silent: Option<bool>,
    login_hint: Option<String>,
    force_refresh: Option<bool>,
) -> Result<OAuthPollResponse, String> {
    let is_silent = silent.unwrap_or(false);
    let is_force = force_refresh.unwrap_or(false);

    if is_silent && !is_force {
        if let Some(saved) = load_saved_oauth_token(&state.oauth_path) {
            if let Ok(mut g) = state.oauth_token.lock() {
                *g = Some(saved.clone());
            }
            if let Ok(mut st) = state.oauth_status.lock() {
                *st = "success".into();
            }
            return Ok(OAuthPollResponse {
                status: "success".into(),
                access_token: Some(saved),
            });
        }
    }

    if let Ok(mut g) = state.oauth_token.lock() {
        *g = None;
    }
    if let Ok(mut st) = state.oauth_status.lock() {
        *st = "pending".into();
    }

    let win_label = "google-auth";
    if let Some(existing) = app.get_webview_window(win_label) {
        let _ = existing.destroy();
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    let hint_email = login_hint
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.contains('@'))
        .unwrap_or_default();

    let prompt_param = if is_silent { "none" } else { "select_account" };
    let hint_clause = if hint_email.is_empty() {
        String::new()
    } else {
        format!("&login_hint={}", url_encode_param(&hint_email))
    };

    let auth_url_str = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=3&client_id={}&scope={}&redirect_uri={}&prompt={}{}&response_type=token&include_granted_scopes=true",
        GOOGLE_CLIENT_ID,
        GOOGLE_OAUTH_SCOPE,
        GOOGLE_OAUTH_REDIRECT_URI,
        prompt_param,
        hint_clause
    );
    let parsed_url = tauri::Url::parse(&auth_url_str).map_err(|e| e.to_string())?;

    let token_arc = Arc::clone(&state.oauth_token);
    let status_arc = Arc::clone(&state.oauth_status);
    let oauth_path = state.oauth_path.clone();
    let app_for_nav = app.clone();

    let mut builder = WebviewWindowBuilder::new(&app, win_label, WebviewUrl::External(parsed_url))
        .title("Continue with Google — Audiobook Player")
        .inner_size(500.0, 680.0)
        .center()
        .visible(!is_silent)
        .focused(!is_silent)
        .skip_taskbar(is_silent)
        .initialization_script(OAUTH_INIT_SCRIPT);

    builder = builder.on_navigation(move |url| {
        let url_str = url.as_str();
        if let Some(tok) = extract_ya29_token(url_str) {
            save_oauth_token(&oauth_path, &tok);
            if let Ok(mut g) = token_arc.lock() {
                *g = Some(tok);
            }
            if let Ok(mut st) = status_arc.lock() {
                *st = "success".into();
            }
            let app_clone = app_for_nav.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(80));
                if let Some(w) = app_clone.get_webview_window("google-auth") {
                    let _ = w.close();
                }
            });
            return false;
        }
        if is_silent
            && (url_str.contains("__tauri_oauth_error")
                || url_str.contains("error=")
                || url_str.contains("ServiceLogin")
                || url_str.contains("AccountChooser"))
        {
            if let Ok(mut st) = status_arc.lock() {
                *st = "needs_interactive".into();
            }
            let app_clone = app_for_nav.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if let Some(w) = app_clone.get_webview_window("google-auth") {
                    let _ = w.close();
                }
            });
            return false;
        }
        if url_str.starts_with("http://127.0.0.1:19877/") || url_str.starts_with("storagerelay://") {
            return false;
        }
        true
    });

    builder.build().map_err(|e| e.to_string())?;

    Ok(OAuthPollResponse {
        status: "pending".into(),
        access_token: None,
    })
}

#[tauri::command]
async fn desktop_poll_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<OAuthPollResponse, String> {
    let tok_opt = state.oauth_token.lock().ok().and_then(|g| g.clone());
    if let Some(tok) = tok_opt {
        if let Some(w) = app.get_webview_window("google-auth") {
            let _ = w.close();
        }
        return Ok(OAuthPollResponse {
            status: "success".into(),
            access_token: Some(tok),
        });
    }

    let mut status = state
        .oauth_status
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_else(|| "idle".into());

    if status == "pending" && app.get_webview_window("google-auth").is_none() {
        status = "closed".into();
        if let Ok(mut st) = state.oauth_status.lock() {
            *st = "closed".into();
        }
    }

    Ok(OAuthPollResponse {
        status,
        access_token: None,
    })
}

#[tauri::command]
async fn desktop_clear_google_oauth(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    if let Ok(mut g) = state.oauth_token.lock() {
        *g = None;
    }
    if let Ok(mut st) = state.oauth_status.lock() {
        *st = "idle".into();
    }
    let _ = fs::remove_file(&state.oauth_path);
    Ok(true)
}

fn build_main_window(
    app: &App,
    label: &str,
    data_directory: Option<PathBuf>,
) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Audiobook Player")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 620.0)
        .resizable(true)
        .background_color(Color(6, 9, 17, 255))
        .visible(true)
        .focused(true);

    if let Some(dir) = data_directory {
        let _ = fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }

    builder.build()
}

fn create_main_window_with_fallback(app: &App) -> tauri::Result<WebviewWindow> {
    match build_main_window(app, "main", None) {
        Ok(win) => Ok(win),
        Err(primary_err) => {
            log_startup(&format!(
                "Primary WebView2 window failed ({primary_err}); retrying with isolated profile directory"
            ));

            if let Some(leftover) = app.get_webview_window("main") {
                let _ = leftover.destroy();
            }

            let fallback_dir = app_local_dir()
                .join("profiles")
                .join(format!("session-{}", std::process::id()));

            let label = if app.get_webview_window("main").is_none() {
                "main".to_string()
            } else {
                format!("main-{}", std::process::id())
            };

            build_main_window(app, &label, Some(fallback_dir))
        }
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log_startup(&format!("PANIC: {info}"));
    }));

    let oauth_path = app_local_dir().join("google_oauth.json");
    let state = AppState {
        oauth_path,
        oauth_token: Arc::new(Mutex::new(None)),
        oauth_status: Arc::new(Mutex::new("idle".into())),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            desktop_start_google_oauth,
            desktop_poll_google_oauth,
            desktop_clear_google_oauth
        ])
        .setup(|app| {
            let win = create_main_window_with_fallback(app)?;
            let _ = win.show();
            let _ = win.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Audiobook Player");
}
