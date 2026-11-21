#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use serde::Serialize;
use tauri::{window::Color, App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const GOOGLE_CLIENT_ID: &str =
    "22283534025-av56s1jjavk740hd5n4i7r10jkjajd1f.apps.googleusercontent.com";
const GOOGLE_OAUTH_REDIRECT_URI: &str =
    "https%3A%2F%2Flarxe1.github.io%2FAudiobook-Player%2Foauth-callback.html";
const GOOGLE_OAUTH_SCOPE: &str =
    "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata%20email%20profile";

struct AppState {
    oauth_path: PathBuf,
    session_path: PathBuf,
    oauth_token: Arc<Mutex<Option<String>>>,
    oauth_status: Arc<Mutex<String>>,
    oauth_attempt_id: Arc<AtomicU64>,
}

#[derive(Serialize)]
struct OAuthPollResponse {
    status: String,
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "attemptId")]
    attempt_id: Option<u64>,
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
    let has_appdata = json
        .get("has_appdata_scope")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !has_appdata {
        return None;
    }
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
        "has_appdata_scope": true,
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
    force_consent: Option<bool>,
) -> Result<OAuthPollResponse, String> {
    let is_consent = force_consent.unwrap_or(false);
    let is_silent = silent.unwrap_or(false) && !is_consent;
    let is_force = force_refresh.unwrap_or(false);
    let my_attempt_id = state.oauth_attempt_id.fetch_add(1, Ordering::SeqCst) + 1;

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
                attempt_id: Some(my_attempt_id),
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

    let prompt_param = if is_silent {
        "none"
    } else if is_consent {
        "select_account%20consent"
    } else {
        "select_account"
    };
    let hint_clause = if hint_email.is_empty() {
        String::new()
    } else {
        format!("&login_hint={}", url_encode_param(&hint_email))
    };

    let state_param = format!("tauri_{}", now_ms());
    let auth_url_str = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&scope={}&redirect_uri={}&prompt={}{}&response_type=token&include_granted_scopes=true&state={}",
        GOOGLE_CLIENT_ID,
        GOOGLE_OAUTH_SCOPE,
        GOOGLE_OAUTH_REDIRECT_URI,
        prompt_param,
        hint_clause,
        state_param
    );
    let parsed_url = tauri::Url::parse(&auth_url_str).map_err(|e| e.to_string())?;

    let token_arc = Arc::clone(&state.oauth_token);
    let status_arc = Arc::clone(&state.oauth_status);
    let attempt_arc = Arc::clone(&state.oauth_attempt_id);
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
        if attempt_arc.load(Ordering::SeqCst) != my_attempt_id {
            return false;
        }
        let url_str = url.as_str();
        if let Some(tok) = extract_ya29_token(url_str) {
            if attempt_arc.load(Ordering::SeqCst) != my_attempt_id {
                return false;
            }
            save_oauth_token(&oauth_path, &tok);
            if let Ok(mut g) = token_arc.lock() {
                *g = Some(tok);
            }
            if let Ok(mut st) = status_arc.lock() {
                *st = "success".into();
            }
            let app_clone = app_for_nav.clone();
            let attempt_arc_close = Arc::clone(&attempt_arc);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(80));
                if attempt_arc_close.load(Ordering::SeqCst) == my_attempt_id {
                    if let Some(w) = app_clone.get_webview_window("google-auth") {
                        let _ = w.close();
                    }
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
            if attempt_arc.load(Ordering::SeqCst) != my_attempt_id {
                return false;
            }
            if let Ok(mut st) = status_arc.lock() {
                *st = "needs_interactive".into();
            }
            let app_clone = app_for_nav.clone();
            let attempt_arc_close = Arc::clone(&attempt_arc);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if attempt_arc_close.load(Ordering::SeqCst) == my_attempt_id {
                    if let Some(w) = app_clone.get_webview_window("google-auth") {
                        let _ = w.close();
                    }
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
        attempt_id: Some(my_attempt_id),
    })
}

#[tauri::command]
async fn desktop_poll_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    attempt_id: Option<u64>,
) -> Result<OAuthPollResponse, String> {
    let current_attempt = state.oauth_attempt_id.load(Ordering::SeqCst);
    if let Some(req_id) = attempt_id {
        if current_attempt != req_id {
            return Ok(OAuthPollResponse {
                status: "superseded".into(),
                access_token: None,
                attempt_id: Some(current_attempt),
            });
        }
    }

    let tok_opt = state.oauth_token.lock().ok().and_then(|g| g.clone());
    if let Some(tok) = tok_opt {
        if let Some(w) = app.get_webview_window("google-auth") {
            let _ = w.close();
        }
        return Ok(OAuthPollResponse {
            status: "success".into(),
            access_token: Some(tok),
            attempt_id: Some(current_attempt),
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
        attempt_id: Some(current_attempt),
    })
}

#[tauri::command]
async fn desktop_clear_google_oauth(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state.oauth_attempt_id.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut g) = state.oauth_token.lock() {
        *g = None;
    }
    if let Ok(mut st) = state.oauth_status.lock() {
        *st = "idle".into();
    }
    let _ = fs::remove_file(&state.oauth_path);
    Ok(true)
}

