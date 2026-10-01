//! TELEGRAM — A TRANSPORT, AND DELIBERATELY NOTHING ELSE.
//!
//! Long polling, update ids and backoff — Telegram's problems — and nothing about Noema. Every message is handed to
//! Noema's own bot gateway (src/bot/) through the mailbox in bot.rs; the gateway admits it, runs it and answers.
//!
//! GATEWAY-ONLY (2026-10-02). The legacy remote brain — a second model and a capability catalog inside this process
//! that answered a phone while Noema was closed, from the Guardian's copy of every session — was removed with that
//! copy. The supervisor polls only while a gateway holds the mailbox; with Noema closed, Telegram keeps the messages
//! and they arrive when Noema next runs.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::http;
use crate::json::{self, Value};
use crate::remote::Identity;
use crate::Kernel;

/// How long Telegram holds a poll open with nothing to say.
const POLL_SECS: u32 = 25;
const HTTP_TIMEOUT_SECS: u32 = POLL_SECS + 15;

/// Backoff after a failure, doubling to the ceiling. NOT A SPIN: a network down
/// for an hour is polled once a minute, not sixty times.
const BACKOFF_MIN_MS: u64 = 2_000;
const BACKOFF_MAX_MS: u64 = 60_000;

/// `getMe`. The only thing that turns a typed string into a stored credential —
/// a token is never persisted on the strength of having been typed.
pub fn verify(token: &str) -> Result<Identity, String> {
    if !http::valid_token(token) {
        return Err("that is not a Telegram bot token — they look like 123456789:AA…".to_string());
    }
    if !http::available() {
        return Err("no HTTPS transport on this machine: curl was not found".to_string());
    }
    let r = http::call(token, "getMe", &[], 20);
    if !r.error.is_empty() {
        return Err(r.error.clone());
    }
    let body = match json::parse(&r.body) {
        Some(v) => v,
        None => return Err(format!("Telegram answered {} with something that is not JSON", r.status)),
    };
    if !matches!(body.get("ok"), Some(Value::Bool(true))) {
        // TELEGRAM'S OWN WORDS — "Unauthorized" for a bad token. Never the token itself.
        let why = body.str("description");
        return Err(if why.is_empty() {
            format!("Telegram rejected the token ({})", r.status)
        } else {
            format!("Telegram said: {why}")
        });
    }
    let me = match body.get("result") {
        Some(v) => v,
        None => return Err("Telegram said ok but described no bot".to_string()),
    };
    Ok(Identity {
        bot_id: me.num("id").unwrap_or(0.0) as i64,
        username: me.str("username"),
        name: me.str("first_name"),
    })
}

/// Start the adapter if there is a credential to start it with.
///
/// IDEMPOTENT BY GENERATION rather than by a flag. `reconnect` and `disconnect`
/// bump the number; every loop checks it and a stale thread returns. That is how
/// a thread parked in a 25-second long poll is retired without being killed.
pub fn supervise(kernel: Arc<Kernel>) {
    let (configured, generation) = {
        let r = lock(&kernel);
        (r.configured(), r.generation)
    };
    if !configured {
        return;
    }
    if !http::available() {
        lock(&kernel).note_unavailable("curl was not found, so Telegram cannot be reached from this machine");
        return;
    }
    thread::spawn(move || poll_loop(kernel, generation));
}

fn lock(kernel: &Arc<Kernel>) -> std::sync::MutexGuard<'_, crate::remote::Remote> {
    match kernel.remote.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    }
}

fn poll_loop(kernel: Arc<Kernel>, generation: u64) {
    let mut backoff = BACKOFF_MIN_MS;
    loop {
        let (token, offset, mine) = {
            let r = lock(&kernel);
            (r.token(), r.offset, r.generation == generation && r.configured())
        };
        if !mine {
            return;
        }

        // ONLY WHILE NOEMA'S GATEWAY HOLDS THE MAILBOX. Unpolled messages wait on Telegram's side.
        if !lock(&kernel).gateway.can_poll() {
            thread::sleep(Duration::from_millis(500));
            continue;
        }

        // NO LOCK IS HELD ACROSS THIS. It can take 25 seconds.
        let r = http::call(
            &token,
            "getUpdates",
            &[
                ("offset", (offset + 1).to_string()),
                ("timeout", POLL_SECS.to_string()),
                ("allowed_updates", "[\"message\",\"callback_query\"]".to_string()),
            ],
            HTTP_TIMEOUT_SECS,
        );

        let parsed = if r.error.is_empty() && r.status == 200 { json::parse(&r.body) } else { None };
        let good = parsed
            .as_ref()
            .map(|b| matches!(b.get("ok"), Some(Value::Bool(true))))
            .unwrap_or(false);

        if !good {
            // NEVER THE BODY IN THE MESSAGE: a Telegram error can echo the
            // request, and the request carries the token.
            let why = if !r.error.is_empty() {
                r.error.clone()
            } else if r.status == 401 {
                "Telegram rejected the credential (401) — the bot token may have been revoked".to_string()
            } else if r.status == 409 {
                "another client is polling this bot (409)".to_string()
            } else {
                format!("Telegram answered {}", r.status)
            };
            {
                let mut rem = lock(&kernel);
                if rem.generation != generation {
                    return;
                }
                rem.note_error(&why);
            }
            thread::sleep(Duration::from_millis(backoff));
            backoff = (backoff * 2).min(BACKOFF_MAX_MS);
            continue;
        }

        backoff = BACKOFF_MIN_MS;
        {
            let mut rem = lock(&kernel);
            if rem.generation != generation {
                return;
            }
            rem.note_ok();
        }

        let updates = match parsed.as_ref().and_then(|b| b.get("result").cloned()) {
            Some(Value::Arr(rows)) => rows,
            _ => Vec::new(),
        };
        for u in updates {
            if !lock(&kernel).gateway.can_poll() { break; }
            handle_update(&kernel, generation, &u);
        }
    }
}

/// ONE UPDATE, INTO THE MAILBOX. The cursor moves only once the event is durably queued (or deliberately ignored),
/// so nothing Telegram sent is lost between a poll and a crash.
fn handle_update(kernel: &Arc<Kernel>, generation: u64, u: &Value) {
    let update_id = match u.num("update_id") {
        Some(n) => n as i64,
        None => return,
    };
    let mut rem = lock(kernel);
    if rem.generation != generation { return; }
    if update_id <= rem.offset { return; }
    if let Some(event) = crate::bot::normalize(u, &rem) {
        if !rem.gateway.push(event) { return; }
    }
    rem.set_offset(update_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_refuses_a_malformed_token_without_touching_the_network() {
        let e = verify("obviously not a token").unwrap_err();
        assert!(e.contains("not a Telegram bot token"));
        assert!(!e.contains("obviously"), "the rejected value is not quoted back");
    }
}
