import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  utimes,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineInventory } from "../src/machine/inventory.ts";
import { PathPolicy } from "../src/paths/policy.ts";
import { exists } from "../src/paths/within.ts";
import { type Context } from "../src/run/context.ts";
import { type Command, type Host, LocalHost } from "../src/run/host.ts";
import { CleanupRun } from "../src/run/run.ts";
import { type TaskIdentity } from "../src/run/task.ts";
import { InstallerFilesCleanup } from "../src/tasks/installers/installer-files.ts";
import { MacOSInstallersCleanup } from "../src/tasks/installers/macos-installers.ts";
import { DockerCleanup } from "../src/tasks/docker/docker-cleanup.ts";
import { DanglingLinksCleanup } from "../src/tasks/links/dangling-links.ts";
import { LaunchAgentsCleanup } from "../src/tasks/macos/launch-agents.ts";
import { ObsoleteAppUpdatesCleanup } from "../src/tasks/macos/staged-updates.ts";
import { NodeVersionsCleanup } from "../src/tasks/node/node-versions.ts";
import { NxTempInstallsCleanup } from "../src/tasks/projects/nx-temp-installs.ts";
import { ProjectArtifactsCleanup } from "../src/tasks/projects/project-artifacts.ts";
import { OrphanedAppDataCleanup } from "../src/tasks/residue/orphaned-app-data.ts";

const task = (
  id: string,
  permission: "routine" | "explicit",
): TaskIdentity => ({
  id,
  name: id,
  permission,
  methods: [1],
});

