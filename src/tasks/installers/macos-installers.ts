import { readdir } from "node:fs/promises";
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
 * "Install macOS <name>.app" bundles for a macOS that is not newer than the one this Mac
 * runs. Apple's own tools give the versions: softwareupdate maps installer titles to
 * versions, sw_vers gives the running version.
 */
export class MacOSInstallersCleanup extends CleanupTask {
  readonly applications: string;
  constructor(identity: TaskIdentity, applications: string) {
    super(identity);
    this.applications = applications;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = { actions: [], notes: [], configured: true };
    if (!(await exists(this.applications))) return result;
    const bundles = (await readdir(this.applications)).filter((name) =>
      /^Install macOS .+\.app$/.test(name),
    );
    if (bundles.length === 0) return result;
    const listing = await context.host.run(
      { file: "softwareupdate", args: ["--list-full-installers"] },
      context.signal,
    );
    const majors = new Map<string, number>();
    for (const [, title, version] of listing.matchAll(
      /Title: (.+?), Version: (\d+)/g,
    )) {
      majors.set(title, Number(version));
      // softwareupdate titles macOS 27 "macOS 27 Golden Gate" (2026-11-06). The bundle name of
      // its installer is not verified (a 17 GB download), so the name without the number counts too.
      majors.set(title.replace(/^macOS \d+ /, "macOS "), Number(version));
    }
    const running = Number(
      (
        await context.host.run(
          { file: "sw_vers", args: ["-productVersion"] },
          context.signal,
        )
      ).split(".")[0],
    );
    // This task owns the Applications folder only for these installer bundles.
    const policy = new PathPolicy([this.applications], []);
    for (const bundle of bundles) {
      const title = bundle.slice("Install ".length, -".app".length);
      const major = majors.get(title);
      const path = join(this.applications, bundle);
      if (major === undefined) {
        result.notes.push(`Version unknown, kept: ${path}`);
        continue;
      }
      if (major > running) {
        result.notes.push(
          `Newer than this Mac (${major} > ${running}), kept: ${path}`,
        );
        continue;
      }
      try {
        result.actions.push(
          await removeAction(
            path,
            `Installer for macOS ${major}; this Mac runs ${running}`,
            policy,
            async () => {},
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
