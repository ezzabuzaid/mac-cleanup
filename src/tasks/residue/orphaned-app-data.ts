import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MachineInventory,
  type OwnerSource,
  nameKey,
  nameTokens,
} from "../../machine/inventory.ts";

import { PathPolicy } from "../../paths/policy.ts";
import { allocatedBytes, removeAction } from "../../paths/remove.ts";
import { walk } from "../../paths/walk.ts";
import { exists, within } from "../../paths/within.ts";
import { Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

// macOS keeps these itself; they name no installable owner.
const systemEntries = new Set([
  ".Trash",
  ".ssh",
  ".gnupg",
  ".config",
  ".cache",
  ".local",
  ".cups",
  ".IdentityService",
  ".CFUserTextEncoding",
  "AddressBook",
  "CallHistoryDB",
  "CallHistoryTransactions",
  "CloudDocs",
  "CrashReporter",
  "DiskImages",
  "DifferentialPrivacy",
  "FaceTime",
  "FileProvider",
  "Knowledge",
  "iCloud",
  "Animoji",
  "SESStorage",
  "networkserviceproxy",
  "ControlCenter",
  "MobileSync",
  "SyncServices",
  "homeenergyd",
  "icdd",
  "locationaccessstored",
  "IntelligenceFlow",
  "Caches",
  "App Store",
  "AppExit",
  "Music",
  "iMovie",
]);

/** App data in Application Support or a hidden home folder that no installed thing owns. */
export class OrphanedAppDataCleanup extends CleanupTask {
  static #owned(name: string, owners: readonly OwnerSource[]): boolean {
    const key = nameKey(name);
    const tokens = nameTokens(name);
    return owners.some(({ keys }) => {
      if (keys.has(key) || tokens.some((token) => keys.has(token))) return true;
      for (const owner of keys)
        if (
          (owner.length >= 4 && key.includes(owner)) ||
          (key.length >= 4 && owner.includes(key))
        )
          return true;
      return false;
    });
  }

  /**
   * The newest modify or access time of anything inside. macOS does not reliably update
   * access times on a read (measured), so this is not "last read"; it only keeps more
   * folders than modify times alone, never fewer.
   */
  static async #lastUsed(path: string, signal: AbortSignal): Promise<number> {
    const first = await lstat(path);
    let latest = Math.max(first.mtimeMs, first.atimeMs);
    for await (const child of walk(path, new Set(), signal)) {
      const info = await lstat(child);
      latest = Math.max(latest, info.mtimeMs, info.atimeMs);
    }
    return latest;
  }
  readonly inventory: MachineInventory;
  readonly policy: PathPolicy;
  readonly olderThanDays: number;
  constructor(
    identity: TaskIdentity,
    inventory: MachineInventory,
    olderThanDays: number,
    policy: PathPolicy,
  ) {
    super(identity);
    this.inventory = inventory;
    this.olderThanDays = olderThanDays;
    this.policy = policy;
  }
  private referenced(path: string, name: string, shell: string): boolean {
    const { pathDirs, env } = this.inventory.roots;
    return (
      pathDirs.some((directory) => within(path, directory)) ||
      Object.values(env).some((value) => value?.includes(path) === true) ||
      shell.includes(`/${name}`)
    );
  }
  protected async discover(context: Context): Promise<Discovery> {
    const { home } = this.inventory.roots;
    const support = join(home, "Library/Application Support");
    const owners = await this.inventory.owners(context);
    const shell = await this.inventory.shellStartup();
    const evidence = owners
      .map(({ source, keys }) => `${keys.size} ${source}`)
      .join(", ");
    const entries: string[] = [];
    for (const name of await readdir(home))
      if (name.startsWith(".")) entries.push(join(home, name));
    if (await exists(support))
      for (const name of await readdir(support))
        if (!name.startsWith("com.apple.")) entries.push(join(support, name));
    const result: Discovery = { actions: [], notes: [], configured: true };
    const cutoff = () => Date.now() - this.olderThanDays * 86400_000;
    // The machine proposes; only a candidate the user names exactly for this run is
    // removed. Selecting a parent folder approves nothing.
    const chosen = new Set(context.selected.map((choice) => resolve(choice)));
    const selected = (path: string) => chosen.has(path);
    const why = new Map<string, string>();
    const review: { bytes: number; note: string }[] = [];
    for (const path of entries) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!(await lstat(path)).isDirectory()) continue;
      if (systemEntries.has(name)) {
        why.set(path, "macOS keeps it");
        continue;
      }
      if (OrphanedAppDataCleanup.#owned(name, owners)) {
        why.set(path, "an installed owner matches its name");
        continue;
      }
      if (this.referenced(path, name, shell)) {
        why.set(path, "PATH, the environment or a shell startup file names it");
        continue;
      }
      const latest = await OrphanedAppDataCleanup.#lastUsed(
        path,
        context.signal,
      );
      const used = new Date(latest).toISOString().slice(0, 10);
      if (latest > cutoff()) {
        why.set(path, `used within ${this.olderThanDays} days`);
        result.notes.push(`Used within ${this.olderThanDays} days: ${path}`);
        continue;
      }
      if (!selected(path)) {
        const bytes = await allocatedBytes(path, context);
        review.push({
          bytes,
          note: `Review: ${path} — ${(bytes / 1024 ** 3).toFixed(2)} GiB, last used ${used}; no owner among ${evidence}. Add it to --select to remove it.`,
        });
        continue;
      }
      try {
        result.actions.push(
          await removeAction(
            path,
            `Selected; no owner among ${evidence}; last used ${used}`,
            this.policy,
            async (ctx) => {
              if (
                (await OrphanedAppDataCleanup.#lastUsed(path, ctx.signal)) >
                cutoff()
              )
                throw new Ineligible(
                  `Used within ${this.olderThanDays} days: ${path}`,
                );
            },
            context,
          ),
        );
      } catch (error) {
        if (!(error instanceof Ineligible)) throw error;
        why.set(path, error.message);
        result.notes.push(error.message);
      }
    }
    review.sort((a, b) => b.bytes - a.bytes);
    result.notes.push(...review.map((item) => item.note));
    for (const choice of chosen)
      if (!result.actions.some((action) => action.view.target === choice))
        result.notes.push(
          `Not removed: ${choice}: ${why.get(choice) ?? "not a candidate folder in Application Support or the home folder"}`,
        );
    return result;
  }
}
