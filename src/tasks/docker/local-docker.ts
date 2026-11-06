import { Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import { type Command } from "../../run/host.ts";

interface Container {
  Id: string;
  Image: string;
  State: { Running: boolean };
}

interface Inventory {
  containers: Container[];
  volumes: string[];
}

export function lines(value: string) {
  return value.trim() === "" ? [] : value.trim().split("\n");
}

/** Context-bound adapter; every call carries the same explicit Docker context. */
export class LocalDocker {
  readonly context: string;
  constructor(context: string) {
    this.context = context;
  }
  command(args: string[]): Command {
    return { file: "docker", args: ["--context", this.context, ...args] };
  }
  async read(args: string[], ctx: Context): Promise<string> {
    return ctx.host.run(this.command(args), ctx.signal);
  }
  async assertLocal(ctx: Context): Promise<void> {
    const records = JSON.parse(
      await this.read(["context", "inspect", this.context], ctx),
    ) as { Endpoints: { docker: { Host: string } } }[];
    if (
      records.length !== 1 ||
      !records[0].Endpoints.docker.Host.startsWith("unix://")
    ) {
      throw new Ineligible(
        "Routine Docker cleanup only accepts a verified local Unix-socket context",
      );
    }
  }
  async assertLocalBuilder(ctx: Context): Promise<void> {
    const inspection = await this.read(
      ["buildx", "inspect", this.context],
      ctx,
    );
    const driver = /^Driver:\s*(\S+)/m.exec(inspection)?.[1];
    const endpoints = [...inspection.matchAll(/^\s*Endpoint:\s*(\S+)/gm)].map(
      (match) => match[1],
    );
    if (
      driver !== "docker" ||
      endpoints.length !== 1 ||
      endpoints[0] !== this.context ||
      /^\s*Error:/m.test(inspection)
    ) {
      throw new Ineligible(
        "Build cache requires the context's native local Docker builder",
      );
    }
  }
  async inventory(ctx: Context): Promise<Inventory> {
    const ids = lines(
      await this.read(
        ["container", "ls", "--all", "--quiet", "--no-trunc"],
        ctx,
      ),
    );
    const containers: Container[] =
      ids.length === 0
        ? []
        : JSON.parse(await this.read(["container", "inspect", ...ids], ctx));
    return {
      containers,
      volumes: lines(await this.read(["volume", "ls", "--quiet"], ctx)),
    };
  }
  async assertPreserved(
    before: Inventory,
    runningOnly: boolean,
    ctx: Context,
  ): Promise<void> {
    const after = await this.inventory(ctx);
    if (before.volumes.some((name) => !after.volumes.includes(name)))
      throw new Error(
        "A pre-existing Docker volume disappeared during cleanup",
      );
    for (const container of before.containers) {
      if (runningOnly && !container.State.Running) continue;
      const found = after.containers.find((item) => item.Id === container.Id);
      if (!found || (container.State.Running && !found.State.Running))
        throw new Error(
          `Pre-existing container was removed/stopped: ${container.Id}`,
        );
    }
  }
}

/** The engine this machine's Docker CLI currently points at; assertLocal refuses remote ones. */
export async function learnLocalDocker(ctx: Context): Promise<LocalDocker> {
  return new LocalDocker(
    (
      await ctx.host.run(
        { file: "docker", args: ["context", "show"] },
        ctx.signal,
      )
    ).trim(),
  );
}