fn session_backup_path(session_path: &Path) -> PathBuf {
    let mut bak_os = session_path.as_os_str().to_os_string();
    bak_os.push(".bak");
    PathBuf::from(bak_os)
}

fn read_valid_session_json(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    if !parsed.is_object() {
        return None;
    }
    Some(raw)
}

#[tauri::command]
async fn desktop_save_auth_session(
    state: tauri::State<'_, AppState>,
    session_json: String,
) -> Result<bool, String> {
    serde_json::from_str::<serde_json::Value>(&session_json)
        .map_err(|e| format!("Invalid session JSON: {e}"))?;

    if let Some(parent) = state.session_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    fs::write(&state.session_path, session_json.as_bytes())
        .map_err(|e| format!("Failed to write auth session: {e}"))?;

    let bak_path = session_backup_path(&state.session_path);
    fs::write(&bak_path, session_json.as_bytes())
        .map_err(|e| format!("Failed to write auth session backup: {e}"))?;

    Ok(true)
}

#[tauri::command]
async fn desktop_load_auth_session(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    if let Some(raw) = read_valid_session_json(&state.session_path) {
        return Ok(Some(raw));
    }
    let bak_path = session_backup_path(&state.session_path);
    Ok(read_valid_session_json(&bak_path))
}

#[tauri::command]
async fn desktop_clear_auth_session(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let _ = fs::remove_file(&state.session_path);
    let _ = fs::remove_file(session_backup_path(&state.session_path));
    Ok(true)
}

