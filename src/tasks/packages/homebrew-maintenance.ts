import { CommandAction } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import { CleanupTask, type Discovery } from "../../run/task.ts";

/** Native preview is the discovery seam; the tool retains its own selection policy. */
export class HomebrewMaintenanceCleanup extends CleanupTask {
  protected async discover(context: Context): Promise<Discovery> {
    const preview = await context.host.run(
      { file: "brew", args: ["cleanup", "--dry-run"] },
      context.signal,
    );
    if (preview.trim() === "")
      return {
        actions: [],
        notes: ["Homebrew found nothing to clean"],
        configured: true,
      };
    return {
      actions: [
        new CommandAction(
          {
            target: "Homebrew obsolete versions and downloads",
            reason: preview.trim(),
            estimatedBytes: null,
          },
          { file: "brew", args: ["cleanup"] },
          async (ctx) => {
            await ctx.host.run(
              { file: "brew", args: ["cleanup", "--dry-run"] },
              ctx.signal,
            );
          },
          async (ctx) => {
            await ctx.host.run(
              { file: "brew", args: ["cleanup", "--dry-run"] },
              ctx.signal,
            );
          },
        ),
      ],
      notes: [
        "Homebrew cleanup may remove old installed versions as documented by brew; cache-only removal is a separate task.",
      ],
      configured: true,
    };
  }
}
