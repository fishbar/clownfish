import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

// In dev, proxy REST (/api), WebSocket (/chat), and the auth flow (/auth) to the
// Clownfish server. When the server runs with CLOWNFISH_TLS=1, target https/wss
// and don't reject the (self-signed) cert so `CLOWNFISH_TLS=1 make dev` proxies.
const TLS = process.env.CLOWNFISH_TLS || process.env.CLOWNFISH_HTTPS;
const SCHEME = TLS ? "https" : "http";
const SERVER = `${SCHEME}://localhost:4317`;

// The Preact UI lives under server/views (the "view" layer of the MVC server).
// Vite serves from there in dev; the production build is emitted to <root>/dist,
// which the server serves statically (see server/index.ts).
export default defineConfig({
	plugins: [preact()],
	root: "server/views",
	server: {
		host: true, // bind 0.0.0.0 so the UI is reachable via the host's LAN IP, not just localhost
		port: 5173,
		proxy: {
			// Trailing slash on the prefix (not bare "/api") so this matches
			// "/api/projects" but NOT the view module "/api.ts" served by Vite.
			"/api/": { target: SERVER, secure: false },
			"/auth/": { target: SERVER, secure: false },
			"/chat": { target: SERVER.replace("http", "ws"), ws: true, secure: false },
		},
	},
	build: {
		outDir: fileURLToPath(new URL("./dist", import.meta.url)),
		emptyOutDir: true,
		sourcemap: true,
	},
});
