import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { MachineInventory } from "../../machine/inventory.ts";

import { PathPolicy } from "../../paths/policy.ts";
import { removeAction } from "../../paths/remove.ts";
import { walk } from "../../paths/walk.ts";
import { exists } from "../../paths/within.ts";
import { Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

const scanStops = new Set([
  ".git",
  "node_modules",
  ".nx",
  ".build",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "Library",
  "CloudStorage",
  "Mobile Documents",
  "models",
]);

/** Project-wide evidence is shared by dependency and generated-output cleanup. */
export class ProjectArtifactsCleanup extends CleanupTask {
  readonly inventory: MachineInventory;
  readonly kind: "dependencies" | "nx" | "builds";
  readonly ageDays: number;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    inventory: MachineInventory,
    kind: "dependencies" | "nx" | "builds",
    ageDays: number,
    policy: PathPolicy,
  ) {
    super(identity);
    this.inventory = inventory;
    this.kind = kind;
    this.ageDays = ageDays;
    this.policy = policy;
  }
  async assertInactive(project: string, context: Context): Promise<void> {
    const cutoff = Date.now() - this.ageDays * 86400_000;
    const gitRoot = (
      await context.host.run(
        { file: "git", args: ["-C", project, "rev-parse", "--show-toplevel"] },
        context.signal,
      )
    ).trim();
    await this.policy.assertUnused(gitRoot, context);
    // Monorepo activity protects dependencies at every depth.
    const status = await context.host.run(
      {
        file: "git",
        args: [
          "-C",
          gitRoot,
          "status",
          "--porcelain",
          "--untracked-files=normal",
        ],
      },
      context.signal,
    );
    if (status.trim() !== "")
      throw new Ineligible(`Uncommitted project work: ${gitRoot}`);
    const reflog = await context.host.run(
      {
        file: "git",
        args: ["-C", gitRoot, "reflog", "-1", "--date=unix", "--format=%gd"],
      },
      context.signal,
    );
    const time = /@\{(\d+)\}/.exec(reflog);
    if (time && Number(time[1]) * 1000 > cutoff)
      throw new Ineligible(`Recent Git activity: ${gitRoot}`);
    const commitTime = Number(
      (
        await context.host.run(
          { file: "git", args: ["-C", gitRoot, "log", "-1", "--format=%ct"] },
          context.signal,
        )
      ).trim(),
    );
    if (!Number.isFinite(commitTime) || commitTime <= 0)
      throw new Ineligible(`Cannot establish last commit: ${gitRoot}`);
    if (commitTime * 1000 > cutoff)
      throw new Ineligible(`Recent commit: ${gitRoot}`);
    for await (const path of walk(gitRoot, scanStops, context.signal)) {
      if (scanStops.has(basename(path))) continue;
      if ((await lstat(path)).mtimeMs > cutoff)
        throw new Ineligible(`Recent project activity: ${path}`);
    }
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = { actions: [], notes: [], configured: true };
    const seen = new Set<string>();
    for (const root of await this.inventory.projects(context)) {
      if (!(await exists(root))) continue;
      for await (const path of walk(root, scanStops, context.signal)) {
        const name = basename(path);
        const parent = join(path, "..");
        const matches =
          this.kind === "dependencies"
            ? name === "node_modules"
            : this.kind === "nx"
              ? name === ".nx"
              : [".build", "dist", "build", "out"].includes(name);
        if (!matches || seen.has(path)) continue;
        if (!(await lstat(path)).isDirectory()) continue;
        seen.add(path);
        const targets =
          this.kind === "nx" ? await this.nxTargets(path) : [path];
        for (const target of targets) {
          try {
            const guard = async (ctx: Context) => {
              const files = await ctx.host.run(
                { file: "git", args: ["-C", parent, "ls-files", "--", target] },
                ctx.signal,
              );
              if (files.trim() !== "")
                throw new Ineligible(`Tracked files: ${target}`);
              try {
                await ctx.host.run(
                  {
                    file: "git",
                    args: ["-C", parent, "check-ignore", "-q", target],
                  },
                  ctx.signal,
                );
              } catch (error) {
                if (
                  error instanceof Error &&
                  "code" in error &&
                  error.code === 1
                )
                  throw new Ineligible(`Not Git-ignored: ${target}`);
                throw error;
              }
              if (this.kind === "nx") {
                if (
                  (await lstat(target)).mtimeMs >
                  Date.now() - this.ageDays * 86400_000
                )
                  throw new Ineligible("Recent Nx entry");
              } else {
                if (
                  this.kind === "dependencies" &&
                  !(await exists(join(parent, "package-lock.json"))) &&
                  !(await exists(join(parent, "pnpm-lock.yaml"))) &&
                  !(await exists(join(parent, "yarn.lock"))) &&
                  !(await exists(join(parent, "bun.lock")))
                ) {
                  // A nested package can use the root lockfile; inspect it explicitly.
                  const gitRoot = (
                    await ctx.host.run(
                      {
                        file: "git",
                        args: ["-C", parent, "rev-parse", "--show-toplevel"],
                      },
                      ctx.signal,
                    )
                  ).trim();
                  if (
                    !(
                      await Promise.all(
                        [
                          "package-lock.json",
                          "pnpm-lock.yaml",
                          "yarn.lock",
                          "bun.lock",
                        ].map((file) => exists(join(gitRoot, file))),
                      )
                    ).some(Boolean)
                  )
                    throw new Ineligible("No dependency lockfile");
                }
                await this.assertInactive(parent, ctx);
              }
            };
            result.actions.push(
              await removeAction(
                target,
                `Ignored ${this.kind}; ${this.ageDays}-day activity policy`,
                this.policy,
                guard,
                context,
              ),
            );
          } catch (error) {
            if (
              !(error instanceof Ineligible) &&
              !String(error).includes("not a git repository")
            )
              throw error;
            result.notes.push(`${target}: ${String(error)}`);
          }
        }
      }
    }
    return result;
  }
  private async nxTargets(path: string): Promise<string[]> {
    const cache = join(path, "cache");
    if (!(await exists(cache))) return [];
    return (await readdir(cache, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => join(cache, entry.name));
  }
}
