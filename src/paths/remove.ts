import { rm } from "node:fs/promises";
import { type Identity, identity, sameIdentity } from "./identity.ts";
import { PathPolicy } from "./policy.ts";
import { exists } from "./within.ts";
import { CleanupAction, type Guard, Ineligible } from "../run/action.ts";
import { type Context } from "../run/context.ts";

export async function allocatedBytes(
  path: string,
  context: Context,
): Promise<number> {
  const output = await context.host.run(
    { file: "du", args: ["-sk", path] },
    context.signal,
  );
  const match = /^(\d+)\s/.exec(output);
  if (!match) throw new Error(`Unrecognized du output for ${path}`);
  return Number(match[1]) * 1024;
}

/** The target itself is gone: a file-system call on it failed with ENOENT, or du could not find it. */
function vanished(error: unknown, path: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  if (error.code === "ENOENT") return "path" in error && error.path === path;
  return (
    error.code === 1 &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.includes(`du: ${path}: No such file or directory`)
  );
}

/** EAFP: a target that vanished between discovery and this step is already gone, not a failure. */
async function unlessVanished<T>(
  path: string,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (vanished(error, path))
      throw new Ineligible(`Already absent: ${path}`, { cause: error });
    throw error;
  }
}

export class RemovePathAction extends CleanupAction {
  readonly path: string;
  readonly policy: PathPolicy;
  readonly observed: Identity;
  readonly guard: Guard;
  constructor(
    path: string,
    reason: string,
    bytes: number,
    policy: PathPolicy,
    observed: Identity,
    guard: Guard,
  ) {
    super({ target: path, reason, estimatedBytes: bytes });
    this.path = path;
    this.policy = policy;
    this.observed = observed;
    this.guard = guard;
  }
  protected check(context: Context) {
    return unlessVanished(this.path, async () => {
      await this.policy.validate(this.path);
      await this.policy.assertUnused(this.path, context);
      await this.guard(context);
      if (!sameIdentity(this.observed, await identity(this.path)))
        throw new Ineligible(`Changed since inspection: ${this.path}`);
    });
  }
  protected perform() {
    return unlessVanished(this.path, () => rm(this.path, { recursive: true }));
  }
  protected async verify() {
    if (await exists(this.path))
      throw new Error(`Path remains after removal: ${this.path}`);
  }
}

export async function removeAction(
  path: string,
  reason: string,
  policy: PathPolicy,
  guard: Guard,
  context: Context,
): Promise<RemovePathAction> {
  return unlessVanished(path, async () => {
    await policy.validate(path);
    await guard(context);
    return new RemovePathAction(
      path,
      reason,
      await allocatedBytes(path, context),
      policy,
      await identity(path),
      guard,
    );
  });
}
