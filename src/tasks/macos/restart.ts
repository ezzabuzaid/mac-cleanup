import { CommandAction } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import { CleanupTask, type Discovery } from "../../run/task.ts";

/** macOS owns restart; the accepted request is the observable, not a completed reboot. */
export class RestartCleanup extends CleanupTask {
  protected async discover(ctx: Context): Promise<Discovery> {
    const swap = await ctx.host.run(
      { file: "sysctl", args: ["vm.swapusage"] },
      ctx.signal,
    );
    return {
      configured: true,
      notes: [
        swap.trim(),
        "Restart is requested through macOS. Apps may ask to save work or cancel it. Completion means the request was accepted; reboot and recovery cannot be verified by this process.",
      ],
      actions: [
        new CommandAction(
          {
            target: "macOS restart",
            estimatedBytes: null,
            reason:
              "Release swap through an orderly restart; never delete swap files",
          },
          {
            file: "osascript",
            args: ["-e", 'tell application "System Events" to restart'],
          },
          async (context) => {
            await context.host.run(
              { file: "sysctl", args: ["vm.swapusage"] },
              context.signal,
            );
          },
          async (context) => {
            context.signal.throwIfAborted();
          },
        ),
      ],
    };
  }
}
