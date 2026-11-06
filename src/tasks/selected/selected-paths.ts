import { lstat, readdir } from "node:fs/promises";
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

export interface FileSelection {
  path: string;
  select: "self" | "children";
  olderThanDays: number;
  reason: string;
}

/** Composed selections cover Homebrew downloads, VS Code archives, wallpaper and Trash. */
export class SelectedPathsCleanup extends CleanupTask {
  readonly selections: readonly FileSelection[];
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    selections: readonly FileSelection[],
    policy: PathPolicy,
  ) {
    super(identity);
    this.selections = selections;
    this.policy = policy;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = {
      actions: [],
      notes: [],
      configured: this.selections.length > 0,
    };
    if (!result.configured) result.notes.push("No paths selected");
    for (const selection of this.selections) {
      if (!(await exists(selection.path))) {
        result.notes.push(`Absent: ${selection.path}`);
        continue;
      }
      const paths =
        selection.select === "self"
          ? [selection.path]
          : (await readdir(selection.path)).map((name) =>
              join(selection.path, name),
            );
      for (const path of paths) {
        try {
          const guard = async () => {
            if (
              (await lstat(path)).mtimeMs >
              Date.now() - selection.olderThanDays * 86400_000
            ) {
              throw new Ineligible(`Too recent: ${path}`);
            }
          };
          result.actions.push(
            await removeAction(
              path,
              selection.reason,
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
    }
    return result;
  }
}
