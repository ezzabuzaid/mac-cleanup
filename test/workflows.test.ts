import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { Command, Host } from "../src/run/host.ts";
import type { Context } from "../src/run/context.ts";
import { exists } from "../src/paths/within.ts";
import { CleanupRun } from "../src/run/run.ts";
import { workflows } from "../workflows/index.ts";

function workflow(id: string) {
  const found = workflows.find((item) => item.identity.id === id);
  if (found === undefined) throw new Error(`No workflow ${id}`);
  return found;
}

function context(
  host: Host,
  mode: "preview" | "apply",
  allowed: string[],
): Context {
  return {
    host,
    mode,
    allowed: new Set(allowed),
    kept: [],
    selected: [],
    signal: new AbortController().signal,
  };
}

/** Answers only what the test expects; du and an empty lsof are the defaults. */
function fake(handler: (command: Command) => string | undefined) {
  const calls: Command[] = [];
  const host: Host = {
    async run(command) {
      calls.push(command);
      const result = handler(command);
      if (result !== undefined) return result;
      if (command.file === "du") return `4\t${command.args.at(-1)}\n`;
      if (command.file === "lsof") return "";
      throw new Error(
        `Unexpected command: ${command.file} ${command.args.join(" ")}`,
      );
    },
  };
  return { host, calls };
}

/**
 * The profile's policy owns the temp folder as the OS names it (/var/folders/…), so the
 * fixture keeps that form; the policy itself resolves symlinks when it validates a path.
 */
async function temporary() {
  return mkdtemp(join(tmpdir(), "disk-cleanup-workflow-"));
}

async function old(path: string) {
  const date = new Date(Date.now() - 30 * 86400_000);
  await utimes(path, date, date);
}

