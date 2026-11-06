import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { MachineInventory } from "../../machine/inventory.ts";

import { PathPolicy } from "../../paths/policy.ts";
import { allocatedBytes } from "../../paths/remove.ts";
import { walk } from "../../paths/walk.ts";
import { exists } from "../../paths/within.ts";
import { CommandAction, Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import { type Command } from "../../run/host.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

const pinFiles = new Set([".nvmrc", ".node-version"]);

const pinStops = new Set([".git", "node_modules", ".nx", "dist", "build"]);

/** nvm Node versions that nothing on this machine asks for. nvm resolves and removes. */
export class NodeVersionsCleanup extends CleanupTask {
  readonly inventory: MachineInventory;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    inventory: MachineInventory,
    policy: PathPolicy,
  ) {
    super(identity);
    this.inventory = inventory;
    this.policy = policy;
  }
  private nvm(script: string, nvmSh: string, value: string): Command {
    return {
      file: "/bin/bash",
      args: [
        "-c",
        `. "$1" --no-use && nvm ${script} "$2"`,
        "nvm",
        nvmSh,
        value,
      ],
    };
  }
  /** `nvm version` prints N/A and exits 3 for a spec with no installed match. */
  private async resolve(
    nvmSh: string,
    spec: string,
    context: Context,
  ): Promise<string | null> {
    try {
      return (
        await context.host.run(this.nvm("version", nvmSh, spec), context.signal)
      ).trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 3)
        return null;
      throw error;
    }
  }
  protected async discover(context: Context): Promise<Discovery> {
    const { env, home } = this.inventory.roots;
    const nvmDir = env.NVM_DIR ?? join(home, ".nvm");
    const nvmSh = join(nvmDir, "nvm.sh");
    if (!(await exists(nvmSh)))
      return {
        actions: [],
        notes: ["nvm is not installed"],
        configured: false,
      };
    const installed = join(nvmDir, "versions/node");
    if (!(await exists(installed)))
      return { actions: [], notes: [], configured: true };
    const notes: string[] = [];
    const keep = new Map<string, string>();
    const want = async (spec: string, why: string) => {
      const version = await this.resolve(nvmSh, spec, context);
      if (version === null)
        notes.push(`${why} asks for ${spec}; not installed`);
      else keep.set(version, why);
    };
    await want("default", "nvm default");
    for (const project of await this.inventory.projects(context))
      for await (const path of walk(project, pinStops, context.signal))
        if (pinFiles.has(basename(path)))
          await want((await readFile(path, "utf8")).trim(), path);
    for (const [version, why] of keep) notes.push(`Kept ${version}: ${why}`);
    const actions: Discovery["actions"] = [];
    for (const version of await readdir(installed)) {
      if (!/^v\d/.test(version) || keep.has(version)) continue;
      const directory = join(installed, version);
      await this.policy.validate(directory);
      actions.push(
        new CommandAction(
          {
            target: directory,
            reason:
              "Not the nvm default and pinned by no .nvmrc or .node-version",
            estimatedBytes: await allocatedBytes(directory, context),
          },
          this.nvm("uninstall", nvmSh, version),
          async (ctx) => {
            await this.policy.validate(directory);
            await this.policy.assertUnused(directory, ctx);
            if ((await this.resolve(nvmSh, "default", ctx)) === version)
              throw new Ineligible(`Now the nvm default: ${version}`);
          },
          async () => {
            if (await exists(directory))
              throw new Error(
                `Version remains after nvm uninstall: ${directory}`,
              );
          },
        ),
      );
    }
    return { actions, notes, configured: true };
  }
}
