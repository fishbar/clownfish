/**
 * Browser-notification hub.
 *
 * Sessions run server-side and outlive their tabs — a finished turn or a
 * pending approval in another tab (or in a tab-less cron/background run) needs
 * a way to pull the user back. This module owns the Web Notifications plumbing:
 * permission handling, dedup (one notification per session+kind until cleared)
 * and click-to-navigate. `App` decides WHEN to notify (window focused, current
 * session, etc.); this file only decides HOW.
 */

const LS_KEY = "notify-enabled";

export type NotifyKind = "turn_end" | "approval" | "error";

export interface NotifyDetail {
	kind: NotifyKind;
	projectId: string;
	sessionId: string;
	title: string;
	body: string;
	/** Who spotted it: "ws" = a mounted ChatPage's own stream, "poll" = the
	 *  sidebar's /api/agents sweep (covers tab-less background runs). */
	source: "ws" | "poll";
}

/** User preference (persisted). Off until they opt in via the 🔔 button. */
export function notifyEnabled(): boolean {
	return localStorage.getItem(LS_KEY) === "1";
}

export function setNotifyEnabled(on: boolean): void {
	localStorage.setItem(LS_KEY, on ? "1" : "0");
}

export function notifySupported(): boolean {
	return typeof Notification !== "undefined";
}

/** Current permission ("granted" | "denied" | "default"; "unsupported" as fallback). */
export function notifyPermission(): string {
	return notifySupported() ? Notification.permission : "unsupported";
}

/**
 * Fire a notification. Safe no-op when unsupported/denied/disabled. Clicking
 * focuses the tab and navigates to the session. Visibility/muting policy lives
 * in App's listener — anything that reaches here is worth showing.
 */
export function showNotification(d: NotifyDetail): void {
	if (!notifyEnabled() || !notifySupported() || Notification.permission !== "granted") return;
	const n = new Notification(`🐠 ${d.title}`, {
		body: d.body,
		tag: `${d.kind}:${d.sessionId}`, // replaces an older notice of the same kind
		icon: "/favicon.ico",
	});
	n.onclick = (): void => {
		window.focus();
		window.location.hash = `#/projects/${d.projectId}/sessions/${d.sessionId}`;
		n.close();
	};
}
