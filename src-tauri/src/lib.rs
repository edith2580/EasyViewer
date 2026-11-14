#[cfg(desktop)]
use std::path::PathBuf;

#[cfg(desktop)]
use tauri_plugin_fs::FsExt;

/// True on Windows/macOS/Linux builds. The storage-folder feature (readable file names, folder
/// open/change) is desktop only; Android/iOS keep storing books internally as before.
#[tauri::command]
fn is_desktop() -> bool {
    cfg!(desktop)
}

/// Creates `path` if needed and allows the fs plugin to read/write inside it for this run.
/// Needed for a user-chosen storage folder outside the app data directory; the frontend calls it
/// at startup for every folder that holds library books, and when the folder is changed.
#[cfg(desktop)]
#[tauri::command]
fn allow_storage_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err(format!("storage folder must be an absolute path: {path}"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.fs_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())
}

/// Opens `path` in the system file manager (Explorer / Finder / the desktop's default).
#[cfg(desktop)]
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("folder not found: {path}"));
    }

    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder =
        builder.invoke_handler(tauri::generate_handler![is_desktop, allow_storage_dir, open_folder]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![is_desktop]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
