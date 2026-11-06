import { lstat, readdir } from "node:fs/promises";
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

export class ChromeClonesCleanup extends CleanupTask {
  readonly directory: string;
  readonly inventory: MachineInventory;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    directory: string,
    inventory: MachineInventory,
    policy: PathPolicy,
  ) {
    super(identity);
    this.directory = directory;
    this.inventory = inventory;
    this.policy = policy;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const actions: Discovery["actions"] = [];
    const installed = (await this.inventory.apps(context)).find(
      (app) => app.id === "com.google.Chrome",
    )?.path;
    if (!(await exists(this.directory)) || installed === undefined)
      return {
        actions,
        notes: ["No Chrome clone directory or installed app"],
        configured: true,
      };
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !entry.name.startsWith("code_sign_clone."))
        continue;
      const path = join(this.directory, entry.name);
      const guard = async (ctx: Context) => {
        const children = await readdir(path);
        if (children.length !== 1 || children[0] !== "Google Chrome.app.bundle")
          throw new Ineligible("Unexpected clone contents");
        const original = await bundle(installed, ctx),
          copy = await bundle(join(path, children[0]), ctx);
        if (
          copy.CFBundleIdentifier !== "com.google.Chrome" ||
          copy.CFBundleVersion !== original.CFBundleVersion
        )
          throw new Ineligible("Clone does not match installed Chrome");
        if ((await lstat(path)).mtimeMs > Date.now() - 3600_000)
          throw new Ineligible("Recent Chrome clone");
      };
      try {
        actions.push(
          await removeAction(
            path,
            "Verified stale Chrome application clone",
            this.policy,
            guard,
            context,
          ),
        );
      } catch (error) {
        if (!(error instanceof Ineligible)) throw error;
      }
    }
    return {
      actions,
      notes: [
        "Active copies are checked again with lsof before removal; APFS clone sizes overstate physical recovery.",
      ],
      configured: true,
    };
  }
}
