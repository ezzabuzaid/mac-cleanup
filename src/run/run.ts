import { statfs } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openFilesCommand } from "../paths/policy.ts";
import { within } from "../paths/within.ts";
import { type ActionView, Ineligible } from "./action.ts";
import { type Context, type Mode } from "./context.ts";
import { SnapshotHost } from "./host.ts";
import { CleanupTask, type TaskIdentity, type TaskPlan } from "./task.ts";

export interface ItemReport extends ActionView {
  task: string;
  /** planned: not executed (preview, or never started because the run was interrupted). */
  status: "planned" | "completed" | "skipped" | "failed" | "interrupted";
  detail: string;
}

export interface RunReport {
  mode: Mode;
  /** The abort reason when a signal stopped the run; tasks after that point did not run. */
  interrupted: string | null;
  startedAt: string;
  finishedAt: string;
  freeBytesBefore: number;
  freeBytesAfter: number;
  freeSpaceChangeBytes: number;
  tasks: (TaskIdentity & {
    configured: boolean;
    notes: string[];
    error: string | null;
    candidates: number;
  })[];
  items: ItemReport[];
}

/** Composite: run independent tasks in order; failures remain visible per task/action. */
export class CleanupRun {
  readonly tasks: readonly CleanupTask[];
  readonly volume: string;
  constructor(tasks: readonly CleanupTask[], volume: string) {
    const ids = tasks.map((task) => task.identity.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate task IDs");
    this.tasks = tasks;
    this.volume = volume;
  }
  async run(
    context: Context,
    progress: (message: string) => void,
  ): Promise<RunReport> {
    const startedAt = new Date().toISOString();
    const before = await statfs(this.volume);
    const report: RunReport = {
      mode: context.mode,
      interrupted: null,
      startedAt,
      finishedAt: startedAt,
      freeBytesBefore: before.bavail * before.bsize,
      freeBytesAfter: 0,
      freeSpaceChangeBytes: 0,
      tasks: [],
      items: [],
    };
    // A guard runs per candidate, also in inspection, and lsof takes most of a second. Inspection
    // only plans, so it shares one answer. An action gets `context`, so each check there reads again.
    const inspection: Context = {
      ...context,
      host: new SnapshotHost(context.host, openFilesCommand),
    };
    for (const task of this.tasks) {
      if (context.signal.aborted) break;
      progress(`Inspecting ${task.identity.id}`);
      let plan: TaskPlan;
      try {
        plan = await task.inspect(inspection);
      } catch (error) {
        // inspect rethrows the abort reason; any other error escaping it is a defect.
        if (context.signal.aborted) break;
        throw error;
      }
      report.tasks.push({
        ...task.identity,
        configured: plan.configured,
        notes: plan.notes,
        error: plan.error,
        candidates: plan.actions.length,
      });
      for (const action of plan.actions) {
        const item: ItemReport = {
          ...action.view,
          task: plan.id,
          status: "planned",
          detail: "",
        };
        const kept = context.kept.find(
          (path) =>
            isAbsolute(action.view.target) && within(path, action.view.target),
        );
        if (context.mode === "apply" && !context.signal.aborted) {
          if (kept !== undefined) {
            item.status = "skipped";
            item.detail = `Kept by --keep ${kept}`;
          } else {
            try {
              await action.execute(context, task.identity);
              item.status = "completed";
            } catch (error) {
              if (context.signal.aborted) {
                // The target can be partly changed; the user must check it.
                item.status = "interrupted";
                item.detail = CleanupRun.#reason(context.signal);
              } else {
                item.status =
                  error instanceof Ineligible ? "skipped" : "failed";
                item.detail = String(error);
              }
            }
          }
        }
        report.items.push(item);
      }
    }
    if (context.signal.aborted)
      report.interrupted = CleanupRun.#reason(context.signal);
    const after = await statfs(this.volume);
    report.freeBytesAfter = after.bavail * after.bsize;
    report.freeSpaceChangeBytes =
      report.freeBytesAfter - report.freeBytesBefore;
    report.finishedAt = new Date().toISOString();
    return report;
  }
  static #reason(signal: AbortSignal): string {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? reason.message : String(reason);
  }
}
