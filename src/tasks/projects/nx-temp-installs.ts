import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * Nx's daemon installs nx@latest into <tmp>/tmp-<pid>-* and removes it only at a clean
 * shutdown (nx/dist/src/daemon/server/latest-nx.js), so a daemon that died leaves it behind.
 */
export class NxTempInstallsCleanup extends CleanupTask {
  readonly directory: string;
  readonly uid: number;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    directory: string,
    uid: number,
    policy: PathPolicy,
  ) {
    super(identity);
    this.directory = directory;
    this.uid = uid;
    this.policy = policy;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = { actions: [], notes: [], configured: true };
    if (!(await exists(this.directory))) return result;
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      const pid = /^tmp-(\d+)-/.exec(entry.name)?.[1];
      if (pid === undefined || !entry.isDirectory()) continue;
      const path = join(this.directory, entry.name);
      if (
        (await stat(path)).uid !== this.uid ||
        !(await exists(join(path, "node_modules/nx/package.json")))
      )
        continue;
      const guard = async () => {
        try {
          process.kill(Number(pid), 0);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          )
            return;
          throw error;
        }
        throw new Ineligible(`Process ${pid} is still running: ${path}`);
      };
      try {
        result.actions.push(
          await removeAction(
            path,
            `Nx install left by daemon process ${pid}, which has exited`,
            this.policy,
            guard,
            context,
          ),
        );
      } catch (error) {
        if (!(error instanceof Ineligible)) throw error;
        result.notes.push(error.message);
      }
    }
    return result;
  }
}
