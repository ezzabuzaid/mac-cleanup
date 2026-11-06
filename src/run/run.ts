import { statfs } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { within } from "../paths/within.ts";
import { type ActionView, Ineligible } from "./action.ts";
import { type Context, type Mode } from "./context.ts";
import { CleanupTask, type TaskIdentity } from "./task.ts";

export interface ItemReport extends ActionView {
  task: string;
  status: "planned" | "completed" | "skipped" | "failed";
  detail: string;
}

export interface RunReport {
  mode: Mode;
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
      startedAt,
      finishedAt: startedAt,
      freeBytesBefore: before.bavail * before.bsize,
      freeBytesAfter: 0,
      freeSpaceChangeBytes: 0,
      tasks: [],
      items: [],
    };
    for (const task of this.tasks) {
      progress(`Inspecting ${task.identity.id}`);
      const plan = await task.inspect(context);
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
        if (context.mode === "apply" && kept !== undefined) {
          item.status = "skipped";
          item.detail = `Kept by --keep ${kept}`;
        } else if (context.mode === "apply") {
          try {
            await action.execute(context, task.identity);
            item.status = "completed";
          } catch (error) {
            context.signal.throwIfAborted();
            item.status = error instanceof Ineligible ? "skipped" : "failed";
            item.detail = String(error);
          }
        }
        report.items.push(item);
      }
    }
    const after = await statfs(this.volume);
    report.freeBytesAfter = after.bavail * after.bsize;
    report.freeSpaceChangeBytes =
      report.freeBytesAfter - report.freeBytesBefore;
    report.finishedAt = new Date().toISOString();
    return report;
  }
}
