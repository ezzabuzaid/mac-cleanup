import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MachineInventory } from "../../machine/inventory.ts";

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
import { bundle } from "./bundle.ts";

export interface UpdateLocation {
  installed: string;
  staging: string;
}

/** Staged updates of installed apps: Sparkle, Squirrel (ShipIt) and Docker Desktop layouts. */
export class ObsoleteAppUpdatesCleanup extends CleanupTask {
  // Apple's version fields can contain nonnumeric build strings; leave those undecided.
  static #compareVersion(a: string, b: string): -1 | 0 | 1 | null {
    if (a === b) return 0;
    if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return null;
    const left = a.split(".").map(Number),
      right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const x = i < left.length ? left[i] : 0;
      const y = i < right.length ? right[i] : 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  readonly inventory: MachineInventory;
  readonly caches: string;
  readonly support: string;
  constructor(
    identity: TaskIdentity,
    inventory: MachineInventory,
    caches: string,
    support: string,
  ) {
    super(identity);
    this.inventory = inventory;
    this.caches = caches;
    this.support = support;
  }
  private async locations(context: Context): Promise<UpdateLocation[]> {
    const locations: UpdateLocation[] = [];
    for (const app of await this.inventory.apps(context)) {
      if (app.id === "") continue;
      if (await exists(join(app.path, "Contents/Frameworks/Sparkle.framework")))
        locations.push({
          installed: app.path,
          staging: join(
            this.caches,
            app.id,
            "org.sparkle-project.Sparkle/Installation",
          ),
        });
      locations.push({
        installed: app.path,
        staging: join(this.caches, `${app.id}.ShipIt`),
      });
      if (app.id === "com.docker.docker")
        locations.push({
          installed: app.path,
          staging: join(this.support, "com.docker.install/in_progress"),
        });
    }
    return locations;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = { actions: [], notes: [], configured: true };
    const locations = await this.locations(context);
    const policy = new PathPolicy(
      locations.map((location) => location.staging),
      [],
    );
    for (const location of locations) {
      if (
        !(await exists(location.installed)) ||
        !(await exists(location.staging))
      )
        continue;
      // Stop at bundles: traversing their payload would be costly and unnecessary.
      const queue = [location.staging];
      while (queue.length > 0) {
        context.signal.throwIfAborted();
        const directory = queue.shift();
        if (directory === undefined) break;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const path = join(directory, entry.name);
          if (!entry.name.endsWith(".app")) {
            queue.push(path);
            continue;
          }
          const guard = async (ctx: Context) => {
            const installed = await bundle(location.installed, ctx),
              staged = await bundle(path, ctx);
            const version = ObsoleteAppUpdatesCleanup.#compareVersion(
              staged.CFBundleShortVersionString,
              installed.CFBundleShortVersionString,
            );
            const build = ObsoleteAppUpdatesCleanup.#compareVersion(
              staged.CFBundleVersion,
              installed.CFBundleVersion,
            );
            if (
              installed.CFBundleIdentifier !== staged.CFBundleIdentifier ||
              version === null ||
              version > 0 ||
              (version === 0 && (build === null || build > 0))
            ) {
              throw new Ineligible(
                `Pending/newer or unrecognized staged version: ${path}`,
              );
            }
          };
          try {
            result.actions.push(
              await removeAction(
                path,
                "Staged application is already installed or obsolete",
                policy,
                guard,
                context,
              ),
            );
          } catch (error) {
            if (!(error instanceof Ineligible)) throw error;
            result.notes.push(error.message);
          }
        }
      }
    }
    return result;
  }
}
