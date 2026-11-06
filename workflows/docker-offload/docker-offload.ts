import { CommandAction } from "../../src/run/action.ts";

import { Ineligible } from "../../src/run/action.ts";
import { type Context } from "../../src/run/context.ts";

import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../src/run/task.ts";

/** Offloading is an explicit workflow; selecting a context itself reclaims no local bytes. */
export class DockerOffloadCleanup extends CleanupTask {
  readonly destination: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  constructor(
    identity: TaskIdentity,
    destination: string,
    env: Readonly<Record<string, string | undefined>>,
  ) {
    super(identity);
    this.destination = destination;
    this.env = env;
  }
  protected async discover(ctx: Context): Promise<Discovery> {
    const destination = this.destination;
    const guard = async (context: Context) => {
      if (this.env.DOCKER_HOST || this.env.DOCKER_CONTEXT)
        throw new Ineligible(
          "Docker environment overrides would bypass context selection",
        );
      const records = JSON.parse(
        await context.host.run(
          { file: "docker", args: ["context", "inspect", destination] },
          context.signal,
        ),
      ) as { Endpoints: { docker: { Host: string } } }[];
      if (
        records.length !== 1 ||
        !records[0].Endpoints.docker.Host.startsWith("ssh://")
      )
        throw new Ineligible(
          "Offload destination must be an existing SSH context",
        );
      await context.host.run(
        {
          file: "docker",
          args: ["--context", destination, "info", "--format", "{{.ID}}"],
        },
        context.signal,
      );
    };
    await guard(ctx);
    return {
      configured: true,
      notes: [
        "This selects the verified remote engine for future Docker commands. Workload deployment and data migration must already be complete; local cleanup remains a separate reviewed action.",
      ],
      actions: [
        new CommandAction(
          {
            target: destination,
            estimatedBytes: 0,
            reason: "Use an existing remote Docker engine for future work",
          },
          { file: "docker", args: ["context", "use", destination] },
          guard,
          async (context) => {
            if (
              (
                await context.host.run(
                  { file: "docker", args: ["context", "show"] },
                  context.signal,
                )
              ).trim() !== destination
            )
              throw new Error("Docker context did not change");
          },
        ),
      ],
    };
  }
}
