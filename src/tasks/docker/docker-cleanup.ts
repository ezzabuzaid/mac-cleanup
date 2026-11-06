import { CommandAction, Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";
import { learnLocalDocker, lines } from "./local-docker.ts";

interface Image {
  Id: string;
  RepoDigests: string[] | null;
  Size: number;
}

export class DockerCleanup extends CleanupTask {
  readonly kind: "images" | "build-cache" | "system";
  constructor(
    identity: TaskIdentity,
    kind: "images" | "build-cache" | "system",
  ) {
    super(identity);
    this.kind = kind;
  }
  protected async discover(ctx: Context): Promise<Discovery> {
    const docker = await learnLocalDocker(ctx);
    await docker.assertLocal(ctx);
    if (this.kind === "build-cache") await docker.assertLocalBuilder(ctx);
    const daemonId = (
      await docker.read(["info", "--format", "{{.ID}}"], ctx)
    ).trim();
    const before = await docker.inventory(ctx);
    let executionInventory = before;
    const guard = async (context: Context) => {
      await docker.assertLocal(context);
      if (this.kind === "build-cache") await docker.assertLocalBuilder(context);
      if (
        (await docker.read(["info", "--format", "{{.ID}}"], context)).trim() !==
        daemonId
      )
        throw new Ineligible("Docker daemon changed after inspection");
      executionInventory = await docker.inventory(context);
    };
    const verify = (context: Context) =>
      docker.assertPreserved(
        executionInventory,
        this.kind === "system",
        context,
      );
    if (this.kind !== "images") {
      const usage = await docker.read(["system", "df"], ctx);
      const args =
        this.kind === "system"
          ? ["system", "prune", "--all", "--force"]
          : [
              "buildx",
              "prune",
              "--builder",
              docker.context,
              "--all",
              "--force",
            ];
      return {
        actions: [
          new CommandAction(
            {
              target: `Docker ${docker.context}/${this.kind}`,
              estimatedBytes: null,
              reason: `${this.kind === "system" ? "Unused images, stopped containers, networks and build cache" : "Unused build cache"}; no volumes`,
            },
            docker.command(args),
            guard,
            verify,
          ),
        ],
        configured: true,
        notes: [
          usage.trim(),
          "Native prune selects eligible objects when executed; this preview is a scope, not a frozen object list.",
        ],
      };
    }
    const ids = [
      ...new Set(
        lines(await docker.read(["image", "ls", "--quiet", "--no-trunc"], ctx)),
      ),
    ];
    const images: Image[] =
      ids.length === 0
        ? []
        : JSON.parse(await docker.read(["image", "inspect", ...ids], ctx));
    const actions: Discovery["actions"] = [];
    for (const image of images) {
      if (
        before.containers.some((c) => c.Image === image.Id) ||
        image.RepoDigests === null ||
        image.RepoDigests.length === 0
      )
        continue;
      actions.push(
        new CommandAction(
          {
            target: image.Id,
            estimatedBytes: image.Size,
            reason:
              "Unused image with a registry digest; locally built-only images are excluded",
          },
          docker.command(["image", "rm", image.Id]),
          async (context) => {
            await guard(context);
            if (executionInventory.containers.some((c) => c.Image === image.Id))
              throw new Ineligible("Image is now used by a container");
          },
          verify,
        ),
      );
    }
    return {
      actions,
      notes: [
        "Image sizes share layers; do not sum them as guaranteed recovery. Removal never uses --force.",
      ],
      configured: true,
    };
  }
}
