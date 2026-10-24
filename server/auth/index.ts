/**
 * Auth (opt-in: OAuth2/OIDC with email/domain allowlist, simple username+password, or
 * the app shell's one-time token) — public surface.
 */
export { loadAuthConfig, loginPath, AuthConfigError } from "./config";
export type { AuthConfig, OAuthAuthConfig, SimpleAuthConfig, TokenAuthConfig, AuthUser } from "./config";
export { readSession } from "./session";
export { createAuthRouter, createAutologinRouter, authMeDisabled } from "./routes";
export { requireAuth } from "./middleware";
export { runAuthWizard } from "./wizard";
