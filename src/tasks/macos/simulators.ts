import { CommandAction, Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import { CleanupTask, type Discovery } from "../../run/task.ts";

export class SimulatorRuntimesCleanup extends CleanupTask {
  private async outdated(context: Context): Promise<string> {
    try {
      return await context.host.run(
        {
          file: "xcrun",
          args: ["simctl", "runtime", "delete", "--outdated", "--dry-run"],
        },
        context.signal,
      );
    } catch (error) {
      // Observed native empty-result protocol. Service/permission failures still propagate.
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 2 &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.trim() === "No matching images found to delete"
      )
        return "";
      throw error;
    }
  }
  protected async discover(context: Context): Promise<Discovery> {
    const preview = await this.outdated(context);
    if (preview === "")
      return {
        actions: [],
        notes: ["CoreSimulator reports no superseded runtime images"],
        configured: true,
      };
    const ids = [
      ...new Set(
        [
          ...preview.matchAll(
            /^Would delete \w: ([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})\b/gim,
          ),
        ].map((match) => match[1]),
      ),
    ];
    if (ids.length === 0)
      throw new Error(`Unrecognized simctl dry-run result: ${preview}`);
    const guard = async (ctx: Context) => {
      const { devices } = JSON.parse(
        await ctx.host.run(
          {
            file: "xcrun",
            args: ["simctl", "list", "devices", "booted", "--json"],
          },
          ctx.signal,
        ),
      ) as { devices: Record<string, { state: string }[]> };
      if (
        Object.values(devices)
          .flat()
          .some((device) => device.state === "Booted")
      )
        throw new Ineligible(
          "A simulator is booted; native deletion could shut it down",
        );
    };
    const actions = ids.map(
      (id) =>
        new CommandAction(
          {
            target: id,
            estimatedBytes: null,
            reason: "Apple identifies this runtime as superseded",
          },
          { file: "xcrun", args: ["simctl", "runtime", "delete", id] },
          async (ctx) => {
            await guard(ctx);
            const current = await this.outdated(ctx);
            if (!current.includes(id))
              throw new Ineligible("Runtime is no longer outdated");
          },
          async (ctx) => {
            const remaining = await ctx.host.run(
              { file: "xcrun", args: ["simctl", "runtime", "list", "--json"] },
              ctx.signal,
            );
            if (remaining.includes(id))
              throw new Error("Runtime remains after deletion");
          },
        ),
    );
    return { actions, notes: [preview.trim()], configured: true };
  }
}