function context(
  host: Host,
  mode: "preview" | "apply",
  allowed: string[],
  kept: string[] = [],
  selected: string[] = [],
): Context {
  return {
    host,
    mode,
    allowed: new Set(allowed),
    kept,
    selected,
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

function exit(code: number): Error {
  return Object.assign(new Error(`exit ${code}`), { code });
}

/** plutil -extract <key> raw: the value, or exit 1 when the key is absent. */
function plist(values: Record<string, string>, command: Command) {
  const value = values[command.args[1]];
  if (value === undefined)
    throw Object.assign(new Error("No value at that key path"), { code: 1 });
  return value;
}
async function temporaryHome() {
  return realpath(await mkdtemp(join(tmpdir(), "disk-cleanup-learned-")));
}

async function age(path: string, days: number) {
  const date = new Date(Date.now() - days * 86400_000);
  await utimes(path, date, date);
}

function inventory(
  home: string,
  extra: { pathDirs?: string[]; env?: Record<string, string> } = {},
) {
  return new MachineInventory({
    home,
    applicationDirs: [join(home, "Applications")],
    pathDirs: extra.pathDirs ?? [],
    env: extra.env ?? {},
  });
}

test("orphaned-app-data proposes only unowned old folders and removes only those", async () => {
  const home = await temporaryHome();
  try {
    const support = join(home, "Library/Application Support");
    const folders = {
      app: join(support, "com.example.Owned"), // installed app by bundle id
      command: join(home, ".toolcmd"), // a command on PATH
      brew: join(home, ".brewpkg"), // a Homebrew formula
      extension: join(home, ".extpub"), // a VS Code extension publisher
      process: join(support, "Daemonly"), // a running process
      apple: join(support, "com.apple.Qzx"),
      system: join(home, ".cups"),
      orphanDot: join(home, ".exo"),
      orphanSupport: join(support, "sst"),
    };
    for (const path of Object.values(folders)) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "data"), "x");
      await age(join(path, "data"), 200);
      await age(path, 200);
    }
    await writeFile(join(home, ".dotfile"), "shared config");
    await mkdir(join(home, "Applications/Owned.app/Contents"), {
      recursive: true,
    });
    await writeFile(
      join(home, "Applications/Owned.app/Contents/Info.plist"),
      "",
    );
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "toolcmd"), "#!/bin/sh\n", { mode: 0o755 });
    await mkdir(join(home, ".vscode/extensions/extpub.thing-1.2.3"), {
      recursive: true,
    });
    const { host } = fake((command) => {
      if (command.file === "plutil")
        return plist(
          {
            CFBundleIdentifier: "com.example.Owned",
            CFBundleName: "Zeta",
          },
          command,
        );
      if (command.file === "brew")
        return command.args.includes("--formula") ? "brewpkg\n" : "";
      if (command.file === "uv") return "";
      if (command.file === "ps") return "/usr/libexec/daemonly\n";
      return undefined;
    });
    const policy = new PathPolicy([home], []);
    const cleanup = new OrphanedAppDataCleanup(
      task("orphaned-app-data", "explicit"),
      inventory(home, { pathDirs: [bin] }),
      90,
      policy,
    );
    const plan = await cleanup.inspect(
      context(
        host,
        "preview",
        [],
        [],
        [folders.orphanDot, folders.orphanSupport],
      ),
    );
    assert.equal(plan.error, null);
    assert.deepEqual(
      plan.actions.map((action) => action.view.target).sort(),
      [folders.orphanDot, folders.orphanSupport].sort(),
    );
    assert.match(
      plan.actions[0].view.reason,
      /[Nn]o owner among .*installed apps.*last used/,
    );
    const report = await new CleanupRun([cleanup], home).run(
      context(
        host,
        "apply",
        ["orphaned-app-data"],
        [],
        [folders.orphanDot, folders.orphanSupport],
      ),
      () => {},
    );
    assert.deepEqual(
      report.items.map((item) => item.status),
      ["completed", "completed"],
    );
    for (const [name, path] of Object.entries(folders))
      assert.equal(await exists(path), !name.startsWith("orphan"), name);
    assert.equal(await exists(join(home, ".dotfile")), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orphaned-app-data keeps recent, referenced and open folders", async () => {
  const home = await temporaryHome();
  try {
    const recent = join(home, ".recentorphan");
    const onPath = join(home, ".pathtool");
    const inEnv = join(home, ".envtool");
    const inShell = join(home, ".shelltool");
    const open = join(home, ".openorphan");
    for (const path of [recent, onPath, inEnv, inShell, open]) {
      await mkdir(join(path, "bin"), { recursive: true });
      await age(join(path, "bin"), 200);
      await age(path, 200);
    }
    await writeFile(join(recent, "fresh"), "new"); // written now, accessed long ago
    const longAgo = new Date(Date.now() - 200 * 86400_000);
    await utimes(join(recent, "fresh"), longAgo, new Date());
    await age(recent, 200);
    // Written long ago, accessed last month.
    const read = join(home, ".readorphan");
    await mkdir(read);
    await writeFile(join(read, "config"), "x");
    const month = new Date(Date.now() - 30 * 86400_000);
    const old = new Date(Date.now() - 200 * 86400_000);
    await utimes(join(read, "config"), month, old);
    await utimes(read, old, old);
    await writeFile(join(home, ".zshrc"), 'source "$HOME/.shelltool/init"\n');
    const { host } = fake((command) => {
      if (command.file === "lsof") return `p1\nn${open}/bin\n`;
      if (["brew", "uv", "ps", "plutil"].includes(command.file)) return "";
      return undefined;
    });
    const cleanup = new OrphanedAppDataCleanup(
      task("orphaned-app-data", "explicit"),
      inventory(home, {
        pathDirs: [join(onPath, "bin")],
        env: { ENVTOOL_HOME: inEnv },
      }),
      90,
      new PathPolicy([home], []),
    );
    const plan = await cleanup.inspect(
      context(
        host,
        "preview",
        [],
        [],
        [recent, read, onPath, inEnv, inShell, open],
      ),
    );
    assert.equal(plan.error, null);
    // lsof runs immediately before removal, so the open folder is a candidate until then.
    assert.deepEqual(
      plan.actions.map((action) => action.view.target),
      [open],
    );
    assert.ok(
      plan.notes.some((note) => note.includes(`within 90 days: ${recent}`)),
    );
    assert.ok(
      plan.notes.some((note) => note.includes(`within 90 days: ${read}`)),
    );
    const report = await new CleanupRun([cleanup], home).run(
      context(
        host,
        "apply",
        ["orphaned-app-data"],
        [],
        [recent, read, onPath, inEnv, inShell, open],
      ),
      () => {},
    );
    assert.deepEqual(
      report.items.map((item) => [item.status, item.detail]),
      [["skipped", `Error: Open files: ${open}`]],
    );
    for (const path of [recent, read, onPath, inEnv, inShell, open])
      assert.equal(await exists(path), true, path);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orphaned-app-data fails closed when an owner source fails, and runs without an absent one", async () => {
  const home = await temporaryHome();
  try {
    await mkdir(join(home, ".orphan"));
    await age(join(home, ".orphan"), 200);
    const run = (brew: () => string) =>
      new OrphanedAppDataCleanup(
        task("orphaned-app-data", "explicit"),
        inventory(home),
        90,
        new PathPolicy([home], []),
      ).inspect(
        context(
          {
            async run(command) {
              if (command.file === "brew") return brew();
              if (command.file === "du") return "4\tx\n";
              return "";
            },
          },
          "preview",
          [],
          [],
          [join(home, ".orphan")],
        ),
      );
    const failed = await run(() => {
      throw exit(1);
    });
    assert.match(failed.error ?? "", /exit 1/);
    assert.equal(failed.actions.length, 0);
    const missing = await new OrphanedAppDataCleanup(
      task("orphaned-app-data", "explicit"),
      inventory(home),
      90,
      new PathPolicy([home], []),
    ).inspect(
      context(
        {
          run: (command, signal) =>
            command.file === "brew"
              ? new LocalHost(10_000).run(
                  { file: "disk-cleanup-absent-brew", args: command.args },
                  signal,
                )
              : Promise.resolve(command.file === "du" ? "4\tx\n" : ""),
        },
        "preview",
        [],
        [],
        [join(home, ".orphan")],
      ),
    );
    assert.equal(missing.error, null);
    assert.equal(missing.actions.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** A stand-in for nvm.sh that nvm's own callers source; production runs it with real bash. */
async function stubNvm(
  nvm: string,
  versions: Record<string, string>,
  failDefault = false,
) {
  const cases = Object.entries(versions)
    .map(
      ([spec, version]) => `      ${JSON.stringify(spec)}) echo ${version} ;;`,
    )
    .join("\n");
  await writeFile(
    join(nvm, "nvm.sh"),
    `NVM_DIR="$(dirname "\${BASH_SOURCE[0]}")"
nvm() {
  case "$1" in
    version)
      ${failDefault ? '[ "$2" = default ] && return 1' : ":"}
      case "$2" in
${cases}
      *) echo N/A; return 3 ;;
      esac ;;
    uninstall) rm -r "$NVM_DIR/versions/node/$2" ;;
  esac
}
`,
  );
}

function withRealBash(host: Host): Host {
  const real = new LocalHost(10_000);
  return {
    run: (command, signal) =>
      command.file === "/bin/bash"
        ? real.run(command, signal)
        : host.run(command, signal),
  };
}

test("node-versions keeps the default and pinned versions, uninstalls the rest, and skips one in use", async () => {
  const home = await temporaryHome();
  try {
    const nvm = join(home, ".nvm");
    const versions = join(nvm, "versions/node");
    for (const version of ["v22.1.0", "v24.2.0", "v26.3.0", "v20.9.0"])
      await mkdir(join(versions, version, "bin"), { recursive: true });
    await stubNvm(nvm, { default: "v26.3.0", "24": "v24.2.0" });
    const project = join(home, "code/app");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(project, ".nvmrc"), "24\n");
    await mkdir(join(project, "packages/old"), { recursive: true });
    await writeFile(join(project, "packages/old/.node-version"), "18\n");
    const { host } = fake((command) => {
      if (command.file === "git")
        return `worktree ${project}\nHEAD 0\nbranch refs/heads/main\n`;
      if (command.file === "lsof") return `p9\nn${versions}/v20.9.0/bin/node\n`;
      return undefined;
    });
    const cleanup = new NodeVersionsCleanup(
      task("node-versions", "explicit"),
      inventory(home),
      new PathPolicy([home], []),
    );
    const plan = await cleanup.inspect(
      context(withRealBash(host), "preview", []),
    );
    assert.equal(plan.error, null);
    assert.deepEqual(plan.actions.map((action) => action.view.target).sort(), [
      join(versions, "v20.9.0"),
      join(versions, "v22.1.0"),
    ]);
    assert.ok(
      plan.notes.some((note) => note.includes("asks for 18; not installed")),
    );
    const report = await new CleanupRun([cleanup], home).run(
      context(withRealBash(host), "apply", ["node-versions"]),
      () => {},
    );
    const status = Object.fromEntries(
      report.items.map((item) => [item.target, item.status]),
    );
    assert.equal(status[join(versions, "v22.1.0")], "completed");
    assert.equal(status[join(versions, "v20.9.0")], "skipped");
    assert.equal(await exists(join(versions, "v22.1.0")), false);
    for (const version of ["v20.9.0", "v24.2.0", "v26.3.0"])
      assert.equal(await exists(join(versions, version)), true, version);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("node-versions fails closed when nvm cannot resolve the default", async () => {
  const home = await temporaryHome();
  try {
    const nvm = join(home, ".nvm");
    await mkdir(join(nvm, "versions/node/v26.3.0"), { recursive: true });
    await stubNvm(nvm, { default: "v26.3.0" }, true);
    const { host } = fake(() => undefined);
    const plan = await new NodeVersionsCleanup(
      task("node-versions", "explicit"),
      inventory(home),
      new PathPolicy([home], []),
    ).inspect(context(withRealBash(host), "preview", []));
    assert.match(plan.error ?? "", /Command failed/);
    assert.equal(plan.actions.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("node-versions is unconfigured, not failed, when nvm is not installed", async () => {
  const home = await temporaryHome();
  try {
    const { host } = fake(() => undefined);
    const plan = await new NodeVersionsCleanup(
      task("node-versions", "explicit"),
      inventory(home),
      new PathPolicy([home], []),
    ).inspect(context(host, "preview", []));
    assert.deepEqual(
      [plan.error, plan.configured, plan.notes],
      [null, false, ["nvm is not installed"]],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("launch-agents removes plists with a missing or absent program and keeps loaded or valid ones", async () => {
  const home = await temporaryHome();
  try {
    const agents = join(home, "LaunchAgents");
    await mkdir(agents);
    const program = join(home, "real-program");
    await writeFile(program, "");
    const plists: Record<string, object | null> = {
      "missing.plist": { Label: "x.missing", Program: join(home, "gone") },
      "empty.plist": {},
      "valid.plist": { Label: "x.valid", ProgramArguments: [program] },
      "loaded.plist": { Label: "x.loaded", Program: join(home, "gone") },
      "broken.plist": null,
    };
    for (const name of Object.keys(plists))
      await writeFile(join(agents, name), "");
    const { host } = fake((command) => {
      if (command.file === "plutil") {
        const value = plists[command.args.at(-1)!.split("/").at(-1)!];
        if (value === null) throw exit(1);
        return JSON.stringify(value);
      }
      if (command.file === "launchctl") {
        if (command.args[1] === "gui/501/x.loaded") return "state = running";
        throw exit(113);
      }
      return undefined;
    });
    const cleanup = new LaunchAgentsCleanup(
      task("launch-agents", "explicit"),
      agents,
      501,
      inventory(home),
      new PathPolicy([home], []),
    );
    const plan = await cleanup.inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    assert.deepEqual(plan.actions.map((action) => action.view.target).sort(), [
      join(agents, "empty.plist"),
      join(agents, "missing.plist"),
    ]);
    assert.ok(
      plan.notes.includes("Loaded; run: launchctl bootout gui/501/x.loaded"),
    );
    assert.ok(
      plan.notes.includes(`Unreadable plist: ${join(agents, "broken.plist")}`),
    );
    await new CleanupRun([cleanup], home).run(
      context(host, "apply", ["launch-agents"]),
      () => {},
    );
    for (const [name, removed] of [
      ["missing.plist", true],
      ["empty.plist", true],
      ["valid.plist", false],
      ["loaded.plist", false],
      ["broken.plist", false],
    ] as const)
      assert.equal(await exists(join(agents, name)), !removed, name);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dangling-links unlinks only owned PATH links to missing targets", async () => {
  const home = await temporaryHome();
  const outside = await temporaryHome();
  try {
    const bin = join(home, "bin");
    const brew = join(home, "homebrew");
    const offPath = join(home, "other");
    for (const directory of [
      bin,
      join(brew, "bin"),
      offPath,
      join(outside, "bin"),
    ])
      await mkdir(directory, { recursive: true });
    await writeFile(join(home, "alive"), "");
    await symlink(join(home, "gone"), join(bin, "dangling"));
    await symlink(join(home, "returns"), join(bin, "comes-back"));
    await symlink(join(home, "alive"), join(bin, "alive"));
    await symlink("/Volumes/Unmounted/tool", join(bin, "volume"));
    await symlink(join(home, "gone"), join(offPath, "ignored"));
    await symlink(join(home, "gone"), join(brew, "bin/brewlink"));
    await symlink(join(home, "gone"), join(outside, "bin/rootlink"));
    const cleanup = new DanglingLinksCleanup(
      task("dangling-links", "explicit"),
      inventory(home, {
        pathDirs: [bin, join(brew, "bin"), join(outside, "bin")],
        env: { HOMEBREW_PREFIX: brew },
      }),
      new PathPolicy([home], []),
    );
    const { host } = fake(() => undefined);
    const plan = await cleanup.inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    assert.deepEqual(plan.actions.map((action) => action.view.target).sort(), [
      join(bin, "comes-back"),
      join(bin, "dangling"),
    ]);
    assert.ok(
      plan.notes.some((note) => note.includes("brew cleanup --prune-prefix")),
    );
    assert.ok(
      plan.notes.includes(
        `Outside owned roots: ${join(outside, "bin/rootlink")} -> ${join(home, "gone")}; run: sudo rm ${JSON.stringify(join(outside, "bin/rootlink"))}`,
      ),
    );
    await writeFile(join(home, "returns"), "back");
    // The target came back between inspection and execution.
    const ctx = context(host, "apply", ["dangling-links"]);
    for (const action of plan.actions)
      if (action.view.target === join(bin, "comes-back"))
        await assert.rejects(
          action.execute(ctx, task("dangling-links", "explicit")),
          /Target exists again/,
        );
      else await action.execute(ctx, task("dangling-links", "explicit"));
    assert.equal(await exists(join(bin, "dangling")), false);
    for (const link of [
      join(bin, "comes-back"),
      join(bin, "alive"),
      join(bin, "volume"),
      join(offPath, "ignored"),
      join(brew, "bin/brewlink"),
      join(outside, "bin/rootlink"),
    ])
      assert.equal(await exists(link), true, link);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("nx-temp-installs removes an exited daemon's install as routine work and keeps a live one", async () => {
  const home = await temporaryHome();
  try {
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    const dead = join(home, `tmp-${exited}-abc`);
    const live = join(home, `tmp-${process.pid}-def`);
    const other = join(home, `tmp-${exited}-xyz`);
    for (const path of [dead, live])
      await mkdir(join(path, "node_modules/nx"), { recursive: true });
    await writeFile(join(dead, "node_modules/nx/package.json"), "{}");
    await writeFile(join(live, "node_modules/nx/package.json"), "{}");
    await mkdir(other);
    const cleanup = new NxTempInstallsCleanup(
      task("nx-temp-installs", "routine"),
      home,
      process.getuid!(),
      new PathPolicy([home], []),
    );
    const { host } = fake(() => undefined);
    const foreign = await new NxTempInstallsCleanup(
      task("nx-temp-installs", "routine"),
      home,
      process.getuid!() + 1,
      new PathPolicy([home], []),
    ).inspect(context(host, "preview", []));
    assert.equal(foreign.actions.length, 0);
    const report = await new CleanupRun([cleanup], home).run(
      context(host, "apply", []),
      () => {},
    );
    assert.deepEqual(
      report.items.map((item) => [item.target, item.status]),
      [[dead, "completed"]],
    );
    assert.ok(
      report.tasks[0].notes.some((note) =>
        note.includes(`Process ${process.pid} is still running`),
      ),
    );
    assert.equal(await exists(dead), false);
    assert.equal(await exists(live), true);
    assert.equal(await exists(other), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("--keep skips any target inside a kept path", async () => {
  const home = await temporaryHome();
  try {
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    const dead = join(home, `tmp-${exited}-keep`);
    await mkdir(join(dead, "node_modules/nx"), { recursive: true });
    await writeFile(join(dead, "node_modules/nx/package.json"), "{}");
    const { host } = fake(() => undefined);
    const report = await new CleanupRun(
      [
        new NxTempInstallsCleanup(
          task("nx-temp-installs", "routine"),
          home,
          process.getuid!(),
          new PathPolicy([home], []),
        ),
      ],
      home,
    ).run(context(host, "apply", [], [home]), () => {});
    assert.deepEqual(
      report.items.map((item) => [item.status, item.detail]),
      [["skipped", `Kept by --keep ${home}`]],
    );
    assert.equal(await exists(dead), true);
    const elsewhere = await new CleanupRun(
      [
        new NxTempInstallsCleanup(
          task("nx-temp-installs", "routine"),
          home,
          process.getuid!(),
          new PathPolicy([home], []),
        ),
      ],
      home,
    ).run(context(host, "apply", [], [join(home, "elsewhere")]), () => {});
    assert.deepEqual(
      elsewhere.items.map((item) => item.status),
      ["completed"],
    );
    assert.equal(await exists(dead), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a native tool that is not installed leaves the task unconfigured, not failed", async () => {
  const home = await temporaryHome();
  try {
    const real = new LocalHost(10_000);
    const host: Host = {
      run: (command, signal) =>
        real.run(
          { file: "disk-cleanup-absent-tool", args: command.args },
          signal,
        ),
    };
    const report = await new CleanupRun(
      [new DockerCleanup(task("docker-images", "routine"), "images")],
      home,
    ).run(context(host, "preview", []), () => {});
    assert.deepEqual(
      [
        report.tasks[0].error,
        report.tasks[0].configured,
        report.tasks[0].notes,
      ],
      [null, false, ["disk-cleanup-absent-tool is not installed"]],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Docker refuses a current context that is not a local Unix socket", async () => {
  for (const endpoint of ["tcp://10.0.0.5:2376", "ssh://root@server"]) {
    const { host, calls } = fake((command) => {
      if (command.args.join(" ") === "context show") return "server\n";
      if (command.args.join(" ") === "--context server context inspect server")
        return JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]);
      return undefined;
    });
    const plan = await new DockerCleanup(
      task("docker-system", "explicit"),
      "system",
    ).inspect(context(host, "preview", []));
    assert.match(plan.error ?? "", /local Unix-socket/, endpoint);
    assert.ok(!calls.some((call) => call.args.includes("prune")));
  }
});

test("staged-updates learns ShipIt staging of installed apps only", async () => {
  const home = await temporaryHome();
  try {
    const app = join(home, "Applications/Tool.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents/Info.plist"), "");
    const caches = join(home, "Caches");
    await mkdir(join(caches, "com.example.tool.ShipIt/update.1/Tool.app"), {
      recursive: true,
    });
    // Not installed, and the installed app has no Sparkle.framework.
    await mkdir(join(caches, "com.example.gone.ShipIt/update.1/Gone.app"), {
      recursive: true,
    });
    await mkdir(
      join(
        caches,
        "com.example.tool/org.sparkle-project.Sparkle/Installation/Tool.app",
      ),
      {
        recursive: true,
      },
    );
    const { host } = fake((command) =>
      command.file === "plutil"
        ? plist(
            {
              CFBundleIdentifier: command.args.at(-1)!.includes("Gone.app")
                ? "com.example.gone"
                : "com.example.tool",
              CFBundleShortVersionString: "1.0",
              CFBundleVersion: "1",
            },
            command,
          )
        : undefined,
    );
    const plan = await new ObsoleteAppUpdatesCleanup(
      task("staged-updates", "routine"),
      inventory(home),
      caches,
      join(home, "Support"),
    ).inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    assert.deepEqual(
      plan.actions.map((action) => action.view.target),
      [join(caches, "com.example.tool.ShipIt/update.1/Tool.app")],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("project artifacts learn git projects and their worktrees, but not repos under Library", async () => {
  const home = await temporaryHome();
  const worktrees = await temporaryHome();
  try {
    const repo = join(home, "code/repo");
    const tree = join(worktrees, "feature");
    const hidden = join(home, "Library/vendor/repo");
    // A package cache can hold a `.git` file that git rejects (exit 128).
    const vendored = join(home, "code/cache/pkg");
    const inner = join(vendored, "inner");
    for (const root of [repo, tree, hidden, inner]) {
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(join(root, "node_modules"));
    }
    await writeFile(join(vendored, ".git"), "gitdir:");
    await mkdir(join(vendored, "node_modules"));
    const { host } = fake((command) => {
      if (command.file !== "git") return undefined;
      if (command.args.includes("worktree") && command.args[1] === vendored)
        throw exit(128);
      if (command.args.includes("worktree"))
        return command.args[1] === repo
          ? `worktree ${repo}\nHEAD 1a2b\nbranch refs/heads/main\n\nworktree ${tree}\nHEAD 3c4d\nbranch refs/heads/feature\n`
          : "";
      throw new Error(`fatal: not a git repository: ${command.args[1]}`);
    });
    const plan = await new ProjectArtifactsCleanup(
      task("dependencies", "routine"),
      inventory(home),
      "dependencies",
      7,
      new PathPolicy([home, worktrees], []),
    ).inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    const seen = plan.notes.join("\n");
    assert.ok(seen.includes(join(repo, "node_modules")));
    assert.ok(seen.includes(join(tree, "node_modules")));
    assert.ok(!seen.includes(hidden));
    assert.ok(seen.includes(join(inner, "node_modules")));
    assert.ok(!seen.includes(join(vendored, "node_modules")));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(worktrees, { recursive: true, force: true });
  }
});

test("launch-agents fails closed when launchctl fails for another reason", async () => {
  const home = await temporaryHome();
  try {
    const agents = join(home, "LaunchAgents");
    await mkdir(agents);
    const plist = join(agents, "agent.plist");
    await writeFile(plist, "");
    const { host } = fake((command) => {
      if (command.file === "plutil")
        return JSON.stringify({
          Label: "x.agent",
          Program: join(home, "gone"),
        });
      if (command.file === "launchctl") throw exit(5);
      return undefined;
    });
    const plan = await new LaunchAgentsCleanup(
      task("launch-agents", "explicit"),
      agents,
      501,
      inventory(home),
      new PathPolicy([home], []),
    ).inspect(context(host, "preview", []));
    assert.match(plan.error ?? "", /exit 5/);
    assert.equal(plan.actions.length, 0);
    assert.equal(await exists(plist), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** Two unowned folders untouched for 200 days, one owned folder, and one used last week. */
async function orphanFixture(home: string) {
  const paths = {
    big: join(home, ".bigorphan"),
    small: join(home, ".smallorphan"),
    owned: join(home, ".toolcmd"),
    recent: join(home, ".recentorphan"),
  };
  for (const path of Object.values(paths)) {
    await mkdir(path);
    await writeFile(join(path, "data"), "x");
    await age(join(path, "data"), 200);
    await age(path, 200);
  }
  await age(join(paths.recent, "data"), 7);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "toolcmd"), "#!/bin/sh\n", { mode: 0o755 });
  const { host } = fake((command) => {
    if (command.file === "du")
      return `${command.args.at(-1) === paths.big ? 8 : 4}\t${command.args.at(-1)}\n`;
    if (["brew", "uv", "ps"].includes(command.file)) return "";
    return undefined;
  });
  const cleanup = new OrphanedAppDataCleanup(
    task("orphaned-app-data", "explicit"),
    inventory(home, { pathDirs: [bin] }),
    90,
    new PathPolicy([home], []),
  );
  return { paths, host, cleanup };
}

test("orphaned-app-data removes nothing without --select and lists candidates for review, largest first", async () => {
  const home = await temporaryHome();
  try {
    const { paths, host, cleanup } = await orphanFixture(home);
    const report = await new CleanupRun([cleanup], home).run(
      context(host, "apply", ["orphaned-app-data"]),
      () => {},
    );
    assert.deepEqual(report.items, []);
    const reviews = report.tasks[0].notes.filter((note) =>
      note.startsWith("Review: "),
    );
    assert.equal(reviews.length, 2);
    assert.ok(reviews[0].startsWith(`Review: ${paths.big} — `));
    assert.match(
      reviews[1],
      /^Review: .*\.smallorphan — 0\.00 GiB, last used \d{4}-\d{2}-\d{2}; no owner among/,
    );
    for (const path of Object.values(paths))
      assert.equal(await exists(path), true, path);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orphaned-app-data never removes a selected path that is owned, recent or not a candidate", async () => {
  const home = await temporaryHome();
  try {
    const { paths, host, cleanup } = await orphanFixture(home);
    const elsewhere = join(home, "Documents");
    const report = await new CleanupRun([cleanup], home).run(
      context(
        host,
        "apply",
        ["orphaned-app-data"],
        [],
        [paths.owned, paths.recent, elsewhere, home],
      ),
      () => {},
    );
    assert.deepEqual(report.items, []);
    const notes = report.tasks[0].notes;
    assert.ok(
      notes.includes(
        `Not removed: ${paths.owned}: an installed owner matches its name`,
      ),
    );
    assert.ok(
      notes.includes(`Not removed: ${paths.recent}: used within 90 days`),
    );
    assert.ok(
      notes.some((note) =>
        note.startsWith(`Not removed: ${elsewhere}: not a candidate`),
      ),
    );
    // Selecting a parent folder approves none of the candidates inside it.
    assert.ok(
      notes.some((note) =>
        note.startsWith(`Not removed: ${home}: not a candidate`),
      ),
    );
    for (const path of Object.values(paths))
      assert.equal(await exists(path), true, path);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orphaned-app-data removes only the selected candidate and keeps its siblings", async () => {
  const home = await temporaryHome();
  try {
    const { paths, host, cleanup } = await orphanFixture(home);
    const report = await new CleanupRun([cleanup], home).run(
      context(host, "apply", ["orphaned-app-data"], [], [paths.small]),
      () => {},
    );
    assert.deepEqual(
      report.items.map((item) => [item.target, item.status]),
      [[paths.small, "completed"]],
    );
    assert.equal(await exists(paths.small), false);
    for (const path of [paths.big, paths.owned, paths.recent])
      assert.equal(await exists(path), true, path);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orphaned-app-data refuses a selected candidate that is used before removal", async () => {
  const home = await temporaryHome();
  try {
    const { paths, host, cleanup } = await orphanFixture(home);
    const plan = await cleanup.inspect(
      context(host, "preview", [], [], [paths.small]),
    );
    assert.deepEqual(
      plan.actions.map((action) => action.view.target),
      [paths.small],
    );
    await writeFile(join(paths.small, "new"), "used again");
    await assert.rejects(
      plan.actions[0].execute(
        context(host, "apply", ["orphaned-app-data"], [], [paths.small]),
        task("orphaned-app-data", "explicit"),
      ),
      /Used within 90 days/,
    );
    assert.equal(await exists(paths.small), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the CLI refuses a relative --select path before it inspects anything", () => {
  // The suite runs from dist/test; the CLI is the TypeScript entry at the repo root.
  const cli = join(import.meta.dirname, "../../cleanup.ts");
  const run = spawnSync(process.execPath, [cli, "--select", "relative/path"], {
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--select needs absolute paths: relative\/path/);
  assert.doesNotMatch(run.stderr, /Inspecting/);
});

/** An installed app in the temp home's Applications folder. */
async function installApp(home: string, name: string) {
  await mkdir(join(home, `Applications/${name}.app/Contents`), {
    recursive: true,
  });
  await writeFile(
    join(home, `Applications/${name}.app/Contents/Info.plist`),
    "",
  );
}

async function oldFile(path: string, content = "x") {
  await writeFile(path, content);
  await age(path, 30);
}

test("installers names the installed app, keeps recent ones, and scans only the top level", async () => {
  const home = await temporaryHome();
  try {
    await installApp(home, "Hoy");
    for (const folder of ["Downloads", "Desktop", "Documents/project/dist"])
      await mkdir(join(home, folder), { recursive: true });
    await oldFile(join(home, "Downloads/Hoy-0-9-5-arm64.dmg"));
    await oldFile(join(home, "Desktop/Other-2.pkg"));
    await writeFile(join(home, "Downloads/Hoy-1-0.dmg"), "recent");
    await oldFile(join(home, "Documents/project/dist/Build-1.dmg"));
    const { host } = fake((command) =>
      command.file === "plutil"
        ? plist(
            { CFBundleIdentifier: "dk.heyiam.hoy", CFBundleName: "Hoy" },
            command,
          )
        : undefined,
    );
    const plan = await new InstallerFilesCleanup(
      task("installers", "explicit"),
      [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")],
      7,
      inventory(home),
      new PathPolicy([home], []),
    ).inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    assert.deepEqual(
      plan.actions
        .map((action) => [action.view.target, action.view.reason])
        .sort(),
      [
        [
          join(home, "Desktop/Other-2.pkg"),
          "Old installer; no matching app installed",
        ],
        [
          join(home, "Downloads/Hoy-0-9-5-arm64.dmg"),
          "Installer; installed as Hoy.app",
        ],
      ],
    );
    assert.ok(
      plan.notes.includes(
        `Recent installer: ${join(home, "Downloads/Hoy-1-0.dmg")} (Installer; installed as Hoy.app)`,
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("installers takes a .zip only when it holds just an installed app", async () => {
  const home = await temporaryHome();
  try {
    await installApp(home, "Hoy");
    await mkdir(join(home, "Downloads"));
    for (const name of ["Hoy.zip", "notes.zip", "Gone.zip"])
      await oldFile(join(home, "Downloads", name));
    const listings: Record<string, string> = {
      "Hoy.zip": "Hoy.app/\nHoy.app/Contents/Info.plist\n__MACOSX/._Hoy.app\n",
      "notes.zip": "notes.txt\n",
      "Gone.zip": "Gone.app/\nGone.app/Contents/Info.plist\n",
    };
    const { host } = fake((command) => {
      if (command.file === "plutil")
        return plist(
          { CFBundleIdentifier: "dk.heyiam.hoy", CFBundleName: "Hoy" },
          command,
        );
      if (command.file === "zipinfo")
        return listings[command.args.at(-1)!.split("/").at(-1)!];
      return undefined;
    });
    const plan = await new InstallerFilesCleanup(
      task("installers", "explicit"),
      [join(home, "Downloads")],
      7,
      inventory(home),
      new PathPolicy([home], []),
    ).inspect(context(host, "preview", []));
    assert.equal(plan.error, null);
    assert.deepEqual(
      plan.actions.map((action) => [action.view.target, action.view.reason]),
      [[join(home, "Downloads/Hoy.zip"), "App archive; installed as Hoy.app"]],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("macos-installers removes installers not newer than this Mac and keeps newer or unknown ones", async () => {
  const home = await temporaryHome();
  try {
    const applications = join(home, "Applications");
    for (const name of ["Tahoe", "Future", "Mystery"])
      await mkdir(join(applications, `Install macOS ${name}.app/Contents`), {
        recursive: true,
      });
    await mkdir(join(applications, "Notes.app"));
    const { host } = fake((command) => {
      if (command.file === "softwareupdate")
        return "Software Update found the following full installers:\n* Title: macOS Tahoe, Version: 26.7.2, Size: 1KiB, Build: 25G332, Deferred: NO\n* Title: macOS Future, Version: 28.0, Size: 1KiB, Build: 27A1, Deferred: NO\n";
      if (command.file === "sw_vers") return "27.2\n";
      return undefined;
    });
    const cleanup = new MacOSInstallersCleanup(
      task("macos-installers", "explicit"),
      applications,
    );
    const report = await new CleanupRun([cleanup], home).run(
      context(host, "apply", ["macos-installers"]),
      () => {},
    );
    assert.deepEqual(
      report.items.map((item) => [item.target, item.status]),
      [[join(applications, "Install macOS Tahoe.app"), "completed"]],
    );
    assert.deepEqual(report.tasks[0].notes.sort(), [
      `Newer than this Mac (28 > 27), kept: ${join(applications, "Install macOS Future.app")}`,
      `Version unknown, kept: ${join(applications, "Install macOS Mystery.app")}`,
    ]);
    assert.equal(
      await exists(join(applications, "Install macOS Tahoe.app")),
      false,
    );
    for (const name of [
      "Install macOS Future.app",
      "Install macOS Mystery.app",
      "Notes.app",
    ])
      assert.equal(await exists(join(applications, name)), true, name);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("macos-installers proposes nothing when softwareupdate fails", async () => {
  const home = await temporaryHome();
  try {
    const applications = join(home, "Applications");
    await mkdir(join(applications, "Install macOS Tahoe.app"), {
      recursive: true,
    });
    const { host } = fake((command) => {
      if (command.file === "softwareupdate") throw exit(1);
      return undefined;
    });
    const plan = await new MacOSInstallersCleanup(
      task("macos-installers", "explicit"),
      applications,
    ).inspect(context(host, "preview", []));
    assert.match(plan.error ?? "", /exit 1/);
    assert.equal(plan.actions.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
