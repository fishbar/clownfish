//! Clownfish macOS shell — a native window around the Clownfish server.
//!
//! What this binary does, in order:
//!   1. pick a free port (never assume 4317 is free — a dev server may hold it)
//!   2. spawn the bun-compiled server binary (`clownfish-server`) in its OWN
//!      process group, with `CLOWNFISH_PORT` pointing at the chosen port —
//!      no node/npm on PATH, everything the server needs is compiled in
//!   3. authenticate the webview with a ONE-TIME token: a random value
//!      generated here, injected via `CLOWNFISH_AUTH=token` +
//!      `CLOWNFISH_AUTH_TOKEN`, and spent by opening
//!      `/autologin?token=…`. The server answers with a session cookie that
//!      never expires — it dies with the app, because the cookie has no
//!      Max-Age (browser-session cookie) and the server dies with the app too.
//!   4. install the macOS main menu (muda) — without an Edit menu the webview
//!      gets NO Cmd+C/V/X/Z/A/W/Q; macOS matches key equivalents against the
//!      main menu, not the key window
//!   5. open a frameless-looking window that KEEPS its traffic lights: tao's
//!      `with_decorations(false)` maps to NSWindowStyleMask::Borderless, which
//!      removes them — the correct recipe is a Titled window with a transparent
//!      titlebar + full-size content view, so the buttons stay native
//!   6. host the server in a WKWebView (wry), with:
//!        - an HTML title-bar drag region (`-webkit-app-region: drag` is a
//!          Chromium feature WKWebView does not implement — mousedown → IPC →
//!          `Window::drag_window()`, the same mechanism Tauri uses)
//!        - the traffic lights inset into the page's own header
//!        - downloads enabled browser-style
//!   7. when the window closes, SIGTERM the child's process GROUP (a bare
//!      `child.kill()` only kills the wrapper and orphans children), wait,
//!      escalate.
//!
//! Attach mode: set `CLOWNFISH_APP_URL` and no child is spawned — the shell
//! opens against an already-running server (dev loop, remote host); that
//! server keeps whatever auth it has.
//!
//! The server/worker binaries and web-dist are looked up beside this
//! executable (the .app layout: Contents/MacOS + Contents/Resources), then
//! in the repo's `.appbuild/` (a `cargo run` dev layout). Override with
//! `CLOWNFISH_APP_SERVER` / `CLOWNFISH_APP_WORKER` / `CLOWNFISH_APP_WEB_DIST`.

use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tao::dpi::{LogicalPosition, LogicalSize, Position};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::macos::WindowBuilderExtMacOS;
use tao::window::WindowBuilder;
use wry::{WebViewBuilder, WebViewBuilderExtDarwin};

/// Messages from background threads / the webview back to the event loop.
enum Msg {
	/// The webview's IPC channel (the drag region's `mousedown`).
	Ipc(String),
	/// The server answered /api/health — (re)load the real page.
	ServerReady,
	/// The server child died before ever answering — surface it, don't spin.
	ServerFailed(String),
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let attach_url: Option<String> = std::env::var("CLOWNFISH_APP_URL")
		.ok()
		.filter(|s| !s.trim().is_empty());

	// --- 1-3. port + server child + one-time login token ---------------------
	// The child lives in a static (see `SERVER`): tao's run closure owns
	// everything else by move, and LoopDestroyed needs to reach the child to
	// reap it. One instance, one window.
	let (base_url, entry_url) = match attach_url {
		Some(url) => {
			let base = url.trim_end_matches('/').to_string();
			let entry = base.clone();
			(base, entry)
		}
		None => start_server()?,
	};

	// --- 3. main menu (muda) — BEFORE the loop, so key equivalents exist
	// when the webview starts processing keys.
	build_menu().expect("install main menu");
	// Signals reap the server through the same path as window close.
	install_signal_reaper();

	// --- 4-5. window + webview ----------------------------------------------
	let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
	let proxy: EventLoopProxy<Msg> = event_loop.create_proxy();

