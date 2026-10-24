# win/ — placeholder

The Windows shell is not implemented yet. When it is, the shape mirrors `mac/`:
one Rust binary spawning the server on a free port + a WebView2 window.

Two things get EASIER on Windows: WebView2 implements `-webkit-app-region:
drag` natively (no IPC drag region needed), and key shortcuts are not routed
through a menu bar. Two get harder: process-group cleanup (`Job` objects
instead of `kill(-pgid)`), and the titlebar buttons must be drawn in HTML
(the native ones cannot be kept while hiding the bar).
