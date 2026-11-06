import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Discovery terminates at selected directories and never follows symlinks. */
export async function* walk(
  root: string,
  stopNames: ReadonlySet<string>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    yield path;
    if (entry.isDirectory() && !stopNames.has(entry.name))
      yield* walk(path, stopNames, signal);
  }
}
