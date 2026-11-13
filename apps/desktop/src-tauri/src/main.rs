// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The desktop shell stays thin: business logic, authorisation and tenant isolation live in the
// cloud API (ADR 0005). Phase 1b adds exactly what native sign-in needs (D9a):
//   - open the system browser at the API's desktop authorisation page,
//   - receive the one-time code on a loopback address (RFC 8252 §7.3),
//   - keep the session token in the OS credential store (macOS Keychain, Windows Credential Manager).
// The PKCE verifier and the code exchange are handled by the shared client over HTTPS.

mod auth;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            auth::await_browser_sign_in,
            auth::load_session_token,
            auth::store_session_token,
            auth::forget_session_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Business OS");
}
