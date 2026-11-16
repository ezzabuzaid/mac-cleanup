import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type AgentJob, type Launchd, type Service } from "@zukhruf/launchd";
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
  readonly launchd: Launchd<AgentJob>;
  readonly inventory: MachineInventory;
  readonly policy: PathPolicy;
  constructor(
    identity: TaskIdentity,
    directory: string,
    launchd: Launchd<AgentJob>,
    inventory: MachineInventory,
    policy: PathPolicy,
  ) {
    super(identity);
    this.directory = directory;
    this.launchd = launchd;
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
  /**
   * A loaded service keeps its job file; the bootout stays a suggestion. A label that is not one
   * file name keeps its plist alone; any failed read fails the task closed.
   */
  private async assertNotLoaded(label: string, path: string, context: Context) {
    let service: Service;
    try {
      service = this.launchd.service(label);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new Ineligible(
        `Kept ${path}: its label ${JSON.stringify(label)} is not one file name, so launchd's state cannot be read`,
      );
    }
    const { state } = await service.state({ signal: context.signal });
    if (state !== "not loaded")
      throw new Ineligible(`Loaded; run: launchctl bootout ${service.target}`);
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
              if (label !== null) await this.assertNotLoaded(label, path, ctx);
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
