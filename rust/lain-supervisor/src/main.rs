//! LAIN SUPERVISOR — the part of LAIN that is still running when LAIN is not.
//!
//! ------------------------------------------------------------------------
//! THE ONE JOB. A background worker in LAIN lives on `app._jobs`, in memory, on
//! the App object. It survives a failed turn and dies with the process, and it
//! appears in no session state, so a suite that finished thirty seconds after
//! LAIN crashed finished for nobody. This process owns those workers instead.
//! LAIN exiting closes a socket; closing a socket does not signal anybody's
//! children, so the work continues and its result is on disk when LAIN returns.
//!
//! ------------------------------------------------------------------------
//! WHY A SOCKET AND NOT THE EXISTING STDIO SEAM.
//!
//! `mcp.js` speaks JSON lines over a child's stdio, and that seam is the right
//! shape for the desktop bridge — but stdio pipes belong to the spawn. A NEW
//! LAIN process cannot reattach to the stdin of a child some earlier process
//! started, which makes reconnect-after-restart structurally impossible over
//! that transport, and reconnect is the entire requirement here.
//!
//! So: the same JSON-lines PROTOCOL, over a loopback socket, discovered through
//! a small file under LAIN's config home — which is the convention `dash.js` and
//! `instances.js` already use for exactly this problem, down to trusting the pid
//! over the file. Nothing new was invented; the transport was changed to one
//! that can be re-entered.
//!
//! ------------------------------------------------------------------------
//! THE SECOND THING THAT MUST OUTLIVE A LAIN PROCESS: PROVIDER HEALTH.
//!
//! A background job and a rate limit look like unrelated subjects and are the
//! same subject — a fact with a future in it, learned by a process that is
//! about to stop existing. `availability.js` holds provider health in a `Map`
//! on the App object, which is right for a circuit breaker and wrong for a
//! limit that a provider said would clear in four hours: restart LAIN and the
//! limit is forgotten, so the next turn calls the closed route and pays for the
//! same discovery again. So `providers.rs` keeps that here, next to the jobs,
//! for the same reason and with the same refusal to guess.
//!
//! ------------------------------------------------------------------------
//! WHAT IT IS NOT. It does not reason, plan, summarise, or talk to a model. It
//! starts processes, watches them, and reports what it saw. Every question it
//! answers is a question about a pid, an exit code, or a status line a provider
//! sent, and where it does not know the answer it says `unknown` — see jobs.rs,
//! and see `reset_at: null` in providers.rs, which is the same refusal wearing
//! different clothes.

mod http;
mod jobs;
mod json;
mod remote;
mod telegram;
mod bot;
mod bot_media;

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use jobs::Registry;
use json::Value;
use remote::Remote;

/// When a client last spoke to this supervisor (seconds since 1970). Read by the idle reaper.
static LAST_CLIENT: AtomicU64 = AtomicU64::new(0);
/// How long a supervisor with nothing to keep may sit idle before it exits (2026-10-07).
const IDLE_EXIT_SECS: u64 = 600;

const VERSION: &str = "0.4.0";

/// THE RUNTIME'S AUTHORITATIVE STATE, in one place so there is exactly one.
///
/// FIVE LOCKS, NOT ONE, and that is the point of the struct rather than an
/// accident of it. `refresh_all` walks every job and shells out per pid; holding
/// a single kernel lock across that would make every provider note wait behind a
/// process scan it has nothing to do with — and the provider note happens on the
/// failure path of a model request, which is the worst possible moment to add
/// latency.
///
/// The remote adapter is separate because it parks in a 25-second long poll.
pub struct Kernel {
    pub jobs: Mutex<Registry>,
    pub remote: Mutex<Remote>,
    /// Where the event log lives. Held here so an event can be appended without
    /// taking a lock on the state it is describing.
    pub dir: PathBuf,
}

