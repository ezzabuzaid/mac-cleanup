import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MachineInventory } from "../../machine/inventory.ts";

import { PathPolicy } from "../../paths/policy.ts";
import { removeAction } from "../../paths/remove.ts";
import { exists } from "../../paths/within.ts";
import { Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";
import {
  CleanupTask,
  type Discovery,
  type TaskIdentity,
} from "../../run/task.ts";

interface Agent {
  Label?: unknown;
  Program?: unknown;
  ProgramArguments?: unknown;
}

/** Per-user LaunchAgents whose program is gone, or that name no program at all. */
export class LaunchAgentsCleanup extends CleanupTask {
  readonly directory: string;
  readonly inventory: MachineInventory;
  readonly policy: PathPolicy;
  readonly uid: number;
  constructor(
    identity: TaskIdentity,
    directory: string,
    uid: number,
    inventory: MachineInventory,
    policy: PathPolicy,
  ) {
    super(identity);
    this.directory = directory;
    this.uid = uid;
    this.inventory = inventory;
    this.policy = policy;
  }
  private async program(agent: Agent): Promise<string | null> {
    const program =
      typeof agent.Program === "string"
        ? agent.Program
        : Array.isArray(agent.ProgramArguments) &&
            typeof agent.ProgramArguments[0] === "string"
          ? agent.ProgramArguments[0]
          : null;
    if (program === null) return "names no program";
    if (isAbsolute(program))
      return (await exists(program)) ? null : `program missing: ${program}`;
    return (await this.inventory.commands()).has(program)
      ? null
      : `program not on PATH: ${program}`;
  }
  /** launchctl exits 113 when the service is not loaded. */
  private async assertNotLoaded(label: string, context: Context) {
    const service = `gui/${this.uid}/${label}`;
    try {
      await context.host.run(
        { file: "launchctl", args: ["print", service] },
        context.signal,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 113)
        return;
      throw error;
    }
    throw new Ineligible(`Loaded; run: launchctl bootout ${service}`);
  }
  protected async discover(context: Context): Promise<Discovery> {
    const result: Discovery = { actions: [], notes: [], configured: true };
    if (!(await exists(this.directory))) return result;
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".plist")) continue;
      const path = join(this.directory, name);
      let agent: Agent;
      try {
        agent = JSON.parse(
          await context.host.run(
            { file: "plutil", args: ["-convert", "json", "-o", "-", path] },
            context.signal,
          ),
        ) as Agent;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === 1))
          throw error;
        result.notes.push(`Unreadable plist: ${path}`);
        continue;
      }
      const reason = await this.program(agent);
      if (reason === null) continue;
      const label = typeof agent.Label === "string" ? agent.Label : null;
      try {
        result.actions.push(
          await removeAction(
            path,
            `LaunchAgent ${reason}`,
            this.policy,
            async (ctx) => {
              if (label !== null) await this.assertNotLoaded(label, ctx);
              if ((await this.program(agent)) === null)
                throw new Ineligible(`Program is back: ${path}`);
            },
            context,
          ),
        );
      } catch (error) {
        if (!(error instanceof Ineligible)) throw error;
        result.notes.push(error.message);
      }
    }
    return result;
  }
}
