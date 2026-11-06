import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { glob, lstat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { identity, sameIdentity } from "../../src/paths/identity.ts";
import { PathPolicy } from "../../src/paths/policy.ts";
import { removeAction } from "../../src/paths/remove.ts";
import { exists, within } from "../../src/paths/within.ts";
import { Ineligible } from "../../src/run/action.ts";
import { type Context } from "../../src/run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../src/run/task.ts";

export interface DuplicateGroup {
  original: string;
  copies: string;
  olderThanDays: number;
}

async function hash(
  path: string,
  compressed: boolean,
  signal: AbortSignal,
): Promise<string> {
  const digest = createHash("sha256");
  const input = createReadStream(path);
  const consume = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) digest.update(chunk);
  };
  if (compressed) await pipeline(input, createGunzip(), consume, { signal });
  else await pipeline(input, consume, { signal });
  return digest.digest("hex");
}

/** Content equality against a retained gzip original, never filename-only deduplication. */
export class DuplicateReferencesCleanup extends CleanupTask {
  readonly groups: readonly DuplicateGroup[];
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    groups: readonly DuplicateGroup[],
    policy: PathPolicy,
  ) {
    super(identity);
    this.groups = groups;
    this.policy = policy;
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = {
      actions: [],
      notes: [],
      configured: true,
    };
    for (const group of this.groups) {
      if (!(await exists(group.original))) {
        result.notes.push(`Retained original absent: ${group.original}`);
        continue;
      }
      await this.policy.validate(group.original);
      const originalIdentity = await identity(group.original);
      const expected = await hash(group.original, true, context.signal);
      for await (const copy of glob(group.copies)) {
        const guard = async (ctx: Context) => {
          if (within(copy, group.original))
            throw new Ineligible("Copy contains retained original");
          if (!(await lstat(copy)).isFile())
            throw new Ineligible("Duplicate target is not a regular file");
          if (
            (await lstat(copy)).mtimeMs >
            Date.now() - group.olderThanDays * 86400_000
          )
            throw new Ineligible("Recent duplicate");
          await this.policy.validate(group.original);
          if (!sameIdentity(originalIdentity, await identity(group.original)))
            throw new Ineligible("Retained original changed");
          const before = await identity(copy);
          if ((await hash(copy, false, ctx.signal)) !== expected)
            throw new Ineligible(`Content differs: ${copy}`);
          if (!sameIdentity(before, await identity(copy)))
            throw new Ineligible("Copy changed during hashing");
        };
        try {
          result.actions.push(
            await removeAction(
              copy,
              `SHA-256 matches decompressed retained original ${group.original}`,
              this.policy,
              guard,
              context,
            ),
          );
        } catch (error) {
          if (!(error instanceof Ineligible)) throw error;
          result.notes.push(error.message);
        }
      }
    }
    return result;
  }
}
