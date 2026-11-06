import { DatabaseSync, backup } from "node:sqlite";
import {
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  open,
  realpath,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import {
  type Identity,
  identity,
  sameIdentity,
} from "../../src/paths/identity.ts";
import { PathPolicy } from "../../src/paths/policy.ts";
import { allocatedBytes } from "../../src/paths/remove.ts";
import { exists } from "../../src/paths/within.ts";
import { CleanupAction, Ineligible } from "../../src/run/action.ts";
import { type Context } from "../../src/run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../src/run/task.ts";

export interface SqliteRelocation {
  source: string;
  destination: string;
  envFile: string;
}

/** Native SQLite backup owns consistency; the action owns path/config coordination. */
export class SqliteRelocationAction extends CleanupAction {
  readonly selection: SqliteRelocation;
  readonly policy: PathPolicy;
  readonly observed: Identity;
  readonly envContents: string;
  constructor(
    selection: SqliteRelocation,
    policy: PathPolicy,
    observed: Identity,
    envContents: string,
    bytes: number,
  ) {
    super({
      target: `${selection.source} -> ${selection.destination}`,
      estimatedBytes: bytes,
      reason:
        "Move the configured SQLite history database and update SQLITE_HISTORY_PATH",
    });
    this.selection = selection;
    this.policy = policy;
    this.observed = observed;
    this.envContents = envContents;
  }
  protected async check(ctx: Context) {
    const { source, destination, envFile } = this.selection;
    await this.policy.validate(source);
    await this.policy.validate(envFile);
    await this.policy.validateNew(destination);
    if (
      (await realpath(dirname(source))) ===
      (await realpath(dirname(destination)))
    )
      throw new Ineligible("Choose a separate destination directory");
    if ((await exists(`${source}-wal`)) || (await exists(`${source}-shm`)))
      throw new Ineligible(
        "Checkpoint and stop the SQLite application before relocation",
      );
    await this.policy.assertUnused(source, ctx);
    await this.policy.assertUnused(envFile, ctx);
    if (!sameIdentity(this.observed, await identity(source)))
      throw new Ineligible("Source changed since inspection");
    if ((await readFile(envFile, "utf8")) !== this.envContents)
      throw new Ineligible("Environment file changed since inspection");
    if (
      parseEnv(this.envContents).SQLITE_HISTORY_PATH !== source ||
      [
        ...this.envContents.matchAll(
          /^\s*(?:export\s+)?SQLITE_HISTORY_PATH\s*=/gm,
        ),
      ].length !== 1
    )
      throw new Ineligible(
        "Expected one exact SQLITE_HISTORY_PATH assignment to the source",
      );
    if ([source, destination, envFile].some((path) => /[\r\n\0]/.test(path)))
      throw new Ineligible("Unsupported control characters in a path");
  }
  protected async perform(ctx: Context) {
    const { source, destination, envFile } = this.selection;
    // Exclusive creation prevents overwriting an existing destination.
    const handle = await open(destination, "wx", 0o600);
    await handle.close();
    const created = await identity(destination);
    let installed = false;
    try {
      const database = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(database, destination);
      } finally {
        database.close();
      }
      ctx.signal.throwIfAborted();
      this.assertIntegrity(destination);
      if (
        !sameIdentity(this.observed, await identity(source)) ||
        (await exists(`${source}-wal`)) ||
        (await exists(`${source}-shm`))
      )
        throw new Ineligible("Source changed during backup; retained source");
      if ((await readFile(envFile, "utf8")) !== this.envContents)
        throw new Ineligible(
          "Environment changed during backup; retained source",
        );
      await this.policy.assertUnused(source, ctx);
      const next = this.envContents.replace(
        /^(\s*(?:export\s+)?SQLITE_HISTORY_PATH\s*=).*$/m,
        (_line, prefix: string) => `${prefix}${JSON.stringify(destination)}`,
      );
      if (parseEnv(next).SQLITE_HISTORY_PATH !== destination)
        throw new Error(
          "Destination cannot be represented in this environment file",
        );
      const temporary = `${envFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, next, {
          flag: "wx",
          mode: (await lstat(envFile)).mode & 0o777,
        });
        await rename(temporary, envFile);
        installed = true;
      } finally {
        if (await exists(temporary)) await rm(temporary);
      }
      // New config and verified backup are installed before the original is removed.
      await rm(source);
    } catch (error) {
      if (!installed && (await exists(destination))) {
        const current = await identity(destination);
        if (created.dev === current.dev && created.ino === current.ino)
          await rm(destination);
      }
      throw error;
    }
  }
  private assertIntegrity(path: string) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = database.prepare("PRAGMA quick_check").all();
      if (rows.length !== 1 || rows[0].quick_check !== "ok")
        throw new Error("SQLite integrity check failed");
    } finally {
      database.close();
    }
  }
  protected async verify() {
    const { source, destination, envFile } = this.selection;
    this.assertIntegrity(destination);
    if (
      (await exists(source)) ||
      parseEnv(await readFile(envFile, "utf8")).SQLITE_HISTORY_PATH !==
        destination
    )
      throw new Error("SQLite relocation postcondition failed");
  }
}

export class SqliteRelocationCleanup extends CleanupTask {
  readonly selection: SqliteRelocation;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    selection: SqliteRelocation,
    policy: PathPolicy,
  ) {
    super(identity);
    this.selection = selection;
    this.policy = policy;
  }
  protected async discover(ctx: Context): Promise<Discovery> {
    const selection = this.selection;
    await this.policy.validate(selection.source);
    const action = new SqliteRelocationAction(
      selection,
      this.policy,
      await identity(selection.source),
      await readFile(selection.envFile, "utf8"),
      await allocatedBytes(selection.source, ctx),
    );
    return {
      configured: true,
      actions: [action],
      notes: [
        "Live guards run immediately before mutation. A move within the same filesystem reclaims no filesystem space. Use a mounted external volume to offload storage.",
      ],
    };
  }
}
