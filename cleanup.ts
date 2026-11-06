import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { cleanup } from "./profile.ts";
import { LocalHost } from "./src/run/host.ts";
import { CleanupRun, type RunReport } from "./src/run/run.ts";
import { workflows } from "./workflows/index.ts";

const { values } = parseArgs({
  options: {
    preview: { type: "boolean" },
    apply: { type: "boolean" },
    only: { type: "string" },
    allow: { type: "string" },
    keep: { type: "string" },
    select: { type: "string" },
    workflow: { type: "string" },
    input: { type: "string" },
    report: { type: "string" },
    list: { type: "boolean" },
    help: { type: "boolean" },
    details: { type: "boolean" },
  },
});

if (values.help) {
  console.log(`node cleanup.ts [--preview | --apply] [--only id,id] [--allow id,id] [--keep /abs/path,...] [--select /abs/path,...] [--report path.json]
node cleanup.ts --workflow <name> --input <file.json> [--preview | --apply] [--allow <name>] [--report path.json]
node cleanup.ts --list

Preview is the default. --apply executes routine tasks; explicit tasks also require --allow.
--only restricts discovery and execution. --allow never implies --apply.
--keep skips every target inside the given absolute paths for this run.
--select confirms paths for tasks that only propose (orphaned-app-data).
--workflow runs one opt-in workflow; its targets come from your JSON input file.
Every task learns its targets from this machine. No shell commands are evaluated.`);
} else if (values.list) {
  console.table(cleanup.tasks.map((task) => task.identity));
  console.table(workflows.map((workflow) => workflow.identity));
} else {
  if (values.apply && values.preview)
    throw new Error("Choose either --preview or --apply");
  if (
    values.workflow !== undefined &&
    (values.only !== undefined || values.select !== undefined)
  )
    throw new Error("--workflow cannot be combined with --only or --select");
  const workflow =
    values.workflow === undefined
      ? undefined
      : workflows.find((item) => item.identity.id === values.workflow);
  if (values.workflow !== undefined && workflow === undefined)
    throw new Error(`Unknown workflow: ${values.workflow}`);
  if (workflow !== undefined && values.input === undefined)
    throw new Error("--workflow needs --input <file.json>");
  const ids = new Set(
    workflow === undefined
      ? cleanup.tasks.map((task) => task.identity.id)
      : [workflow.identity.id],
  );
  const only =
    values.only === undefined ? ids : new Set(values.only.split(","));
  const allowed = new Set(
    values.allow === undefined ? [] : values.allow.split(","),
  );
  for (const id of [...only, ...allowed])
    if (!ids.has(id)) throw new Error(`Unknown task: ${id}`);
  const paths = (flag: "keep" | "select") => {
    const value = values[flag];
    const list = value === undefined ? [] : value.split(",");
    for (const path of list)
      if (!isAbsolute(path))
        throw new Error(`--${flag} needs absolute paths: ${path}`);
    return list;
  };
  const kept = paths("keep");
  const selected = paths("select");
  const tasks =
    workflow === undefined || values.input === undefined
      ? cleanup.tasks.filter((task) => only.has(task.identity.id))
      : [
          workflow.build(
            JSON.parse(await readFile(values.input, "utf8")),
            process.env,
          ),
        ];
  // Exclusive creation before any task runs: a report never overwrites a user file, and a
  // path that cannot be created fails before anything is removed.
  const output =
    values.report === undefined ? undefined : await open(values.report, "wx");
  const controller = new AbortController();
  // once: the second signal gets Node's default handling and stops the process at once.
  const interrupt = (signal: NodeJS.Signals) => {
    process.exitCode = 128 + constants.signals[signal];
    controller.abort(new Error(`Interrupted by ${signal}`));
    console.error(
      `Interrupted by ${signal}: stopping after the current step. A second ${signal} stops at once.`,
    );
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const run = new CleanupRun(tasks, cleanup.volume);
    const report = await run.run(
      {
        mode: values.apply ? "apply" : "preview",
        host: new LocalHost(60_000),
        signal: controller.signal,
        allowed,
        kept,
        selected,
      },
      (message) => console.error(message),
    );
    printReport(report, values.details === true);
    if (output !== undefined) {
      await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
      console.log(`Report: ${values.report}`);
    }
    if (
      report.interrupted === null &&
      (report.tasks.some((task) => task.error !== null) ||
        report.items.some((item) => item.status === "failed"))
    )
      process.exitCode = 1;
  } finally {
    await output?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

function printReport(report: RunReport, details: boolean) {
  console.log(
    `\n${report.mode.toUpperCase()}${report.interrupted === null ? "" : ` (${report.interrupted})`}: ${report.items.length} actions across ${report.tasks.length} tasks`,
  );
  console.table(
    report.tasks.map((task) => ({
      id: task.id,
      candidates: task.candidates,
      permission: task.permission,
      status:
        task.error !== null
          ? "error"
          : !task.configured
            ? "unconfigured"
            : "inspected",
    })),
  );
  for (const task of report.tasks) {
    if (task.error !== null) console.error(`${task.id}: ${task.error}`);
    if (!task.configured) console.log(`${task.id}: ${task.notes.join(" ")}`);
  }
  for (const item of report.items) {
    if (
      !details &&
      item.status !== "failed" &&
      item.status !== "skipped" &&
      item.status !== "interrupted"
    )
      continue;
    const size =
      item.estimatedBytes === null
        ? "size unknown"
        : `${(item.estimatedBytes / 1024 ** 3).toFixed(2)} GiB estimated`;
    console.log(
      `[${item.status}] ${item.task}: ${item.target} (${size})${item.detail === "" ? "" : ` — ${item.detail}`}`,
    );
  }
  if (!details)
    console.log(
      "Use --details to print every target; the JSON report always contains all targets.",
    );
  console.log(
    report.mode === "preview"
      ? "Preview only. No cleanup actions executed. Estimates overlap and do not account for APFS clones or shared Docker layers."
      : `Observed filesystem free-space change: ${(report.freeSpaceChangeBytes / 1024 ** 3).toFixed(2)} GiB; concurrent processes can affect this value.`,
  );
}
