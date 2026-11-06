import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  utimes,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "../profile.ts";
import { MachineInventory } from "../src/machine/inventory.ts";
import { PathPolicy } from "../src/paths/policy.ts";
import { removeAction } from "../src/paths/remove.ts";
import { exists } from "../src/paths/within.ts";
import { Ineligible } from "../src/run/action.ts";
import { type Context } from "../src/run/context.ts";
import { type Command, type Host, LocalHost } from "../src/run/host.ts";
import { CleanupRun } from "../src/run/run.ts";
import { type TaskIdentity } from "../src/run/task.ts";
import { DockerCleanup } from "../src/tasks/docker/docker-cleanup.ts";
import { ChromeClonesCleanup } from "../src/tasks/macos/chrome-clones.ts";
import { RestartCleanup } from "../src/tasks/macos/restart.ts";
import { SimulatorRuntimesCleanup } from "../src/tasks/macos/simulators.ts";
import { ObsoleteAppUpdatesCleanup } from "../src/tasks/macos/staged-updates.ts";
import { PackageCacheCleanup } from "../src/tasks/packages/package-cache.ts";
import { ProjectArtifactsCleanup } from "../src/tasks/projects/project-artifacts.ts";
import { SelectedPathsCleanup } from "../src/tasks/selected/selected-paths.ts";

const routine: TaskIdentity = {
  id: "fixture",
  name: "Fixture",
  permission: "routine",
  methods: [1],
};
const explicit: TaskIdentity = { ...routine, permission: "explicit" };
const noop = async () => {};

function context(
  host: Host,
  mode: "preview" | "apply",
  allowed: string[],
): Context {
  return {
    host,
    mode,
    allowed: new Set(allowed),
    signal: new AbortController().signal,
    kept: [],
    selected: [],
  };
}

function fake(
  handler: (
    command: Command,
  ) => string | undefined | Promise<string | undefined>,
) {
  const calls: Command[] = [];
  const host: Host = {
    async run(command) {
      calls.push(command);
      const result = await handler(command);
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

/** plutil -extract <key> raw: the value, or exit 1 when the key is absent. */
function plist(values: Record<string, string>, command: Command) {
  const value = values[command.args[1]];
  if (value === undefined)
    throw Object.assign(new Error("No value at that key path"), { code: 1 });
  return value;
}
/** A temp root and a policy that owns it; each test removes the root in its own finally. */
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "disk-cleanup-test-")),
  );
  return { root, policy: new PathPolicy([root], []) };
}

async function old(path: string) {
  const date = new Date(Date.now() - 30 * 86400_000);
  await utimes(path, date, date);
}

