import { dirname, join } from "node:path";

import { PathPolicy } from "../../paths/policy.ts";
import { allocatedBytes } from "../../paths/remove.ts";
import { exists } from "../../paths/within.ts";
import { CommandAction } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

export type PackageManager = "npm" | "uv" | "pip";

/** One class composes the three native package-manager protocols. */
export class PackageCacheCleanup extends CleanupTask {
  readonly manager: PackageManager;
  readonly directory: string | null;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    manager: PackageManager,
    directory: string | null,
    policy: PathPolicy,
  ) {
    super(identity);
    this.manager = manager;
    this.directory = directory;
    this.policy = policy;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const read = {
      npm: { file: "npm", args: ["config", "get", "cache"] },
      uv: { file: "uv", args: ["cache", "dir"] },
      pip: { file: "pip3", args: ["cache", "dir"] },
    }[this.manager];
    const directory =
      this.directory === null
        ? (await context.host.run(read, context.signal)).trim()
        : this.directory;
    const target =
      this.manager === "npm" ? join(directory, "_cacache") : directory;
    if (!(await exists(target)))
      return {
        actions: [],
        notes: [`Cache absent: ${target}`],
        configured: true,
      };
    await this.policy.validate(target);
    const bytes = await allocatedBytes(target, context);
    const command = {
      npm: {
        file: "npm",
        args: ["cache", "clean", "--force", "--cache", directory],
      },
      uv: {
        file: "uv",
        args: ["cache", "clean", "--cache-dir", directory, "--offline"],
      },
      pip: { file: "pip3", args: ["--cache-dir", directory, "cache", "purge"] },
    }[this.manager];
    const npx = join(dirname(target), "_npx");
    const preserveNpx = this.manager === "npm" && (await exists(npx));
    const action = new CommandAction(
      {
        target,
        estimatedBytes: bytes,
        reason: `${this.manager} native download-cache cleanup; installed environments preserved`,
      },
      command,
      async (ctx) => {
        await this.policy.validate(target);
        await this.policy.assertUnused(target, ctx);
      },
      async () => {
        if (preserveNpx && !(await exists(npx)))
          throw new Error(
            "npm removed the protected npx installation directory",
          );
      },
    );
    return {
      actions: [action],
      notes: [
        "Cache contents are selected by the native tool at execution time; size is an estimate.",
      ],
      configured: true,
    };
  }
}
