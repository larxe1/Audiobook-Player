#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{window::Color, App, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

    tauri::Builder::default()
        .setup(|app| {
            let win = create_main_window_with_fallback(app)?;
            let _ = win.show();
            let _ = win.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Audiobook Player");
}