	let window = WindowBuilder::new()
		.with_title("Clownfish")
		.with_inner_size(LogicalSize::new(1280.0, 800.0))
		.with_min_inner_size(LogicalSize::new(900.0, 600.0))
		// The transparent-titlebar recipe (NOT with_decorations(false)):
		// Titled mask stays → native close/min/zoom remain; the titlebar
		// material is invisible and the page extends underneath the buttons.
		.with_titlebar_transparent(true)
		.with_fullsize_content_view(true)
		.with_title_hidden(true)
		.build(&event_loop)
		.expect("window");

	let ipc_proxy = proxy.clone();
	let webview = WebViewBuilder::new()
		.with_url(&entry_url)
		.with_initialization_script(TITLEBAR_JS)
		.with_ipc_handler(move |req: wry::http::Request<String>| {
			// Route through the event loop (the Tauri pattern): keeps the
			// handler closure free of window borrows.
			let _ = ipc_proxy.send_event(Msg::Ipc(req.body().clone()));
		})
		// The page's own header paints around the lights (TITLEBAR_JS adds the
		// left padding); inset them so they sit INSIDE that header.
		.with_traffic_light_inset(Position::Logical(LogicalPosition::new(12.0, 12.0)))
		// Dragging an unfocused window by its titlebar should work on the
		// first click (macOS swallows the first click otherwise).
		.with_accept_first_mouse(true)
		.build(&window)?;

	// --- 6. readiness watch --------------------------------------------------
	{
		let proxy = proxy.clone();
		let url = base_url.clone();
		// Attach mode: no child to watch, only the health endpoint.
		let expect_child = with_server(|s| s.is_some());
		let _ = std::thread::Builder::new()
			.name("clownfish-health".into())
			.spawn(move || watch_health(&url, &proxy, expect_child));
	}

	let mut ready_loaded = false;
	event_loop.run(move |event, _, control_flow| {
		*control_flow = ControlFlow::Wait;
		match event {
			Event::UserEvent(Msg::Ipc(msg)) if msg == "drag" => {
				// Synthesizes the drag from the stored mouse event — the same
				// call behind Tauri's data-tauri-drag-region.
				let _ = window.drag_window();
			}
			Event::UserEvent(Msg::ServerReady) => {
				// The webview was pointed at the server from birth; if it came
				// up before the server answered, this reload lands the real
				// page. Safe to re-request /autologin: with the session cookie
				// already set it just redirects to `/`.
				if !ready_loaded {
					ready_loaded = true;
					let _ = webview.load_url(&entry_url);
				}
			}
			Event::UserEvent(Msg::ServerFailed(why)) => {
				eprintln!("[clownfish] server failed: {why}");
				*control_flow = ControlFlow::Exit;
			}
			Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
				*control_flow = ControlFlow::Exit;
			}
			Event::LoopDestroyed => {
				reap_server();
			}
			_ => {}
		}
	});
}

// --- server lifecycle -------------------------------------------------------

/// Bind :0 to let the OS pick a free port, then release it. The race (another
/// process grabbing it in the microseconds before node binds) is negligible —
/// and if it ever bites, the health watcher reports the child's death.
fn free_port() -> u16 {
	TcpListener::bind(("127.0.0.1", 0))
		.expect("bind :0 for a free port")
		.local_addr()
		.expect("local addr")
		.port()
}

fn repo_root() -> PathBuf {
	std::env::var("CLOWNFISH_APP_REPO")
		.ok()
		.filter(|s| !s.trim().is_empty())
		.map(PathBuf::from)
		.unwrap_or_else(|| {
			// .../app/mac → repo root is two levels up.
			PathBuf::from(env!("CARGO_MANIFEST_DIR"))
				.parent()
				.and_then(|p| p.parent())
				.expect("manifest dir /app/mac")
				.to_path_buf()
		})
}

/// Directory of THIS executable — the .app's Contents/MacOS when bundled.
fn exe_dir() -> PathBuf {
	std::env::current_exe()
		.expect("current exe path")
		.parent()
		.expect("exe has a parent dir")
		.to_path_buf()
}

