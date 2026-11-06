import { dirname } from "node:path";
import type { CleanupTask, TaskIdentity } from "../src/run/task.ts";
import { PathPolicy } from "../src/paths/policy.ts";
import { policy } from "../profile.ts";
import { SqliteRelocationCleanup } from "./sqlite-relocation/relocation.ts";
import { AirbyteRemovalCleanup } from "./airbyte/airbyte-removal.ts";
import { DockerOffloadCleanup } from "./docker-offload/docker-offload.ts";
import { DuplicateReferencesCleanup } from "./duplicate-references/duplicate-references.ts";
import { WorkflowInput } from "./input.ts";

/** An opt-in task whose targets come from the user's input file, never from the repo. */
export interface Workflow {
  identity: TaskIdentity;
  /** env is the caller's environment; the CLI passes process.env. */
  build(
    value: unknown,
    env: Readonly<Record<string, string | undefined>>,
  ): CleanupTask;
}

const explicit = (id: string, name: string, method: number): TaskIdentity => ({
  id,
  name,
  methods: [method],
  permission: "explicit",
});

export const workflows: readonly Workflow[] = [
  {
    identity: explicit(
      "sqlite-relocation",
      "Relocate SQLite history storage",
      21,
    ),
    build(value) {
      const input = new WorkflowInput("sqlite-relocation", value);
      const selection = {
        source: input.path("source"),
        destination: input.path("destination"),
        envFile: input.path("envFile"),
      };
      return new SqliteRelocationCleanup(
        this.identity,
        selection,
        // The destination volume is owned for this run only.
        new PathPolicy(
          [...policy.ownedRoots, dirname(selection.destination)],
          policy.protectedPaths,
        ),
      );
    },
  },
  {
    identity: explicit("airbyte", "Abandoned Airbyte local stack", 22),
    build(value, env) {
      const input = new WorkflowInput("airbyte", value);
      return new AirbyteRemovalCleanup(
        this.identity,
        {
          containerIds: input.texts("containerIds"),
          volumeNames: input.texts("volumeNames"),
        },
        env,
      );
    },
  },
  {
    identity: explicit(
      "docker-offload",
      "Use a verified remote Docker engine",
      23,
    ),
    build(value, env) {
      const input = new WorkflowInput("docker-offload", value);
      return new DockerOffloadCleanup(
        this.identity,
        input.text("destination"),
        env,
      );
    },
  },
  {
    identity: explicit(
      "duplicate-references",
      "Verified duplicate analysis reference files",
      24,
    ),
    build(value) {
      const input = new WorkflowInput("duplicate-references", value);
      return new DuplicateReferencesCleanup(
        this.identity,
        input.list("groups", (group) => ({
          original: group.path("original"),
          copies: group.path("copies"),
          olderThanDays: group.count("olderThanDays"),
        })),
        policy,
      );
    },
  },
];
