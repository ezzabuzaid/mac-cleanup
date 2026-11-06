import { lstat, readdir, readlink, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MachineInventory } from "../../machine/inventory.ts";
import { identity, sameIdentity } from "../../paths/identity.ts";
import { PathPolicy } from "../../paths/policy.ts";
import { exists, within } from "../../paths/within.ts";
import { CleanupAction, Ineligible } from "../../run/action.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

/** A target on a volume that is not mounted is missing only for now. */
async function missing(link: string, target: string): Promise<boolean> {
  const absolute = resolve(dirname(link), target);
  if (within("/Volumes", absolute)) return false;
  try {
    await stat(link);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return true;
      // A target in a folder we cannot read is not proven missing.
      if (error.code === "EACCES" || error.code === "EPERM") return false;
    }
    throw error;
  }
}

export class UnlinkAction extends CleanupAction {
  readonly link: string;
  readonly target: string;
  readonly observed: Awaited<ReturnType<typeof identity>>;
  constructor(
    link: string,
    target: string,
    observed: Awaited<ReturnType<typeof identity>>,
  ) {
    super({
      target: link,
      reason: `Link to a missing target: ${target}`,
      estimatedBytes: 0,
    });
    this.link = link;
    this.target = target;
    this.observed = observed;
  }
  protected async check() {
    if (!(await exists(this.link)))
      throw new Ineligible(`Already absent: ${this.link}`);
    if (
      !(await lstat(this.link)).isSymbolicLink() ||
      (await readlink(this.link)) !== this.target ||
      !sameIdentity(this.observed, await identity(this.link))
    )
      throw new Ineligible(`Changed since inspection: ${this.link}`);
    if (!(await missing(this.link, this.target)))
      throw new Ineligible(`Target exists again: ${this.target}`);
  }
  protected async perform() {
    await unlink(this.link);
  }
  protected async verify() {
    if (await exists(this.link))
      throw new Error(`Link remains after removal: ${this.link}`);
  }
}

/** Symlinks in PATH folders whose target is gone (an uninstalled app's CLI shim). */
export class DanglingLinksCleanup extends CleanupTask {
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
  protected async discover(): Promise<Discovery> {
    const result: Discovery = { actions: [], notes: [], configured: true };
    const brew = this.inventory.roots.env.HOMEBREW_PREFIX;
    for (const directory of new Set(this.inventory.roots.pathDirs)) {
      if (!(await exists(directory))) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        const link = join(directory, entry.name);
        const target = await readlink(link);
        if (!(await missing(link, target))) continue;
        if (brew !== undefined && within(brew, directory)) {
          result.notes.push(
            `Homebrew owns ${link} -> ${target}; run: brew cleanup --prune-prefix`,
          );
          continue;
        }
        try {
          await this.policy.validate(directory);
        } catch (error) {
          if (!(error instanceof Ineligible)) throw error;
          result.notes.push(
            `Outside owned roots: ${link} -> ${target}; run: sudo rm ${JSON.stringify(link)}`,
          );
          continue;
        }
        result.actions.push(
          new UnlinkAction(link, target, await identity(link)),
        );
      }
    }
    return result;
  }
}
