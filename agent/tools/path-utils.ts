/**
 * Path resolution for tools.
 *
 * Simplified from pi's path-utils: `~` expansion + absolute resolution against
 * the workspace cwd. pi's macOS screenshot/NFD filename variants are dropped —
 * they exist for screenshot edge cases that don't apply to a coding workspace.
 */
import { access, constants } from "node:fs/promises";
export { resolveToCwd } from "../paths";