fn home() -> PathBuf {
    // The same home LAIN's config.js uses. LAIN_HOME is honoured first so a test
    // can run a private supervisor without touching the user's real one.
    if let Ok(h) = std::env::var("LAIN_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    let base = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    // LAIN'S ONE HOME (~/.lain). LAIN always passes --home; this is only the fallback for a supervisor started by hand.
    PathBuf::from(base).join(".lain")
}

fn state_dir() -> PathBuf {
    home().join("supervisor")
}

fn endpoint_file() -> PathBuf {
    state_dir().join("endpoint.json")
}

/// Is a supervisor already serving? The pid is the truth and the file is a hint,
/// exactly as in `instances.js` — pointing a client at a port that now belongs
/// to something else is the one failure this must not have.
fn existing() -> Option<(u32, u16)> {
    let text = std::fs::read_to_string(endpoint_file()).ok()?;
    let v = json::parse(&text)?;
    let pid = v.num("pid")? as u32;
    let port = v.num("port")? as u16;
    if !jobs::alive(pid) {
        return None;
    }
    Some((pid, port))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--home") {
        if let Some(root) = args.get(i + 1) { std::env::set_var("LAIN_HOME", root); }
    }
    let cmd = args.get(1).map(String::as_str).unwrap_or("serve");
    match cmd {
        // Print where a supervisor is, if one is. Used by the Node client to
        // decide whether it needs to start one, without opening a socket.
        "where" => {
            match existing() {
                Some((pid, port)) => {
                    let mut v = Value::obj();
                    v.set("lifetime", Value::s("lease-v1"));
                    v.set("running", Value::Bool(true));
                    v.set("pid", Value::n(pid as i64));
                    v.set("port", Value::n(port as i64));
                    println!("{}", json::write(&v));
                }
                None => {
                    let mut v = Value::obj();
                    v.set("running", Value::Bool(false));
                    v.set("lifetime", Value::s("lease-v1"));
                    println!("{}", json::write(&v));
                }
            }
        }
        _ => serve(),
    }
}

