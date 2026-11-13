//! Native pieces of desktop sign-in (D9a). No password ever passes through the app.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const SERVICE: &str = "com.business-os.desktop";
const ACCOUNT: &str = "session";
const AUTHORIZE_PATH: &str = "/api/v1/auth/desktop/authorize";
const WAIT: Duration = Duration::from_secs(300);

#[derive(serde::Serialize)]
pub struct BrowserCallback {
    code: String,
    state: String,
    redirect_uri: String,
}

/// Only the API's own desktop authorisation page may be opened: https, or http on localhost in
/// development. Anything else is refused, so the command cannot be used to open arbitrary URLs.
fn authorize_url_allowed(url: &str) -> bool {
    let (scheme, rest) = match url.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    let (authority, path_and_query) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return false,
    };
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
    let local = host == "localhost" || host == "127.0.0.1";
    let scheme_ok = scheme == "https" || (scheme == "http" && local);
    let path = path_and_query.split('?').next().unwrap_or("");
    scheme_ok && !authority.contains('@') && path == AUTHORIZE_PATH && path_and_query.contains('?')
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k != key || v.is_empty() || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return None;
        }
        Some(v.to_string())
    })
}

fn respond(mut stream: TcpStream, status: &str, body: &str) {
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Business OS</title><body style=\"font-family:system-ui;margin:4rem auto;max-width:28rem\">{body}</body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{page}",
        page.len()
    );
}

/// Opens the system browser at `authorize_url` (which must carry `redirect_uri` for the port this
/// listener reports via `{port}`), then waits for the browser to deliver the code with the
/// expected `state`. Binds to 127.0.0.1 only, on a random port, for one sign-in.
#[tauri::command]
pub async fn await_browser_sign_in(authorize_url: String, state: String) -> Result<BrowserCallback, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "Could not start sign-in".to_string())?;
        let port = listener.local_addr().map_err(|_| "Could not start sign-in".to_string())?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        let url = authorize_url.replace("%7Bport%7D", &port.to_string()).replace("{port}", &port.to_string());
        if !authorize_url_allowed(&url) {
            return Err("Refusing to open an unexpected sign-in address".to_string());
        }
        open::that_detached(&url).map_err(|_| "Could not open your browser".to_string())?;

        listener.set_nonblocking(true).map_err(|_| "Could not start sign-in".to_string())?;
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(_) => continue,
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            // Expect: GET /callback?code=...&state=... HTTP/1.1
            let target = line.split_whitespace().nth(1).unwrap_or("");
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            if !line.starts_with("GET ") || path != "/callback" {
                respond(stream, "404 Not Found", "<p>Not found.</p>");
                continue;
            }
            match (query_value(query, "code"), query_value(query, "state")) {
                (Some(code), Some(got)) if got == state => {
                    respond(stream, "200 OK", "<h1>You're signed in</h1><p>You can close this tab and return to Business OS.</p>");
                    return Ok(BrowserCallback { code, state: got, redirect_uri });
                }
                _ => respond(stream, "400 Bad Request", "<p>This sign-in link is not valid. Start again from the app.</p>"),
            }
        }
        Err("Sign-in timed out. Please try again.".to_string())
    })
    .await
    .map_err(|_| "Sign-in failed".to_string())?
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| "Secure storage is unavailable".to_string())
}

/// Reads the session token from the OS credential store. Missing means signed out.
#[tauri::command]
pub fn load_session_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Secure storage is unavailable".to_string()),
    }
}

/// Saves the session token in the OS credential store (never on disk in plain text).
#[tauri::command]
pub fn store_session_token(token: String) -> Result<(), String> {
    if token.len() < 40 || token.len() > 512 || token.contains(char::is_whitespace) {
        return Err("Invalid session token".to_string());
    }
    entry()?.set_password(&token).map_err(|_| "Secure storage is unavailable".to_string())
}

/// Removes the session token from the OS credential store.
#[tauri::command]
pub fn forget_session_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Secure storage is unavailable".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_api_authorize_page_may_be_opened() {
        assert!(authorize_url_allowed("https://api.example.com/api/v1/auth/desktop/authorize?x=1"));
        assert!(authorize_url_allowed("http://localhost:3000/api/v1/auth/desktop/authorize?x=1"));
        assert!(!authorize_url_allowed("http://api.example.com/api/v1/auth/desktop/authorize?x=1"));
        assert!(!authorize_url_allowed("https://api.example.com/evil?x=1"));
        assert!(!authorize_url_allowed("https://user@api.example.com/api/v1/auth/desktop/authorize?x=1"));
        assert!(!authorize_url_allowed("file:///etc/passwd"));
    }

    #[test]
    fn callback_values_must_be_url_safe() {
        assert_eq!(query_value("code=abc_-1&state=s", "code"), Some("abc_-1".to_string()));
        assert_eq!(query_value("code=a%20b", "code"), None);
        assert_eq!(query_value("state=", "state"), None);
    }
}