/// Resolve a bundled asset: env override → `beside` (the .app layout) →
/// `repo` (the `cargo run` dev layout). Panics with the tried locations.
fn find_asset(what: &str, env_var: &str, beside: PathBuf, repo: PathBuf) -> PathBuf {
	if let Ok(p) = std::env::var(env_var) {
		if !p.trim().is_empty() {
			return PathBuf::from(p);
		}
	}
	if beside.exists() {
		return beside;
	}
	if repo.exists() {
		return repo;
	}
	panic!("{what} not found — set {env_var}, or build it (app/mac/build.sh). Tried beside the executable ({}) and in the repo ({}).", beside.display(), repo.display())
}

/// 32 random bytes from the OS, hex-encoded — the one-time login token. It is
/// passed to the server over the spawn environment and spent by the webview's
/// first `/autologin` request; it is never written to disk.
fn gen_token() -> String {
	use std::fs::File;
	use std::io::Read;
	let mut buf = [0u8; 32];
	let mut f = File::open("/dev/urandom").expect("open /dev/urandom");
	f.read_exact(&mut buf).expect("read urandom");
	buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Poll /api/health (always open, even behind login) until it answers; report
/// the FIRST success once. In spawn mode the child's exit (port collision,
/// missing deps, node absent) reports instead — a blank window that reloads
/// forever tells the operator nothing.
fn watch_health(url: &str, proxy: &EventLoopProxy<Msg>, expect_child: bool) {
	let health = format!("{url}/api/health");
	let deadline = Instant::now() + Duration::from_secs(60);
	loop {
		if health_ok(&health) {
			let _ = proxy.send_event(Msg::ServerReady);
			return;
		}
		if expect_child
			&& with_server(|s| matches!(s.as_mut().map(|c| c.try_wait()), Some(Ok(Some(_)))))
		{
			let _ = proxy.send_event(Msg::ServerFailed(
				"the server process exited before answering /api/health (see its log for the reason)".into(),
			));
			return;
		}
		if Instant::now() > deadline {
			let _ = proxy.send_event(Msg::ServerFailed("server did not answer /api/health within 60s".into()));
			return;
		}
		std::thread::sleep(Duration::from_millis(200));
	}
}

fn health_ok(url: &str) -> bool {
	let mut res = match http_get(url) {
		Some(res) => res,
		None => return false,
	};
	let mut body = String::new();
	res.read_to_string(&mut body).is_ok() && body.contains("\"ok\":true")
}

/// One tiny GET with no dependency: std TcpStream over HTTP/1.1 is enough for
/// a loopback health probe (no TLS, no redirects, small body).
fn http_get(url: &str) -> Option<impl Read> {
	let rest = url.strip_prefix("http://")?;
	let (host_port, path) = match rest.split_once('/') {
		Some((hp, p)) => (hp, format!("/{p}")),
		None => (rest, "/".to_string()),
	};
	let mut stream = std::net::TcpStream::connect(host_port).ok()?;
	use std::io::Write;
	let _ = stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n").as_bytes());
	Some(HttpResponse::from(stream))
}

/// The response body reader for {@link ureq_shim} — skips the HTTP header block.
struct HttpResponse {
	body: std::io::Take<std::net::TcpStream>,
}

impl HttpResponse {
	fn from(mut stream: std::net::TcpStream) -> Self {
		// Read until the header/body boundary. Content-Length is honored when
		// present; chunked is not (the probe only checks a fixed string, and
		// express serves this response with a length).
		let mut header = Vec::new();
		let mut byte = [0u8; 1];
		loop {
			match stream.read(&mut byte) {
				Ok(0) | Err(_) => break,
				Ok(_) => {
					header.push(byte[0]);
					if header.ends_with(b"\r\n\r\n") {
						break;
					}
				}
			}
		}
		let length = header
			.split(|&b| b == b'\n')
			.filter_map(|line| {
				let line = String::from_utf8_lossy(line);
				if !line.to_ascii_lowercase().starts_with("content-length") {
					return None;
				}
				line.split_once(':')?.1.trim().parse::<u64>().ok()
			})
			.next()
			.unwrap_or(0);
		Self { body: stream.take(length) }
	}
}

impl Read for HttpResponse {
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		self.body.read(buf)
	}
}