test("duplicate references require equal contents and preserve the compressed original", async () => {
  const root = await temporary();
  try {
    const original = join(root, "original.gtf.gz");
    await writeFile(original, gzipSync("same content"));
    const equal = join(root, "equal.gtf");
    await writeFile(equal, "same content");
    await old(equal);
    const different = join(root, "different.gtf");
    await writeFile(different, "different");
    await old(different);
    // Equal content, but newer than the 7-day threshold.
    const recent = join(root, "recent.gtf");
    await writeFile(recent, "same content");
    const { host } = fake(() => undefined);
    const duplicates = workflow("duplicate-references");
    const task = duplicates.build(
      { groups: [{ original, copies: join(root, "*.gtf"), olderThanDays: 7 }] },
      {},
    );
    const plan = await task.inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    assert.equal(plan.actions.length, 1);
    await plan.actions[0].execute(
      context(host, "apply", ["duplicate-references"]),
      duplicates.identity,
    );
    assert.equal(await exists(equal), false);
    assert.equal(await exists(original), true);
    assert.equal(await exists(different), true);
    assert.equal(await exists(recent), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite relocation copies rows and updates only the selected setting", async () => {
  const root = await temporary();
  try {
    const source = join(root, "history.sqlite"),
      envFile = join(root, ".env"),
      destination = join(root, "external", "history$&.sqlite");
    await mkdir(join(root, "external"));
    const db = new DatabaseSync(source);
    db.exec(
      "CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('preserve');",
    );
    db.close();
    await writeFile(envFile, `OTHER=keep\nSQLITE_HISTORY_PATH=${source}\n`);
    const { host } = fake(() => undefined);
    const relocation = workflow("sqlite-relocation");
    const task = relocation.build({ source, destination, envFile }, {});
    const preview = await task.inspect(context(host, "preview", []));
    assert.equal(await exists(destination), false);
    await preview.actions[0].execute(
      context(host, "apply", ["sqlite-relocation"]),
      relocation.identity,
    );
    assert.equal(await exists(source), false);
    const relocated = new DatabaseSync(destination);
    try {
      assert.equal(
        relocated.prepare("SELECT text FROM messages").get()!.text,
        "preserve",
      );
    } finally {
      relocated.close();
    }
    assert.equal(
      await readFile(envFile, "utf8"),
      `OTHER=keep\nSQLITE_HISTORY_PATH=${JSON.stringify(destination)}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite refuses active WAL, existing destinations, and changed config without removing source", async () => {
  const root = await temporary();
  try {
    const source = join(root, "history.sqlite"),
      envFile = join(root, ".env"),
      destination = join(root, "external/history.sqlite");
    await mkdir(join(root, "external"));
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE x (n)");
    db.close();
    await writeFile(envFile, `SQLITE_HISTORY_PATH=${source}\n`);
    const { host } = fake(() => undefined);
    const relocation = workflow("sqlite-relocation");
    const plan = await relocation
      .build({ source, destination, envFile }, {})
      .inspect(context(host, "preview", []));
    const action = plan.actions[0];
    const ctx = context(host, "apply", ["sqlite-relocation"]);
    await writeFile(`${source}-wal`, "active");
    await assert.rejects(
      action.execute(ctx, relocation.identity),
      /Checkpoint/,
    );
    await rm(`${source}-wal`);
    await writeFile(destination, "keep");
    await assert.rejects(
      action.execute(ctx, relocation.identity),
      /already exists/,
    );
    assert.equal(await readFile(destination, "utf8"), "keep");
    await rm(destination);
    await writeFile(envFile, "SQLITE_HISTORY_PATH=changed\n");
    await assert.rejects(
      action.execute(ctx, relocation.identity),
      /Environment file changed/,
    );
    assert.equal(await exists(source), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow input that is missing or wrong is refused and names the field", () => {
  for (const [id, input, message] of [
    [
      "sqlite-relocation",
      null,
      /sqlite-relocation: the input must be a JSON object/,
    ],
    [
      "sqlite-relocation",
      {
        source: "relative.sqlite",
        destination: "/d/h.sqlite",
        envFile: "/e/.env",
      },
      /sqlite-relocation: "source" must be an absolute path/,
    ],
    [
      "airbyte",
      { containerIds: [], volumeNames: ["data"] },
      /airbyte: "containerIds" must be a non-empty list of strings/,
    ],
    [
      "docker-offload",
      {},
      /docker-offload: "destination" must be a non-empty string/,
    ],
    [
      "docker-offload",
      { destination: "" },
      /docker-offload: "destination" must be a non-empty string/,
    ],
    [
      "duplicate-references",
      { groups: [{ original: "/a.gz", copies: "/b/*", olderThanDays: -1 }] },
      /duplicate-references\.groups\[0\]: "olderThanDays" must be a whole number/,
    ],
  ] as const)
    assert.throws(() => workflow(id).build(input, {}), message);
});

test("remote context preview validates destination but never changes context", async () => {
  const { host, calls } = fake((command) =>
    command.args.includes("inspect")
      ? JSON.stringify([{ Endpoints: { docker: { Host: "ssh://fixture" } } }])
      : command.args.includes("info")
        ? "remote-daemon"
        : undefined,
  );
  const plan = await workflow("docker-offload")
    .build({ destination: "remote" }, {})
    .inspect(context(host, "preview", []));
  assert.equal(plan.error, null);
  assert.equal(plan.actions[0].view.estimatedBytes, 0);
  assert.ok(calls.some((c) => c.args.join(" ") === "context inspect remote"));
  assert.ok(
    calls.some(
      (c) => c.args.join(" ") === "--context remote info --format {{.ID}}",
    ),
  );
  assert.equal(
    calls.some((c) => c.args.includes("use")),
    false,
  );
});

test("the CLI refuses --workflow with --only or --select before it inspects anything", () => {
  // The suite runs from dist/test; the CLI is the TypeScript entry at the repo root.
  const cli = join(import.meta.dirname, "../../cleanup.ts");
  for (const extra of [
    ["--only", "npm"],
    ["--select", "/abs/folder"],
  ]) {
    const run = spawnSync(
      process.execPath,
      [cli, "--workflow", "airbyte", ...extra],
      { encoding: "utf8" },
    );
    assert.notEqual(run.status, 0, extra[0]);
    assert.match(
      run.stderr,
      /--workflow cannot be combined with --only or --select/,
      extra[0],
    );
    assert.doesNotMatch(run.stderr, /Inspecting/);
  }
});

test("docker-offload refuses a destination that is not an SSH context", async () => {
  const { host, calls } = fake((command) =>
    command.args.includes("inspect")
      ? JSON.stringify([
          { Endpoints: { docker: { Host: "tcp://10.0.0.5:2376" } } },
        ])
      : undefined,
  );
  const plan = await workflow("docker-offload")
    .build({ destination: "plain-tcp" }, {})
    .inspect(context(host, "preview", []));
  assert.match(plan.error ?? "", /must be an existing SSH context/);
  assert.equal(plan.actions.length, 0);
  assert.equal(
    calls.some((c) => c.args.includes("use")),
    false,
  );
});

test("SQLite relocation keeps the source while a process has it open", async () => {
  const root = await temporary();
  try {
    const source = join(root, "history.sqlite"),
      envFile = join(root, ".env"),
      destination = join(root, "external/history.sqlite");
    await mkdir(join(root, "external"));
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE x (n)");
    db.close();
    await writeFile(envFile, `SQLITE_HISTORY_PATH=${source}\n`);
    const relocation = workflow("sqlite-relocation");
    const plan = await relocation
      .build({ source, destination, envFile }, {})
      .inspect(context(fake(() => undefined).host, "preview", []));
    // lsof reports canonical paths (/private/var/…).
    const canonical = await realpath(source);
    const { host } = fake((command) =>
      command.file === "lsof" ? `p7\nn${canonical}\n` : undefined,
    );
    await assert.rejects(
      plan.actions[0].execute(
        context(host, "apply", ["sqlite-relocation"]),
        relocation.identity,
      ),
      /Open files/,
    );
    assert.equal(await exists(source), true);
    assert.equal(await exists(destination), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite relocation rolls back when the source is opened after the copy", async () => {
  const root = await temporary();
  try {
    const source = join(root, "history.sqlite"),
      envFile = join(root, ".env"),
      destination = join(root, "external/history.sqlite");
    await mkdir(join(root, "external"));
    const db = new DatabaseSync(source);
    db.exec(
      "CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('keep');",
    );
    db.close();
    const env = `SQLITE_HISTORY_PATH=${source}\n`;
    await writeFile(envFile, env);
    const relocation = workflow("sqlite-relocation");
    const plan = await relocation
      .build({ source, destination, envFile }, {})
      .inspect(context(fake(() => undefined).host, "preview", []));
    const canonical = await realpath(source);
    // A process opens the source once the copy exists: lsof answers from that state.
    const { host } = fake((command) =>
      command.file === "lsof"
        ? existsSync(destination)
          ? `p7\nn${canonical}\n`
          : ""
        : undefined,
    );
    await assert.rejects(
      plan.actions[0].execute(
        context(host, "apply", ["sqlite-relocation"]),
        relocation.identity,
      ),
      /Open files/,
    );
    assert.equal(await exists(destination), false);
    assert.equal(await readFile(envFile, "utf8"), env);
    const kept = new DatabaseSync(source);
    try {
      assert.equal(
        kept.prepare("SELECT text FROM messages").get()!.text,
        "keep",
      );
    } finally {
      kept.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface Fleet {
  context: string[];
  containers: { Id: string; Image: string; State: { Running: boolean } }[];
  volumes: string[];
  uninstall: (fleet: Fleet) => void;
}

/** A local Docker engine and abctl, as their CLIs answer; uninstall changes the fleet. */
function airbyteHost(fleet: Fleet) {
  return fake((command) => {
    const args = command.args.join(" ");
    if (command.file === "abctl") {
      if (args === "local status") return "Airbyte is installed";
      if (args === "local uninstall --persisted") {
        fleet.uninstall(fleet);
        return "";
      }
      return undefined;
    }
    if (command.file !== "docker") return undefined;
    if (args === "context show") return `${fleet.context.shift() ?? "local"}\n`;
    if (args === "--context local context inspect local")
      return JSON.stringify([
        { Endpoints: { docker: { Host: "unix:///fixture.sock" } } },
      ]);
    if (args === "--context local container ls --all --quiet --no-trunc")
      return fleet.containers.map((c) => c.Id).join("\n");
    if (args.startsWith("--context local container inspect "))
      return JSON.stringify(
        fleet.containers.filter((c) => command.args.slice(4).includes(c.Id)),
      );
    if (args === "--context local volume ls --quiet")
      return fleet.volumes.join("\n");
    return undefined;
  });
}

function fleet(overrides: Partial<Fleet> = {}): Fleet {
  return {
    context: [],
    containers: [
      { Id: "airbyte-db", Image: "airbyte/db", State: { Running: false } },
      { Id: "keep", Image: "postgres", State: { Running: true } },
    ],
    volumes: ["airbyte-data", "keep-data"],
    uninstall: (f) => {
      f.containers = f.containers.filter((c) => c.Id !== "airbyte-db");
      f.volumes = f.volumes.filter((v) => v !== "airbyte-data");
    },
    ...overrides,
  };
}

const airbyteInput = {
  containerIds: ["airbyte-db"],
  volumeNames: ["airbyte-data"],
};

async function runAirbyte(
  state: Fleet,
  env: Readonly<Record<string, string | undefined>>,
) {
  const { host, calls } = airbyteHost(state);
  const airbyte = workflow("airbyte");
  const root = await temporary();
  try {
    const report = await new CleanupRun(
      [airbyte.build(airbyteInput, env)],
      root,
    ).run(context(host, "apply", ["airbyte"]), () => {});
    return { report, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const uninstalled = (calls: Command[]) =>
  calls.some((c) => c.file === "abctl" && c.args.includes("uninstall"));

test("Airbyte removal refuses while a selected container is running", async () => {
  const state = fleet();
  state.containers[0].State.Running = true;
  const { report, calls } = await runAirbyte(state, {});
  assert.equal(report.items[0].status, "skipped");
  assert.match(
    report.items[0].detail,
    /Stop the selected Airbyte stack before removal: airbyte-db/,
  );
  assert.equal(uninstalled(calls), false);
});

test("Airbyte removal refuses Docker environment overrides and a changed context", async () => {
  for (const env of [
    { DOCKER_HOST: "tcp://10.0.0.5:2376" },
    { DOCKER_CONTEXT: "other" },
  ]) {
    const { report, calls } = await runAirbyte(fleet(), env);
    assert.equal(report.items[0].status, "skipped", Object.keys(env)[0]);
    assert.match(report.items[0].detail, /without environment overrides/);
    assert.equal(uninstalled(calls), false);
  }
  // Inspection sees "local"; the check before uninstall sees another context.
  const { report, calls } = await runAirbyte(
    fleet({ context: ["local", "other"] }),
    {},
  );
  assert.equal(report.items[0].status, "skipped");
  assert.match(report.items[0].detail, /without environment overrides/);
  assert.equal(uninstalled(calls), false);
});

test("Airbyte removal uninstalls only the selected resources", async () => {
  const state = fleet();
  const { report, calls } = await runAirbyte(state, {});
  assert.deepEqual(
    report.items.map((item) => item.status),
    ["completed"],
  );
  assert.equal(uninstalled(calls), true);
});

test("Airbyte removal fails when the uninstall leaves a selected resource or takes another container", async () => {
  for (const [uninstall, message] of [
    [() => {}, /Selected Airbyte resources remain after uninstall/],
    [
      (f: Fleet) => {
        f.containers = [];
        f.volumes = f.volumes.filter((v) => v !== "airbyte-data");
      },
      /Pre-existing container was removed\/stopped: keep/,
    ],
  ] as const) {
    const { report } = await runAirbyte(fleet({ uninstall }), {});
    assert.equal(report.items[0].status, "failed");
    assert.match(report.items[0].detail, message);
  }
});

test("Airbyte removal fails when the uninstall takes an unselected volume", async () => {
  const state = fleet({
    uninstall: (f) => {
      f.containers = f.containers.filter((c) => c.Id !== "airbyte-db");
      f.volumes = [];
    },
  });
  const { report } = await runAirbyte(state, {});
  assert.equal(report.items[0].status, "failed");
  assert.match(
    report.items[0].detail,
    /A pre-existing Docker volume disappeared/,
  );
});

test("docker-offload refuses Docker environment overrides", async () => {
  for (const env of [
    { DOCKER_HOST: "tcp://10.0.0.5:2376" },
    { DOCKER_CONTEXT: "other" },
  ]) {
    const { host } = fake((command) =>
      command.args.includes("inspect")
        ? JSON.stringify([{ Endpoints: { docker: { Host: "ssh://fixture" } } }])
        : command.args.includes("info")
          ? "remote-daemon"
          : undefined,
    );
    const plan = await workflow("docker-offload")
      .build({ destination: "remote" }, env)
      .inspect(context(host, "preview", []));
    assert.match(
      plan.error ?? "",
      /environment overrides would bypass context selection/,
      Object.keys(env)[0],
    );
  }
});
