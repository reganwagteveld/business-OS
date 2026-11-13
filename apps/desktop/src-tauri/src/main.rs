// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Phase 1a shell: no custom IPC commands, plugins or native capabilities beyond a window.
// Business logic, authorisation and tenant isolation live in the cloud API (ADR 0005).
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Business OS");
}
