/**
 * Agent-socket abstraction — the transport-facing shape the manager uses to talk
 * to an agent runtime. A real WebSocket (process mode, over the UDS) satisfies it
 * structurally; share mode uses an in-memory loopback pair instead.
 *
 * `on` is intentionally loose (single signature, any-args listener) so `ws`'s
 * overloaded EventEmitter typing stays assignable.
 */
export interface AgentSocket {
	readyState: number;
	bufferedAmount: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	// Loose on purpose so `ws`'s overloaded EventEmitter typing stays assignable.
	on(event: string, listener: (...args: any[]) => void): unknown;
}

type Listener = (...args: unknown[]) => void;

/** One end of an in-memory loopback pair — messages sent here arrive at the peer. */
export class LoopbackSocket implements AgentSocket {
	readyState = 1; // WebSocket.OPEN
	bufferedAmount = 0;
	private peer?: LoopbackSocket;
	private listeners = new Map<string, Set<Listener>>();
	private closed = false;

	/** Pair this end with its peer (used by createLoopbackPair). */
	wire(peer: LoopbackSocket): void {
		this.peer = peer;
	}

	send(data: string): void {
		if (!this.peer || this.closed) return;
		// Async hop so both ends behave like a real socket (no synchronous reentry).
		queueMicrotask(() => {
			if (this.closed) return;
			for (const cb of this.peer?.listeners.get("message") ?? []) cb(data);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.readyState = 3; // CLOSED
		const peer = this.peer;
		queueMicrotask(() => {
			for (const cb of this.listeners.get("close") ?? []) cb();
			if (peer && !peer.closed) {
				peer.closed = true;
				peer.readyState = 3;
				for (const cb of peer.listeners.get("close") ?? []) cb();
			}
		});
	}

	on(event: string, listener: Listener): unknown {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}

	off(event: string, listener: Listener): void {
		this.listeners.get(event)?.delete(listener);
	}
}

/** A connected pair of in-memory agent sockets (share mode: server ⇄ in-process runtime). */
export function createLoopbackPair(): { a: LoopbackSocket; b: LoopbackSocket } {
	const a = new LoopbackSocket();
	const b = new LoopbackSocket();
	a.wire(b);
	b.wire(a);
	return { a, b };
}