fn serve() {
    let dir = state_dir();
    if std::fs::create_dir_all(&dir).is_err() { return; }
    // OS lock survives no crash and serializes discovery AND publication.
    // Keep this file handle for the entire server lifetime. The file is inert
    // after exit; deleting lock files would allow two different locks.
    let lock = match std::fs::OpenOptions::new().create(true).truncate(false)
        .read(true).write(true).open(dir.join("serve.lock")) {
        Ok(f) => f,
        Err(_) => return,
    };
    if lock.try_lock().is_err() { return; }
    // ALREADY RUNNING IS A SUCCESS, not an error. Two LAINs starting at once
    // must converge on one supervisor rather than race to own the file.
    if let Some((pid, port)) = existing() {
        let mut v = Value::obj();
        v.set("running", Value::Bool(true));
        v.set("pid", Value::n(pid as i64));
        v.set("port", Value::n(port as i64));
        v.set("note", Value::s("a supervisor was already serving; this one exited"));
        println!("{}", json::write(&v));
        return;
    }

    let listener = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("lain-supervisor: could not bind loopback: {e}");
            process::exit(1);
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let pid = process::id();

    let mut ep = Value::obj();
    ep.set("pid", Value::n(pid as i64));
    ep.set("port", Value::n(port as i64));
    ep.set("version", Value::s(VERSION));
    ep.set("started_at", Value::n(jobs::now() as i64));
    let tmp = dir.join("endpoint.tmp");
    if std::fs::write(&tmp, json::write(&ep).as_bytes())
        .and_then(|_| std::fs::rename(&tmp, endpoint_file())).is_err() { return; }

    // A test scope explicitly owns its supervisors. Production has no owner
    // marker and retains durable jobs across client exits. The runner's
    // loopback lease closes on success, timeout, SIGINT and hard process death.
    if let Ok(port) = std::env::var("LAIN_SUPERVISOR_LEASE_PORT") {
        let lease = port.parse::<u16>().ok().and_then(|p|
            TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, p)).ok());
        let Some(mut lease) = lease else { return; };
        thread::spawn(move || {
            let mut byte = [0u8; 1];
            use std::io::Read;
            while matches!(lease.read(&mut byte), Ok(n) if n > 0) {}
            // Includes test workers; a test scope cannot leave durable work.
            jobs::kill_tree(process::id());
            process::exit(0);
        });
    }

    // Announced on stdout so a parent that wants to wait for readiness can, and
    // so `where` and this agree about the shape.
    println!("{}", json::write(&ep));
    let _ = std::io::stdout().flush();

    let kernel = Arc::new(Kernel {
        jobs: Mutex::new(Registry::open(dir.clone())),
        remote: Mutex::new(Remote::open(dir.clone())),
        dir,
    });

    // ---- THE ADAPTER COMES UP WITH THE RUNTIME, NOT WITH THE CLI ------------
    //
    // A credential stored yesterday means the bot should be listening today,
    // whether or not anybody has opened a terminal. That is what makes it a
    // runtime service rather than a feature of a session: it does not depend on
    // a model request, a Node event loop, or a turn. It does nothing when
    // nothing is configured, and reports UNAVAILABLE rather than retrying
    // forever when the machine cannot speak HTTPS at all.
    telegram::supervise(kernel.clone());

    // ---- NOTHING TO KEEP, NOTHING TO DO: EXIT (2026-10-07) ---------------------
    //
    // The supervisor outlives LAIN for durable jobs and the Bot. Without either — no queued or running job, no
    // remote configured — and no client for IDLE_EXIT_SECS, it ends: an idle LAIN machine has no resident process,
    // and closed windows never leave supervisors behind. A supervisor whose home has been removed ends at once.
    LAST_CLIENT.store(jobs::now(), Ordering::Relaxed);
    {
        let k = kernel.clone();
        thread::spawn(move || loop {
            thread::sleep(std::time::Duration::from_secs(60));
            if !k.dir.exists() { process::exit(0); }
            let busy = k.jobs.lock().map(|r| r.jobs.values().any(|j| !j.state.is_final())).unwrap_or(true);
            let bot = k.remote.lock().map(|r| r.configured()).unwrap_or(true);
            let idle_for = jobs::now().saturating_sub(LAST_CLIENT.load(Ordering::Relaxed));
            if !busy && !bot && idle_for >= IDLE_EXIT_SECS {
                let _ = std::fs::remove_file(endpoint_file());
                process::exit(0);
            }
        });
    }

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let k = kernel.clone();
                // A client per thread. There are never many, and a client that
                // hangs must not stop the others being served.
                thread::spawn(move || handle(s, k));
            }
            Err(_) => continue,
        }
    }
}

fn handle(stream: TcpStream, kernel: Arc<Kernel>) {
    let peer = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut out = stream;
    let reader = BufReader::new(peer);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        LAST_CLIENT.store(jobs::now(), Ordering::Relaxed);
        let reply = respond(&line, &kernel);
        if writeln!(out, "{}", json::write(&reply)).is_err() {
            break;
        }
        let _ = out.flush();
        // A client that asked us to stop gets its answer first.
        if reply.str("op") == "shutdown" {
            process::exit(0);
        }
    }
    // THE CLIENT LEAVING IS NOT AN EVENT. No job is touched here, and that
    // omission is the feature: LAIN disconnecting is precisely the case where
    // the work must carry on.
}

fn err(op: &str, why: &str) -> Value {
    let mut v = Value::obj();
    v.set("ok", Value::Bool(false));
    v.set("op", Value::s(op));
    v.set("error", Value::s(why));
    v
}

