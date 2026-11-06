import { lstat, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import {
  type AppBundle,
  type MachineInventory,
  nameKey,
  nameTokens,
} from "../../machine/inventory.ts";
import { PathPolicy } from "../../paths/policy.ts";
import { removeAction } from "../../paths/remove.ts";
import { exists } from "../../paths/within.ts";
import { Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

const installerTypes = new Set([".dmg", ".pkg", ".mpkg", ".xip", ".iso"]);
// Installer names carry platform words that name no app.
const platformTokens = new Set([
  "arm64",
  "x86",
  "x64",
  "intel",
  "universal",
  "darwin",
  "setup",
  "installer",
  "osx",
]);

/**
 * Installer files at the top level of the user's download, desktop and document
 * folders. The machine's installed apps tell which installers are no longer needed.
 */
export class InstallerFilesCleanup extends CleanupTask {
  readonly directories: readonly string[];
  readonly olderThanDays: number;
  readonly inventory: MachineInventory;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    directories: readonly string[],
    olderThanDays: number,
    inventory: MachineInventory,
    policy: PathPolicy,
  ) {
    super(identity);
    this.directories = directories;
    this.olderThanDays = olderThanDays;
    this.inventory = inventory;
    this.policy = policy;
  }
  /** The installed app whose name the installer file names, if any. */
  static #installedAs(
    file: string,
    apps: readonly AppBundle[],
  ): AppBundle | undefined {
    const tokens = nameTokens(basename(file, extname(file))).filter(
      (token) => !platformTokens.has(token),
    );
    return apps.find((app) => {
      const keys = new Set([
        nameKey(app.name),
        ...nameTokens(app.name),
        ...nameTokens(app.executable),
      ]);
      return tokens.some((token) => keys.has(token));
    });
  }
  /** The single app a .zip holds (macOS resource forks aside), or null. */
  static async #zippedApp(
    path: string,
    context: Context,
  ): Promise<string | null> {
    const entries = (
      await context.host.run(
        { file: "zipinfo", args: ["-1", path] },
        context.signal,
      )
    )
      .split("\n")
      .filter((entry) => entry !== "" && !entry.startsWith("__MACOSX/"));
    const roots = new Set(entries.map((entry) => entry.split("/")[0]));
    const [root] = roots;
    return roots.size === 1 && root.endsWith(".app") ? root.slice(0, -4) : null;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const apps = await this.inventory.apps(context);
    const result: Discovery = { actions: [], notes: [], configured: true };
    for (const directory of this.directories) {
      if (!(await exists(directory))) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(directory, entry.name);
        const type = extname(entry.name).toLowerCase();
        let reason: string;
        if (type === ".zip") {
          const name = await InstallerFilesCleanup.#zippedApp(path, context);
          const app =
            name === null
              ? undefined
              : apps.find(
                  (item) =>
                    item.name === name || basename(item.path, ".app") === name,
                );
          if (app === undefined) continue;
          reason = `App archive; installed as ${basename(app.path)}`;
        } else if (installerTypes.has(type)) {
          const app = InstallerFilesCleanup.#installedAs(entry.name, apps);
          reason =
            app === undefined
              ? "Old installer; no matching app installed"
              : `Installer; installed as ${basename(app.path)}`;
        } else continue;
        try {
          result.actions.push(
            await removeAction(
              path,
              reason,
              this.policy,
              async () => {
                if (
                  (await lstat(path)).mtimeMs >
                  Date.now() - this.olderThanDays * 86400_000
                )
                  throw new Ineligible(`Recent installer: ${path}`);
              },
              context,
            ),
          );
        } catch (error) {
          if (!(error instanceof Ineligible)) throw error;
          result.notes.push(`${error.message} (${reason})`);
        }
      }
    }
    return result;
  }
}
