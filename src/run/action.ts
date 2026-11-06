import { type Context } from "./context.ts";
import { type Command } from "./host.ts";
import { type TaskIdentity } from "./task.ts";

export class Ineligible extends Error {}

export interface ActionView {
  target: string;
  reason: string;
  estimatedBytes: number | null;
}

/** Template Method: subclasses cannot omit the preview/authorization boundary. */
export abstract class CleanupAction {
  readonly view: ActionView;
  constructor(view: ActionView) {
    this.view = view;
  }
  async execute(context: Context, task: TaskIdentity): Promise<void> {
    if (context.mode !== "apply")
      throw new Error("Mutation is forbidden in preview");
    if (task.permission === "explicit" && !context.allowed.has(task.id)) {
      throw new Ineligible(`Requires --allow ${task.id}`);
    }
    context.signal.throwIfAborted();
    await this.check(context);
    context.signal.throwIfAborted();
    await this.perform(context);
    await this.verify(context);
  }
  protected abstract check(context: Context): Promise<void>;
  protected abstract perform(context: Context): Promise<void>;
  protected abstract verify(context: Context): Promise<void>;
}

export type Guard = (context: Context) => Promise<void>;

/** Composition: a native command plus its domain-specific guards and postcondition. */
export class CommandAction extends CleanupAction {
  readonly command: Command;
  readonly guard: Guard;
  readonly postcondition: Guard;
  constructor(
    view: ActionView,
    command: Command,
    guard: Guard,
    postcondition: Guard,
  ) {
    super(view);
    this.command = command;
    this.guard = guard;
    this.postcondition = postcondition;
  }
  protected check(context: Context) {
    return this.guard(context);
  }
  protected async perform(context: Context) {
    await context.host.run(this.command, context.signal);
  }
  protected verify(context: Context) {
    return this.postcondition(context);
  }
}
