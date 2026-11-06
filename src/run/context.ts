import { type Host } from "./host.ts";

export type Mode = "preview" | "apply";

export interface Context {
  mode: Mode;
  host: Host;
  signal: AbortSignal;
  allowed: ReadonlySet<string>;
  /** Absolute paths the user keeps for this run (--keep); targets inside them are skipped. */
  kept: readonly string[];
  /** Absolute paths the user confirms for this run (--select); tasks that need confirmation remove only these. */
  selected: readonly string[];
}