// --- child reaping ------------------------------------------------------------

/// The server child lives in a static Mutex so both the health thread and the
/// event loop's `LoopDestroyed` arm can reach it (tao's run closure owns
/// everything else by move). One instance, one window.
static SERVER: Mutex<Option<Child>> = Mutex::new(None);

fn with_server<T>(f: impl FnOnce(&mut Option<Child>) -> T) -> T {
	f(&mut SERVER.lock().expect("server child lock"))
}

/// Spawn the bun-compiled server binary in its own process group (it forks
/// agent workers that a plain `Child::kill()` would never reach — but they
/// all share the group). Injects the one-time login token; the webview spends
/// it at `/autologin?token=…` and gets a session cookie that outlives nothing
/// but the app.
fn spawn_server(port: u16, token: &str) -> std::io::Result<Child> {
	use std::os::unix::process::CommandExt;
	let server = find_asset(
		"the compiled server binary",
		"CLOWNFISH_APP_SERVER",
		exe_dir().join("clownfish-server"),
		repo_root().join(".appbuild/clownfish-server"),
	);
	let worker = find_asset(
		"the compiled worker binary",
		"CLOWNFISH_APP_WORKER",
		exe_dir().join("clownfish-worker"),
		repo_root().join(".appbuild/clownfish-worker"),
	);
	let web_dist = find_asset(
		"the web UI build",
		"CLOWNFISH_APP_WEB_DIST",
		exe_dir().join("..").join("Resources").join("web-dist"),
		repo_root().join("dist"),
	);
	// A per-launch agent socket: the default lives in the shared dataDir, and
	// a dev server started alongside this app would already hold it.
	let agent_socket = std::env::temp_dir().join(format!("clownfish-app-{}.sock", std::process::id()));
	Command::new(&server)
		.env("CLOWNFISH_PORT", port.to_string())
		.env("CLOWNFISH_BIND", "127.0.0.1")
		.env("CLOWNFISH_AUTH", "token")
		.env("CLOWNFISH_AUTH_TOKEN", token)
		.env("CLOWNFISH_WORKER_BIN", &worker)
		.env("CLOWNFISH_WEB_DIST", &web_dist)
		.env("CLOWNFISH_AGENT_SOCKET", &agent_socket)
		// stdio: keep the child's noise out of the app's console but let it be
		// redirected (piped → dropped silently; the .app discards it).
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.process_group(0)
		.spawn()
}

/// Returns `(base_url, entry_url)` — the entry spends the one-time token and
/// lands on `/` with the session cookie set.
fn start_server() -> Result<(String, String), Box<dyn std::error::Error>> {
	let port = free_port();
	let token = gen_token();
	let child = spawn_server(port, &token)?;
	with_server(|s| *s = Some(child));
	let base = format!("http://127.0.0.1:{port}");
	let entry = format!("{base}/autologin?token={token}");
	Ok((base, entry))
}

/// SIGTERM the child's process GROUP (negative pid), wait briefly, then
/// SIGKILL the group. Orphaned server/worker processes hold the port and the
/// UDS socket — the next launch would spawn a server it can never reach.
/// Takes the child out of the slot, so a second call (window close AND
/// signal) is a no-op.
fn reap_server() {
	let Some(mut child) = with_server(|s| s.take()) else { return };
	let pgid = child.id() as i32;
	unsafe {
		libc::kill(-pgid, libc::SIGTERM);
	}
	let deadline = Instant::now() + Duration::from_secs(5);
	while Instant::now() < deadline {
		if matches!(child.try_wait(), Ok(Some(_))) {
			return;
		}
		std::thread::sleep(Duration::from_millis(100));
	}
	let _ = unsafe { libc::kill(-pgid, libc::SIGKILL) };
	let _ = child.wait();
}