fn is_allowed_update_url(url: &str) -> bool {
    let allowed_prefixes = [
        "https://github.com/larxe1/Audiobook-Player/",
        "https://objects.githubusercontent.com/",
    ];
    if !allowed_prefixes.iter().any(|p| url.starts_with(p)) {
        return false;
    }
    !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

#[tauri::command]
async fn desktop_install_update(
    app: tauri::AppHandle,
    url: String,
) -> Result<serde_json::Value, String> {
    let trimmed_url = url.trim().to_string();
    if !is_allowed_update_url(&trimmed_url) {
        return Err("Update URL is not from an allowed GitHub release origin.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::Read;

        let temp_dir = std::env::temp_dir();
        let temp_exe = temp_dir.join("Audiobook-Player-update.exe");
        let _ = fs::remove_file(&temp_exe);

        let mut curl_cmd = std::process::Command::new("curl.exe");
        curl_cmd
            .arg("-fSL")
            .arg("--retry")
            .arg("2")
            .arg("--connect-timeout")
            .arg("15")
            .arg("-o")
            .arg(&temp_exe)
            .arg(&trimmed_url);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            curl_cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = curl_cmd
            .output()
            .map_err(|e| format!("Failed to invoke curl.exe: {e}"))?;
        if !output.status.success() {
            let _ = fs::remove_file(&temp_exe);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Update download failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                stderr.trim()
            ));
        }

        let meta = fs::metadata(&temp_exe)
            .map_err(|e| format!("Downloaded update binary missing: {e}"))?;
        if meta.len() <= 1_000_000 {
            let _ = fs::remove_file(&temp_exe);
            return Err(format!(
                "Downloaded update binary is unexpectedly small ({} bytes).",
                meta.len()
            ));
        }

        let mut header = [0u8; 2];
        {
            let mut file = fs::File::open(&temp_exe)
                .map_err(|e| format!("Failed to inspect downloaded update: {e}"))?;
            file.read_exact(&mut header)
                .map_err(|e| format!("Failed to read update header: {e}"))?;
        }
        if &header != b"MZ" {
            let _ = fs::remove_file(&temp_exe);
            return Err("Downloaded file is not a valid Windows executable (missing MZ header).".into());
        }

        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to resolve current executable path: {e}"))?;
        let current_exe_raw = current_exe.to_string_lossy();
        let current_exe_str = current_exe_raw
            .strip_prefix(r"\\?\")
            .unwrap_or(&current_exe_raw);
        let temp_exe_raw = temp_exe.to_string_lossy();
        let temp_exe_str = temp_exe_raw
            .strip_prefix(r"\\?\")
            .unwrap_or(&temp_exe_raw);

        for p in [current_exe_str, temp_exe_str] {
            if p.contains('"') || p.contains('\r') || p.contains('\n') {
                return Err("Executable path contains unsupported characters.".into());
            }
        }

        let pid = std::process::id();
        let cmd_path = temp_dir.join("audiobook-self-update.cmd");
        let script = format!(
            "@echo off\r\n\
            setlocal\r\n\
            set \"PID={pid}\"\r\n\
            set \"SRC={temp_exe_str}\"\r\n\
            set \"DST={current_exe_str}\"\r\n\
            set /a TRIES=0\r\n\
            :wait_loop\r\n\
            tasklist /NH /FI \"PID eq %PID%\" 2>NUL | find \"%PID%\" >NUL\r\n\
            if errorlevel 1 goto replace_loop\r\n\
            set /a TRIES+=1\r\n\
            if %TRIES% GEQ 20 goto replace_loop\r\n\
            ping -n 2 127.0.0.1 >NUL\r\n\
            goto wait_loop\r\n\
            :replace_loop\r\n\
            set /a MOVETRIES=0\r\n\
            :try_move\r\n\
            move /Y \"%SRC%\" \"%DST%\" >NUL 2>&1\r\n\
            if not errorlevel 1 goto launch\r\n\
            copy /Y \"%SRC%\" \"%DST%\" >NUL 2>&1\r\n\
            if not errorlevel 1 (\r\n\
              del /F /Q \"%SRC%\" >NUL 2>&1\r\n\
              goto launch\r\n\
            )\r\n\
            set /a MOVETRIES+=1\r\n\
            if %MOVETRIES% GEQ 15 goto launch\r\n\
            ping -n 2 127.0.0.1 >NUL\r\n\
            goto try_move\r\n\
            :launch\r\n\
            start \"\" \"%DST%\"\r\n\
            (goto) 2>nul & del \"%~f0\"\r\n"
        );
        fs::write(&cmd_path, script.as_bytes())
            .map_err(|e| format!("Failed to write self-update script: {e}"))?;

        let mut updater_cmd = std::process::Command::new("cmd.exe");
        updater_cmd.arg("/C").arg(&cmd_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            updater_cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        updater_cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start updater script: {e}"))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Update worker panicked: {e}"))??;

    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        app_handle.exit(0);
    });

    Ok(serde_json::json!({
        "ok": true,
        "restarting": true
    }))
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
    const MAX_PRIMARY_ATTEMPTS: usize = 5;
    for attempt in 1..=MAX_PRIMARY_ATTEMPTS {
        match build_main_window(app, "main", None) {
            Ok(win) => return Ok(win),
            Err(primary_err) => {
                log_startup(&format!(
                    "Primary WebView2 window attempt {attempt}/{MAX_PRIMARY_ATTEMPTS} failed ({primary_err})"
                ));
                if let Some(leftover) = app.get_webview_window("main") {
                    let _ = leftover.destroy();
                }
                if attempt < MAX_PRIMARY_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
        }
    }

    let stable_fallback_dir = app_local_dir().join("profiles").join("fallback");
    log_startup(&format!(
        "Primary WebView2 retries exhausted; trying stable fallback profile {}",
        stable_fallback_dir.display()
    ));

    let label = if app.get_webview_window("main").is_none() {
        "main".to_string()
    } else {
        format!("main-{}", std::process::id())
    };

    match build_main_window(app, &label, Some(stable_fallback_dir)) {
        Ok(win) => Ok(win),
        Err(stable_err) => {
            log_startup(&format!(
                "Stable fallback WebView2 window failed ({stable_err}); retrying with isolated session profile"
            ));
            if let Some(leftover) = app.get_webview_window(&label) {
                let _ = leftover.destroy();
            }

            let session_fallback_dir = app_local_dir()
                .join("profiles")
                .join(format!("session-{}", std::process::id()));
            let session_label = if app.get_webview_window("main").is_none() {
                "main".to_string()
            } else {
                format!("main-{}", std::process::id())
            };

            build_main_window(app, &session_label, Some(session_fallback_dir))
        }
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log_startup(&format!("PANIC: {info}"));
    }));

    let local_dir = app_local_dir();
    let oauth_path = local_dir.join("google_oauth.json");
    let session_path = local_dir.join("auth_session.json");
    let state = AppState {
        oauth_path,
        session_path,
        oauth_token: Arc::new(Mutex::new(None)),
        oauth_status: Arc::new(Mutex::new("idle".into())),
        oauth_attempt_id: Arc::new(AtomicU64::new(0)),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            desktop_start_google_oauth,
            desktop_poll_google_oauth,
            desktop_clear_google_oauth,
            desktop_save_auth_session,
            desktop_load_auth_session,
            desktop_clear_auth_session,
            desktop_install_update
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