test("preview is read-only, including a direct action execute call", async () => {
  const { root, policy } = await fixture();
  try {
    const path = join(root, "cache");
    await writeFile(path, "keep me");
    const { host } = fake(() => undefined);
    const task = new SelectedPathsCleanup(
      routine,
      [{ path, select: "self", olderThanDays: 0, reason: "fixture" }],
      policy,
    );
    const ctx = context(host, "preview", []);
    const report = await new CleanupRun([task], root).run(ctx, () => {});
    assert.equal(report.items[0].status, "planned");
    assert.equal(await readFile(path, "utf8"), "keep me");
    const plan = await task.inspect(ctx);
    await assert.rejects(
      plan.actions[0].execute(ctx, routine),
      /forbidden in preview/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit tasks need their exact allow ID and remove only the selected file", async () => {
  const { root, policy } = await fixture();
  try {
    const path = join(root, "chosen");
    const keep = join(root, "keep");
    await writeFile(path, "delete fixture");
    await writeFile(keep, "keep");
    const { host } = fake(() => undefined);
    const action = await removeAction(
      path,
      "fixture",
      policy,
      noop,
      context(host, "preview", []),
    );
    await assert.rejects(
      action.execute(context(host, "apply", []), explicit),
      /Requires --allow fixture/,
    );
    await action.execute(context(host, "apply", ["fixture"]), explicit);
    assert.equal(await exists(path), false);
    assert.equal(await readFile(keep, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed files and open files are rechecked immediately before removal", async () => {
  const { root, policy } = await fixture();
  try {
    const path = join(root, "chosen");
    await writeFile(path, "first");
    const { host } = fake(() => undefined);
    const action = await removeAction(
      path,
      "fixture",
      policy,
      noop,
      context(host, "preview", []),
    );
    await writeFile(path, "changed contents");
    await assert.rejects(
      action.execute(context(host, "apply", []), routine),
      /Changed since inspection/,
    );
    const active = fake((command) =>
      command.file === "lsof" ? `p123\nn${path}\n` : undefined,
    );
    const second = await removeAction(
      path,
      "fixture",
      policy,
      noop,
      context(active.host, "preview", []),
    );
    await assert.rejects(
      second.execute(context(active.host, "apply", []), routine),
      /Open files/,
    );
    assert.equal(await readFile(path, "utf8"), "changed contents");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected ancestors, path escapes, target and intermediate symlinks are rejected", async () => {
  const { root } = await fixture();
  try {
    const folder = join(root, "folder");
    await mkdir(folder);
    const protectedPath = join(folder, "history.sqlite");
    await writeFile(protectedPath, "data");
    const policy = new PathPolicy([root], [protectedPath]);
    await assert.rejects(policy.validate(folder), /Protected/);
    await assert.rejects(policy.validate(root), /owned root/);
    await assert.rejects(policy.validate(join(root, "..")), /owned root/);
    const target = join(root, "data");
    await mkdir(target);
    await writeFile(join(target, "file"), "data");
    const link = join(root, "link");
    await symlink(target, link);
    await assert.rejects(policy.validate(link), /Symlink/);
    await assert.rejects(policy.validate(join(link, "file")), /Symlink/);
    await assert.rejects(policy.validateNew(join(link, "new")), /Symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command discovery failures remain errors and later tasks still inspect", async () => {
  const { root, policy } = await fixture();
  try {
    const bad = new PackageCacheCleanup(routine, "npm", null, policy);
    const good = new SelectedPathsCleanup(
      { ...routine, id: "other" },
      [],
      policy,
    );
    const host: Host = {
      async run() {
        throw new Error("native failure");
      },
    };
    const result = await new CleanupRun([bad, good], root).run(
      context(host, "preview", []),
      () => {},
    );
    assert.match(result.tasks[0].error!, /native failure/);
    assert.equal(result.tasks[1].configured, false);
    assert.throws(() => new CleanupRun([bad, bad], root), /Duplicate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm uses its native cache command and preserves npx contents", async () => {
  const { root, policy } = await fixture();
  try {
    const cache = join(root, "npm");
    await mkdir(join(cache, "_cacache"), { recursive: true });
    await mkdir(join(cache, "_npx"));
    await writeFile(join(cache, "_npx", "tool"), "installed");
    const { host, calls } = fake(async (command) => {
      if (command.file === "npm") {
        assert.deepEqual(command.args, [
          "cache",
          "clean",
          "--force",
          "--cache",
          cache,
        ]);
        await rm(join(cache, "_cacache"), { recursive: true });
        return "";
      }
    });
    const task = new PackageCacheCleanup(routine, "npm", cache, policy);
    const plan = await task.inspect(context(host, "preview", []));
    assert.equal(
      calls.some((c) => c.file === "npm"),
      false,
    );
    await plan.actions[0].execute(context(host, "apply", []), routine);
    assert.equal(await readFile(join(cache, "_npx/tool"), "utf8"), "installed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker excludes referenced/local-only images and never forces image removal", async () => {
  const used = { Id: "container", Image: "used", State: { Running: false } };
  const { host, calls } = fake((command) => {
    if (command.args.join(" ") === "context show") return "fixture-local\n";
    const args = command.args.slice(2);
    assert.deepEqual(command.args.slice(0, 2), ["--context", "fixture-local"]);
    if (args[0] === "context")
      return JSON.stringify([
        { Endpoints: { docker: { Host: "unix:///fixture.sock" } } },
      ]);
    if (args[0] === "info") return "daemon";
    if (args[0] === "container" && args[1] === "ls") return "container";
    if (args[0] === "container" && args[1] === "inspect")
      return JSON.stringify([used]);
    if (args[0] === "volume") return "important-data";
    if (args[0] === "image" && args[1] === "ls") return "used\nlocal\npulled";
    if (args[0] === "image" && args[1] === "inspect")
      return JSON.stringify([
        { Id: "used", RepoDigests: ["used@sha"], Size: 1 },
        { Id: "local", RepoDigests: null, Size: 1 },
        { Id: "pulled", RepoDigests: ["repo@sha"], Size: 10 },
      ]);
    if (args[0] === "image" && args[1] === "rm") {
      assert.deepEqual(args, ["image", "rm", "pulled"]);
      return "";
    }
  });
  const task = new DockerCleanup(routine, "images");
  const plan = await task.inspect(context(host, "preview", []));
  assert.equal(plan.error, null);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].view.target, "pulled");
  assert.equal(
    calls.some((c) => c.args.includes("rm")),
    false,
  );
  await plan.actions[0].execute(context(host, "apply", []), routine);
});

test("Docker prune never passes --volumes and detects lost volumes", async () => {
  let removed = false;
  const { host } = fake((command) => {
    if (command.args.join(" ") === "context show") return "local\n";
    const args = command.args.slice(2);
    if (args[0] === "context")
      return JSON.stringify([
        { Endpoints: { docker: { Host: "unix:///fixture.sock" } } },
      ]);
    if (args[0] === "info") return "daemon";
    if (args[0] === "container") return "";
    if (args[0] === "volume") return removed ? "" : "keep";
    if (args[1] === "df") return "usage";
    if (args[1] === "prune") {
      assert.deepEqual(args, ["system", "prune", "--all", "--force"]);
      removed = true;
      return "";
    }
  });
  const task = new DockerCleanup(explicit, "system");
  const plan = await task.inspect(context(host, "preview", []));
  assert.equal(removed, false);
  assert.equal(plan.actions[0].view.target, "Docker local/system");
  await assert.rejects(
    plan.actions[0].execute(context(host, "apply", ["fixture"]), explicit),
    /volume disappeared/,
  );
});

test("routine Docker cleanup refuses a remote context", async () => {
  const { host } = fake((command) =>
    command.args.join(" ") === "context show"
      ? "remote\n"
      : JSON.stringify([{ Endpoints: { docker: { Host: "ssh://remote" } } }]),
  );
  const task = new DockerCleanup(routine, "system");
  assert.match(
    (await task.inspect(context(host, "preview", []))).error!,
    /local Unix-socket/,
  );
});

test("build-cache cleanup binds the local builder and rejects remote/mixed endpoints", async () => {
  let endpoint = "local";
  const { host, calls } = fake((command) => {
    if (command.args.join(" ") === "context show") return "local\n";
    const args = command.args.slice(2);
    if (args[0] === "context")
      return JSON.stringify([
        { Endpoints: { docker: { Host: "unix:///fixture.sock" } } },
      ]);
    if (args[0] === "info") return "daemon";
    if (args[0] === "container" || args[0] === "volume") return "";
    if (args[0] === "system") return "usage";
    if (args[0] === "buildx" && args[1] === "inspect")
      return `Name: local\nDriver: docker\nNodes:\nEndpoint: ${endpoint}\n`;
    if (args[0] === "buildx" && args[1] === "prune") {
      assert.deepEqual(args, [
        "buildx",
        "prune",
        "--builder",
        "local",
        "--all",
        "--force",
      ]);
      return "";
    }
  });
  const task = new DockerCleanup(routine, "build-cache");
  const plan = await task.inspect(context(host, "preview", []));
  assert.equal(plan.error, null);
  assert.equal(
    calls.some((c) => c.args.includes("prune")),
    false,
  );
  await plan.actions[0].execute(context(host, "apply", []), routine);
  endpoint = "ssh://remote";
  await assert.rejects(
    plan.actions[0].execute(context(host, "apply", []), routine),
    /native local Docker builder/,
  );
});

test("recent sibling activity protects nested monorepo dependencies", async () => {
  const { root, policy } = await fixture();
  try {
    const project = join(root, "project");
    const packagePath = join(project, "packages/a");
    await mkdir(join(packagePath, "node_modules"), { recursive: true });
    await mkdir(join(project, ".git"));
    await writeFile(join(project, "package-lock.json"), "{}");
    await mkdir(join(project, "packages/b"));
    const recent = join(project, "packages/b/source.ts");
    await writeFile(recent, "recent");
    for (const path of [
      project,
      join(project, "packages"),
      packagePath,
      join(project, "packages/b"),
      join(project, "package-lock.json"),
    ])
      await old(path);
    const { host } = fake((command) => {
      if (command.file !== "git") return undefined;
      if (command.args.includes("rev-parse")) return project;
      if (command.args.includes("reflog")) return "HEAD@{1}";
      if (command.args.includes("log")) return "1";
      return "";
    });
    const task = new ProjectArtifactsCleanup(
      routine,
      new MachineInventory({
        home: root,
        applicationDirs: [],
        pathDirs: [],
        env: {},
      }),
      "dependencies",
      7,
      policy,
    );
    const plan = await task.inspect(context(host, "preview", []));
    assert.equal(plan.actions.length, 0);
    assert.ok(
      plan.notes.some((note) => note.includes("Recent project activity")),
    );
    assert.equal(await exists(join(packagePath, "node_modules")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newer staged updates are retained while obsolete bundles are candidates", async () => {
  const { root } = await fixture();
  try {
    const installed = join(root, "Applications/App.app");
    const staging = join(
      root,
      "Caches/example.app/org.sparkle-project.Sparkle/Installation",
    );
    await mkdir(join(installed, "Contents/Frameworks/Sparkle.framework"), {
      recursive: true,
    });
    await writeFile(join(installed, "Contents/Info.plist"), "");
    await mkdir(join(staging, "Old.app"), { recursive: true });
    await mkdir(join(staging, "New.app"));
    const { host } = fake((command) =>
      command.file === "plutil"
        ? plist(
            {
              CFBundleIdentifier: "example.app",
              CFBundleShortVersionString: command.args
                .at(-1)!
                .includes("New.app")
                ? "3.0"
                : command.args.at(-1)!.includes("Old.app")
                  ? "1.0"
                  : "2.0",
              CFBundleVersion: "1",
            },
            command,
          )
        : undefined,
    );
    const task = new ObsoleteAppUpdatesCleanup(
      routine,
      new MachineInventory({
        home: root,
        applicationDirs: [join(root, "Applications")],
        pathDirs: [],
        env: {},
      }),
      join(root, "Caches"),
      join(root, "Support"),
    );
    const plan = await task.inspect(context(host, "preview", []));
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].view.target, join(staging, "Old.app"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing version metadata and a newer build of the same normalized version are retained", async () => {
  const { root } = await fixture();
  try {
    const installed = join(root, "Applications/App.app"),
      staging = join(
        root,
        "Caches/example.app/org.sparkle-project.Sparkle/Installation",
      );
    await mkdir(join(installed, "Contents/Frameworks/Sparkle.framework"), {
      recursive: true,
    });
    await writeFile(join(installed, "Contents/Info.plist"), "");
    await mkdir(join(staging, "NewBuild.app"), { recursive: true });
    await mkdir(join(staging, "Unknown.app"));
    const { host } = fake((command) => {
      if (command.file !== "plutil") return undefined;
      const path = command.args.at(-1)!;
      if (path.includes("Unknown.app")) return plist({}, command);
      return plist(
        {
          CFBundleIdentifier: "example.app",
          CFBundleShortVersionString: path.includes("NewBuild.app")
            ? "1.0.0"
            : "1.0",
          CFBundleVersion: path.includes("NewBuild.app") ? "2" : "1",
        },
        command,
      );
    });
    const plan = await new ObsoleteAppUpdatesCleanup(
      routine,
      new MachineInventory({
        home: root,
        applicationDirs: [join(root, "Applications")],
        pathDirs: [],
        env: {},
      }),
      join(root, "Caches"),
      join(root, "Support"),
    ).inspect(context(host, "preview", []));
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.notes.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Chrome clone identity and age are checked; installed app survives", async () => {
  const { root, policy } = await fixture();
  try {
    const installed = join(root, "Applications/Google Chrome.app");
    const clones = join(root, "clones");
    const clone = join(clones, "code_sign_clone.old");
    await mkdir(join(installed, "Contents"), { recursive: true });
    await writeFile(join(installed, "Contents/Info.plist"), "");
    await mkdir(join(clone, "Google Chrome.app.bundle"), { recursive: true });
    await old(clone);
    const { host } = fake((command) =>
      command.file === "plutil"
        ? plist(
            {
              CFBundleIdentifier: "com.google.Chrome",
              CFBundleShortVersionString: "1",
              CFBundleVersion: "100",
            },
            command,
          )
        : undefined,
    );
    const task = new ChromeClonesCleanup(
      routine,
      clones,
      new MachineInventory({
        home: root,
        applicationDirs: [join(root, "Applications")],
        pathDirs: [],
        env: {},
      }),
      policy,
    );
    const plan = await task.inspect(context(host, "preview", []));
    assert.equal(plan.actions.length, 1);
    await plan.actions[0].execute(context(host, "apply", []), routine);
    assert.equal(await exists(installed), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("simulator deletion refuses to shut down a booted device", async () => {
  const id = "12345678-1234-1234-1234-123456789012";
  const { host, calls } = fake((command) => {
    if (command.args.includes("--dry-run"))
      return `Would delete P: ${id} iOS (26.4.1 - 23E254a) (Ready)\n`;
    if (command.args.includes("booted"))
      return JSON.stringify({ devices: { runtime: [{ state: "Booted" }] } });
  });
  const task = new SimulatorRuntimesCleanup(explicit);
  const plan = await task.inspect(context(host, "preview", []));
  await assert.rejects(
    plan.actions[0].execute(context(host, "apply", ["fixture"]), explicit),
    /booted/,
  );
  assert.equal(
    calls.some((c) => c.args.includes(id)),
    false,
  );
});

test("simctl's exact no-matches exit is empty, other service errors remain failures", async () => {
  const task = new SimulatorRuntimesCleanup(explicit);
  const empty: Host = {
    async run() {
      throw Object.assign(new Error("native empty result"), {
        code: 2,
        stderr: "No matching images found to delete\n",
      });
    },
  };
  const emptyPlan = await task.inspect(context(empty, "preview", []));
  assert.equal(emptyPlan.error, null);
  assert.equal(emptyPlan.actions.length, 0);
  const broken: Host = {
    async run() {
      throw Object.assign(new Error("service unavailable"), {
        code: 2,
        stderr: "Cannot connect to CoreSimulator\n",
      });
    },
  };
  assert.match(
    (await task.inspect(context(broken, "preview", []))).error!,
    /service unavailable/,
  );
});

test("restart preview only reads swap usage", async () => {
  const { host, calls } = fake((command) =>
    command.file === "sysctl" ? "total = 1G used = 1G" : undefined,
  );
  const plan = await new RestartCleanup(explicit).inspect(
    context(host, "preview", []),
  );
  assert.equal(plan.actions.length, 1);
  assert.equal(
    calls.some((c) => c.file === "osascript"),
    false,
  );
});

test("LocalHost kills a timed-out owned child and surfaces native failures", async () => {
  const host = new LocalHost(75);
  await assert.rejects(
    host.run(
      { file: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof Error && "signal" in error && error.signal === "SIGKILL",
  );
  await assert.rejects(
    new LocalHost(3000).run(
      { file: process.execPath, args: ["-e", "process.exit(7)"] },
      new AbortController().signal,
    ),
    (error) => error instanceof Error && "code" in error && error.code === 7,
  );
});

test("profile covers methods 1-20 with exactly the learned task IDs", () => {
  assert.deepEqual(
    [...new Set(cleanup.tasks.flatMap((task) => task.identity.methods))].sort(
      (a, b) => a - b,
    ),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    cleanup.tasks.map((task) => task.identity.id),
    [
      "docker-build-cache",
      "docker-images",
      "docker-system",
      "npm",
      "uv",
      "pip",
      "brew-downloads",
      "brew-maintenance",
      "dependencies",
      "nx-cache",
      "builds",
      "app-caches",
      "staged-updates",
      "installers",
      "macos-installers",
      "chrome-clones",
      "wallpapers",
      "trash",
      "simulators",
      "restart",
      "nx-temp-installs",
      "dangling-links",
      "node-versions",
      "launch-agents",
      "orphaned-app-data",
    ],
  );
  assert.equal(
    new Set(cleanup.tasks.map((task) => task.identity.id)).size,
    cleanup.tasks.length,
  );
  assert.ok(Ineligible.prototype instanceof Error);
});
