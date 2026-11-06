import { CleanupAction } from "./action.ts";
import { type Context } from "./context.ts";

export interface TaskIdentity {
  id: string;
  name: string;
  permission: "routine" | "explicit";
  methods: number[];
}

export interface Discovery {
  actions: CleanupAction[];
  notes: string[];
  configured: boolean;
}

export interface TaskPlan extends TaskIdentity, Discovery {
  error: string | null;
}

/** Template Method: common inspection lifecycle, with domain discovery supplied below. */
export abstract class CleanupTask {
  readonly identity: TaskIdentity;
  constructor(identity: TaskIdentity) {
    this.identity = identity;
  }
  async inspect(context: Context): Promise<TaskPlan> {
    context.signal.throwIfAborted();
    try {
      return {
        ...this.identity,
        ...(await this.discover(context)),
        error: null,
      };
    } catch (error) {
      context.signal.throwIfAborted();
      // A tool that is not installed is a fact about this machine, not a failure.
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        "syscall" in error &&
        typeof error.syscall === "string" &&
        error.syscall.startsWith("spawn ")
      )
        return {
          ...this.identity,
          actions: [],
          notes: [`${error.syscall.slice("spawn ".length)} is not installed`],
          configured: false,
          error: null,
        };
      return {
        ...this.identity,
        actions: [],
        notes: [],
        configured: true,
        error: String(error),
      };
    }
  }
  protected abstract discover(context: Context): Promise<Discovery>;
}
