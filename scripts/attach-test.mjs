import { WebSocket } from "ws";
const ws = new WebSocket("ws://localhost:4317/chat");
let n = 0;
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: "xeXgi38mt8wO", sessionId: "8OKZMNsAPjFz" })));
ws.on("message", (data) => {
    const f = JSON.parse(data.toString());
    n++;
    const s = JSON.stringify(f).slice(0, 140);
    console.log(`[${n}]`, s);
    if (n >= 25) { ws.close(); process.exit(0); }
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.log(`--- total frames in 6s: ${n}`); process.exit(0); }, 6000);