fn respond(line: &str, kernel: &Arc<Kernel>) -> Value {
    // A MALFORMED MESSAGE IS A REPLY, NEVER A CRASH. Bad input must not reach
    // authoritative state, and it must not take the supervisor with it.
    let req = match json::parse(line) {
        Some(v) => v,
        None => return err("", "malformed JSON line"),
    };
    let op = req.str("op");

    // REMOTE AND CAPABILITY OPS TAKE NO LOCK HERE, deliberately rather than by
    // oversight: `remote_connect` makes a NETWORK CALL to prove a token, and a
    // capability reads several stores in turn. Taking one lock at the top would
    // serialise the terminal behind a timeout. Each arm locks what it needs for
    // as long as it needs it.
    if op.starts_with("remote_") {
        return remote_op(&op, &req, kernel);
    }

    let mut reg = match kernel.jobs.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };

    match op.as_str() {
        "ping" => {
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("ping"));
            v.set("pid", Value::n(process::id() as i64));
            v.set("version", Value::s(VERSION));
            v
        }
        "submit" => {
            let command = req.str("command");
            if command.is_empty() {
                return err("submit", "submit needs a command");
            }
            // THE DEADLINE IS THE JOB'S, not the request's. See Job::deadline_at.
            let deadline_secs = req.num("deadline_secs").unwrap_or(0.0).max(0.0) as u64;
            let job = reg.submit(
                &req.str("request_id"),
                &req.str("session"),
                &command,
                &req.str("shell"),
                &req.str("cwd"),
                deadline_secs,
            );
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("submit"));
            v.set("job", job.to_value());
            v
        }
        "status" => {
            let id = req.str("job_id");
            reg.refresh(&id);
            match reg.jobs.get(&id) {
                Some(j) => {
                    let mut v = Value::obj();
                    v.set("ok", Value::Bool(true));
                    v.set("op", Value::s("status"));
                    v.set("job", j.to_value());
                    v
                }
                None => err("status", "no such job"),
            }
        }
        "list" => {
            reg.refresh_all();
            let session = req.str("session");
            let mut arr: Vec<Value> = Vec::new();
            for j in reg.jobs.values() {
                if !session.is_empty() && j.session != session {
                    continue;
                }
                arr.push(j.to_value());
            }
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("list"));
            v.set("jobs", Value::Arr(arr));
            v
        }
        // WHAT HAS HAPPENED SINCE YOU LAST LOOKED. The reconnect path for
        // reasoning: a job may have finished, failed or run out its window while
        // no LAIN was running at all.
        "events" => {
            let after = req.num("after").unwrap_or(0.0).max(0.0) as usize;
            let limit = req.num("limit").unwrap_or(50.0).max(1.0) as usize;
            let dir = reg.dir.clone();
            let rows = jobs::events_since(&dir, after, limit);
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("events"));
            v.set("events", Value::Arr(rows));
            v
        }
        "cancel" => {
            let id = req.str("job_id");
            match reg.cancel(&id) {
                Some(j) => {
                    let mut v = Value::obj();
                    v.set("ok", Value::Bool(true));
                    v.set("op", Value::s("cancel"));
                    v.set("job", j.to_value());
                    v
                }
                None => err("cancel", "no such job"),
            }
        }
        "shutdown" => {
            // Only ever used by tests and by an explicit operator action. A
            // running worker is NOT killed — it is this process that stops.
            let mut v = Value::obj();
            v.set("ok", Value::Bool(true));
            v.set("op", Value::s("shutdown"));
            v
        }
        other => err(other, "unknown op"),
    }
}

