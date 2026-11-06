import { CommandAction, Ineligible } from "../../src/run/action.ts";
import { type Context } from "../../src/run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../src/run/task.ts";
import { learnLocalDocker } from "../../src/tasks/docker/local-docker.ts";

export interface AirbyteSelection {
  containerIds: readonly string[];
  volumeNames: readonly string[];
}

/** Native uninstall owns application semantics; explicit inventory bounds its effects. */
export class AirbyteRemovalCleanup extends CleanupTask {
  readonly selection: AirbyteSelection;
  readonly env: Readonly<Record<string, string | undefined>>;
  constructor(
    identity: TaskIdentity,
    selection: AirbyteSelection,
    env: Readonly<Record<string, string | undefined>>,
  ) {
    super(identity);
    this.selection = selection;
    this.env = env;
  }
  protected async discover(ctx: Context): Promise<Discovery> {
    const selection = this.selection;
    const docker = await learnLocalDocker(ctx);
    await docker.assertLocal(ctx);
    const status = await ctx.host.run(
      { file: "abctl", args: ["local", "status"] },
      ctx.signal,
    );
    let before = await docker.inventory(ctx);
    const guard = async (context: Context) => {
      await docker.assertLocal(context);
      // abctl has no --context flag: its process must inherit the same daemon selection.
      const current = (
        await context.host.run(
          { file: "docker", args: ["context", "show"] },
          context.signal,
        )
      ).trim();
      if (
        current !== docker.context ||
        this.env.DOCKER_HOST ||
        this.env.DOCKER_CONTEXT
      )
        throw new Ineligible(
          "abctl requires the selected local Docker context without environment overrides",
        );
      before = await docker.inventory(context);
      for (const id of selection.containerIds) {
        const container = before.containers.find((c) => c.Id === id);
        if (!container)
          throw new Ineligible(`Selected Airbyte container is absent: ${id}`);
        if (container.State.Running)
          throw new Ineligible(
            `Stop the selected Airbyte stack before removal: ${id}`,
          );
      }
    };
    return {
      configured: true,
      notes: [
        status.trim(),
        "Native abctl removes its local installation and persisted data. Only explicitly listed owned resources may disappear.",
      ],
      actions: [
        new CommandAction(
          {
            target: "Airbyte local installation",
            estimatedBytes: null,
            reason:
              "Explicit removal of an abandoned application and its persisted data",
          },
          { file: "abctl", args: ["local", "uninstall", "--persisted"] },
          guard,
          async (context) => {
            await docker.assertPreserved(
              {
                containers: before.containers.filter(
                  (c) => !selection.containerIds.includes(c.Id),
                ),
                volumes: before.volumes.filter(
                  (v) => !selection.volumeNames.includes(v),
                ),
              },
              false,
              context,
            );
            const after = await docker.inventory(context);
            if (
              after.containers.some((c) =>
                selection.containerIds.includes(c.Id),
              ) ||
              after.volumes.some((v) => selection.volumeNames.includes(v))
            )
              throw new Error(
                "Selected Airbyte resources remain after uninstall",
              );
          },
        ),
      ],
    };
  }
}