/// Reap on SIGTERM/SIGINT too — the GUI paths (window close, Cmd+Q) end in
/// `LoopDestroyed`, but a shell `kill`/Ctrl-C must also reach the child.
///
/// Implemented as a process-wide HANDLER + polling watcher rather than
/// sigwait: macOS lazily spawns libdispatch (GCD) worker threads with the
/// DEFAULT signal mask, and a process-directed signal lands on any thread
/// that hasn't blocked it — so a sigwait thread loses the race on this
/// platform (measured: the app died with default disposition, group alive).
/// A handler overrides the disposition for every thread, whatever its mask.
static SIGNALED: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_signal(sig: libc::c_int) {
	// Async-signal-safe: store and let the watcher do the real work.
	SIGNALED.store(sig, Ordering::SeqCst);
}

fn install_signal_reaper() {
	unsafe {
		let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
		libc::signal(libc::SIGTERM, handler);
		libc::signal(libc::SIGINT, handler);
	}
	let _ = std::thread::Builder::new().name("clownfish-signals".into()).spawn(|| {
		loop {
			let sig = SIGNALED.load(Ordering::SeqCst);
			if sig != 0 {
				eprintln!("[clownfish] signal {sig} received, reaping server");
				reap_server();
				std::process::exit(0);
			}
			std::thread::sleep(Duration::from_millis(50));
		}
	});
}

// --- menu ---------------------------------------------------------------------

/// The main menu is LOAD-BEARING: macOS delivers Cmd+C/V/X/Z/A/W/Q through the
/// menu's key equivalents, in any webview. wry already forwards unhandled
/// keyDowns to `NSApp.mainMenu.performKeyEquivalent` — this is what answers.
fn build_menu() -> muda::Result<()> {
	use muda::{Menu, PredefinedMenuItem, Submenu};
	let app = Submenu::new("Clownfish", true);
	app.append_items(&[
		&PredefinedMenuItem::about(None, None),
		&PredefinedMenuItem::separator(),
		&PredefinedMenuItem::hide(None),
		&PredefinedMenuItem::hide_others(None),
		&PredefinedMenuItem::separator(),
		&PredefinedMenuItem::quit(None),
	])?;
	let edit = Submenu::new("Edit", true);
	edit.append_items(&[
		&PredefinedMenuItem::undo(None),
		&PredefinedMenuItem::redo(None),
		&PredefinedMenuItem::separator(),
		&PredefinedMenuItem::cut(None),
		&PredefinedMenuItem::copy(None),
		&PredefinedMenuItem::paste(None),
		&PredefinedMenuItem::select_all(None),
	])?;
	let window_menu = Submenu::new("Window", true);
	window_menu.append_items(&[
		&PredefinedMenuItem::minimize(None),
		&PredefinedMenuItem::close_window(None),
	])?;
	let menu = Menu::new();
	menu.append_items(&[&app, &edit, &window_menu])?;
	menu.init_for_nsapp();
	Ok(())
}

// --- the HTML title bar ---------------------------------------------------

/// Injected before the page loads. WKWebView does not implement
/// `-webkit-app-region: drag`, so the drag region is explicit: a left-click on
/// the app's header (minus its interactive children) posts `drag` over the IPC
/// channel, which the event loop answers with `Window::drag_window()`.
///
/// The CSS also makes the header a real title bar visually: it reserves the
/// left 78px for the traffic lights and opts itself out of text selection.
const TITLEBAR_JS: &str = r#"
(() => {
	const style = document.createElement('style');
	style.textContent = `
		header, [role="banner"] {
			-webkit-user-select: none !important;
			padding-left: 84px !important;
		}`;
	document.head.appendChild(style);
	document.addEventListener('mousedown', (e) => {
		if (e.button !== 0) return;
		const bar = e.target.closest && e.target.closest('header, [role="banner"]');
		if (!bar) return;
		if (e.target.closest('button, a, input, select, textarea, [contenteditable]')) return;
		window.ipc.postMessage('drag');
	}, true);
})();
"#;