/// ------------------------------------------------------------------------
/// REMOTE CONTROL OVER THE WIRE.
///
/// NOT ONE OP RETURNS A CREDENTIAL. There is no `remote_token`, no
/// `include_secret`, no debug variant — `Remote::snapshot` is the only
/// projection and it cannot carry one, so a client that wanted to leak the bot
/// token would have to be rewritten rather than merely misconfigured.
///
/// THE ONE OP THAT RECEIVES A TOKEN is `remote_connect`, and what it does with
/// it is the point: the value is proved against Telegram BEFORE being written
/// anywhere, so a typo is never persisted and never reported as a working
/// connection. The request line carrying it is never logged — the event below
/// carries the bot's public username and nothing else.
///
/// `capability` IS HERE RATHER THAN IN ITS OWN FAMILY because it is the same
/// subject: it is how a client that is not a chat — the terminal's `/session`,
/// and a dashboard later — reaches the identical bounded vocabulary the remote
/// surface reaches. One vocabulary, one validation, several windows.
fn remote_op(op: &str, req: &Value, kernel: &Arc<Kernel>) -> Value {
    if op.starts_with("remote_gateway_") { return bot::op(op, req, kernel); }
    let lock = || match kernel.remote.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let snapshot = |op: &str| -> Value {
        let mut v = Value::obj();
        v.set("ok", Value::Bool(true));
        v.set("op", Value::s(op));
        v.set("remote", lock().snapshot());
        v
    };

    match op {
        "remote_status" => snapshot(op),

        "remote_connect" => {
            let token = req.str("token");
            if token.trim().is_empty() {
                return err(op, "no token was given");
            }
            // ---- PROVED FIRST, STORED SECOND, AND OUTSIDE THE LOCK --------
            let identity = match telegram::verify(token.trim()) {
                Ok(i) => i,
                // Telegram's own words, already scrubbed by http.rs. Nothing is
                // stored, so a bad token leaves no trace at all.
                Err(why) => return err(op, &why),
            };
            let code = {
                let mut r = lock();
                r.connect(token.trim(), identity);
                // A CREDENTIAL IS NOT AN AUTHORIZATION. The code is minted here
                // so the terminal shows it in the same breath as the success —
                // the one moment the user is certainly looking at the screen.
                r.new_pairing()
            };
            telegram::supervise(kernel.clone());
            let mut v = snapshot(op);
            v.set("pairing_code", Value::s(&code));
            v
        }

        // WHICH LOCAL MODEL SPEAKS. Separate from the credential on purpose:
        // choosing a voice is not connecting a bot, and either may be changed
        // without disturbing the other.
        "remote_disconnect" => {
            let removed = lock().disconnect();
            let mut v = snapshot(op);
            v.set("removed", Value::Bool(removed));
            v
        }

        "remote_reconnect" => {
            {
                let mut r = lock();
                if !r.configured() {
                    return err(op, "nothing is connected");
                }
                r.reconnect();
            }
            telegram::supervise(kernel.clone());
            snapshot(op)
        }

        // A FRESH CODE, for a user who let one expire or is adding a second
        // device. Minting one does not revoke an existing authorization.
        "remote_pair_code" => {
            let code = {
                let mut r = lock();
                if !r.configured() {
                    return err(op, "nothing is connected");
                }
                r.new_pairing()
            };
            let mut v = snapshot(op);
            v.set("pairing_code", Value::s(&code));
            v
        }

        other => err(other, "unknown op"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jobs::State;

    fn kernel(tag: &str) -> Arc<Kernel> {
        let dir = std::env::temp_dir().join(format!("lain-sup-{tag}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
        Arc::new(Kernel {
            jobs: Mutex::new(Registry::open(dir.clone())),
            remote: Mutex::new(Remote::open(dir.clone())),
            dir,
        })
    }

    #[test]
    fn an_unknown_op_is_answered_not_crashed() {
        let k = kernel("op");
        let v = respond("{\"op\":\"nonsense\"}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(v.str("error"), "unknown op");
    }

    #[test]
    fn a_malformed_line_is_answered_not_crashed() {
        // A bad message may not poison authoritative state, and it may not take
        // the supervisor down with it.
        let k = kernel("malformed");
        let v = respond("{not json at all", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(v.str("error"), "malformed JSON line");
    }

    #[test]
    fn submit_without_a_command_is_refused() {
        let k = kernel("submit");
        let v = respond("{\"op\":\"submit\"}", &k);
        assert_eq!(v.get("ok"), Some(&Value::Bool(false)));
        assert!(v.str("error").contains("needs a command"));
    }

    #[test]
    fn state_words_round_trip() {
        for s in [State::Queued, State::Running, State::Completed, State::Failed, State::Cancelled] {
            assert_eq!(State::from_str(s.as_str()), s, "{} did not round trip", s.as_str());
        }
    }
}
