// Bakes the configured API origin into the binary (BOS_API_ORIGIN), from VITE_API_BASE_URL in the
// environment or apps/desktop/.env: the same value that sets the window's CSP connect-src
// (scripts/tauri-config.mjs). The sign-in command opens only that origin's authorisation page.
use std::{env, fs, path::Path};

fn origin(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    let (scheme, rest) = value.split_once("://")?;
    let authority = rest.split('/').next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
    let local = matches!(host, "localhost" | "127.0.0.1");
    if scheme != "https" && !(scheme == "http" && local) {
        return None;
    }
    Some(format!("{}://{}", scheme, authority.to_ascii_lowercase()))
}

fn from_dotenv() -> Option<String> {
    let text = fs::read_to_string(Path::new("..").join(".env")).ok()?;
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("VITE_API_BASE_URL=").map(str::to_string))
}

fn main() {
    println!("cargo:rerun-if-env-changed=VITE_API_BASE_URL");
    println!("cargo:rerun-if-changed=../.env");
    let configured = env::var("VITE_API_BASE_URL").ok().or_else(from_dotenv);
    let api_origin = configured
        .as_deref()
        .and_then(origin)
        .expect("VITE_API_BASE_URL must be set to the API's https origin (http only for localhost) to build the desktop app");
    println!("cargo:rustc-env=BOS_API_ORIGIN={api_origin}");
    tauri_build::build()
}
