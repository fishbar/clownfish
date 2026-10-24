# app/ — OS shells around the Clownfish server

Rust + system-webview wrappers that turn the server into a native app. Today:
**macOS only** (`mac/`). `win/` is a placeholder — the same design maps onto
WebView2 (where `-webkit-app-region: drag` actually works, so the drag region
needs no IPC hop).

## mac/ — what the shell is

Two pieces, built by `build.sh` into one self-contained `Clownfish.app`:

- `clownfish-mac` — ~600 lines of Rust (`tao` for the window, `wry` for
  WKWebView, `muda` for the menu, `libc` for process-group reaping): the OS
  window, and the lifecycle owner of the server process.
- `clownfish-server` / `clownfish-worker` — the server and the agent worker,
  each compiled to a **standalone executable by bun** (`bun build --compile`,
  runtime embedded, no node/npm needed at runtime). The worker is spawned as a
  binary (`CLOWNFISH_WORKER_BIN`), not forked as a module — fork would re-exec
  `process.execPath`, which inside a compiled server is the server itself (the
  fork IPC channel was never used; the worker speaks over the Unix socket).

Boot sequence:

1. pick a free port (never assumes 4317 is free — a dev server may hold it),
2. generate a random **one-time login token**, spawn `clownfish-server` in its
   **own process group** with `CLOWNFISH_PORT`, `CLOWNFISH_BIND=127.0.0.1`,
   `CLOWNFISH_AUTH=token`, `CLOWNFISH_AUTH_TOKEN`, `CLOWNFISH_WORKER_BIN`,
   `CLOWNFISH_WEB_DIST` (a per-launch `CLOWNFISH_AGENT_SOCKET` too — a
   concurrently running dev server would hold the default path),
3. wait for `/api/health` (polling, 60 s ceiling; a child that dies first is
   reported, not spun on),
4. open a **titlebar-less window that keeps its traffic lights**, webview at
   `/autologin?token=…` — the token is consumed, a never-expiring session
   cookie lands, and the UI is usable with **no login step**,
5. kill the whole process group on window close / quit / signal (a bare
   `child.kill()` only reaches the wrapper and orphans children — which hold
   the port and the UDS socket).

### The pitfalls this build answers (each is measured, not assumed)

| Symptom | Cause | Fix in `src/main.rs` |
|---|---|---|
| No close/min/zoom buttons | `with_decorations(false)` maps to `NSWindowStyleMask::Borderless` | Keep decorations; `with_titlebar_transparent(true)` + `with_fullsize_content_view(true)` — the Titled mask (and its buttons) stays, the titlebar material is invisible |
| HTML title bar can't drag the window | `-webkit-app-region: drag` is Chromium-only; WKWebView ignores it | `mousedown` on the header → wry IPC → `Window::drag_window()` (the exact mechanism behind Tauri's `data-tauri-drag-region`) |
| Cmd+C/V/X/Z/A/W/Q dead | macOS matches key equivalents against the **main menu**, not the key window; tao creates no menu | `muda` menu with predefined Edit items + `init_for_nsapp()`, before the event loop |
| Can't type in inputs / no IME | webview not first responder | already handled by wry (`makeFirstResponder` at install); `webview.focus()` if focus is ever lost |
| Traffic lights flicker on resize | inset set on the window is lost when wry re-parents the content view | inset set on the **WebViewBuilder** (`with_traffic_light_inset`), re-applied in the parent view's `drawRect:` |
| Can't drag an unfocused window by its titlebar | first click only focuses | `with_accept_first_mouse(true)` |
| Downloads silently dropped | (default is fine) | wry allows downloads browser-style; on macOS the completed handler's path is always `None` (WKWebView limitation) — rely on `ok` |
| Closing the app orphans the server | `Child::kill()` kills only the direct child | `process_group(0)` at spawn + `kill(-pgid, SIGTERM)` → wait → `SIGKILL` |
| `kill`/Ctrl-C still orphans it | a sigwait thread never fires on macOS: lazily-spawned libdispatch threads carry the DEFAULT signal mask and win the delivery race (measured) | process-wide `signal()` handler storing to an atomic + a watcher thread that reaps — disposition overrides every thread's mask |

### Run / build

```bash
npm install                 # once, at the repo root (build-time only)
brew install bun cargo      # build-time only — NOT needed to run the .app
cd app/mac
./build.sh                  # bun-compile server+worker, vite build, cargo, bundle
open Clownfish.app
```

`cargo run` also works for iterating on the shell itself: it finds the server /
worker binaries in the repo's `.appbuild/` (build them once with
`bun build --compile`) and the web UI in `dist/`.

Verified headlessly: the window opens at the requested logical size, the
WKWebView connects to the server (`WebKit.Networking` socket), spawn mode
brings the server up on a free port with `/api/health` answering, and SIGTERM
leaves **zero** surviving processes or listeners. What needs eyes on a real
desktop: traffic-light rendering inside the HTML header, drag feel, Cmd+C/V
against the muda menu.

Env knobs:

- `CLOWNFISH_APP_URL` — **attach mode**: don't spawn anything, open this URL
  (dev loop with `make dev`, or a remote host; that server keeps whatever auth
  it has — no token is injected).
- `CLOWNFISH_APP_SERVER` / `CLOWNFISH_APP_WORKER` / `CLOWNFISH_APP_WEB_DIST` —
  override where the shell finds the compiled binaries / web UI (defaults:
  beside the executable — the `.app` layout — then the repo's `.appbuild/` /
  `dist`, which is the `cargo run` layout).

The shell binds nothing itself; the server always gets `CLOWNFISH_BIND=127.0.0.1`
— loopback only, no other machine can reach it, and the one-time token gates
even local browsers without it.

### Known v1 limits

- The binaries are ~65 MB each (bun embeds its runtime) — the bundle is
  ~130 MB; `bun build --compile --bytecode` may shrink it later.
- Not codesigned/notarized: right-click → Open on first launch, or `xattr -d com.apple.quarantine`.
- No app icon unless `assets/logo.icns` exists (`node scripts/logo-assets.mjs`
  at the repo root generates it).
