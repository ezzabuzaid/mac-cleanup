import { homedir, tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { MachineInventory } from "./src/machine/inventory.ts";
import { PathPolicy } from "./src/paths/policy.ts";
import { CleanupRun } from "./src/run/run.ts";
import { type TaskIdentity } from "./src/run/task.ts";
import { DockerCleanup } from "./src/tasks/docker/docker-cleanup.ts";
import { DanglingLinksCleanup } from "./src/tasks/links/dangling-links.ts";
import { ChromeClonesCleanup } from "./src/tasks/macos/chrome-clones.ts";
import { LaunchAgentsCleanup } from "./src/tasks/macos/launch-agents.ts";
import { RestartCleanup } from "./src/tasks/macos/restart.ts";
import { SimulatorRuntimesCleanup } from "./src/tasks/macos/simulators.ts";
import { ObsoleteAppUpdatesCleanup } from "./src/tasks/macos/staged-updates.ts";
import { NodeVersionsCleanup } from "./src/tasks/node/node-versions.ts";
import { HomebrewMaintenanceCleanup } from "./src/tasks/packages/homebrew-maintenance.ts";
import { PackageCacheCleanup } from "./src/tasks/packages/package-cache.ts";
import { NxTempInstallsCleanup } from "./src/tasks/projects/nx-temp-installs.ts";
import { ProjectArtifactsCleanup } from "./src/tasks/projects/project-artifacts.ts";
import { OrphanedAppDataCleanup } from "./src/tasks/residue/orphaned-app-data.ts";
import { InstallerFilesCleanup } from "./src/tasks/installers/installer-files.ts";
import { MacOSInstallersCleanup } from "./src/tasks/installers/macos-installers.ts";
import { SelectedPathsCleanup } from "./src/tasks/selected/selected-paths.ts";

const home = homedir();
const temporary = tmpdir();
const caches = join(home, "Library/Caches");
const support = join(home, "Library/Application Support");
const uid = process.getuid?.();
if (uid === undefined) throw new Error("disk-cleanup runs on macOS");

/** Everything below is learned from this machine when a task runs. */
const inventory = new MachineInventory({
  home,
  applicationDirs: [
    "/Applications",
    join(home, "Applications"),
    "/System/Applications",
  ],
  pathDirs: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
  env: process.env,
});

export const policy = new PathPolicy(
  [
    home,
    dirname(temporary),
    // Nx daemon installs (NxTempInstallsCleanup) live here.
    "/private/tmp",
    "/Library/Application Support/com.apple.idleassetsd",
  ],
  [
    // Credentials.
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    // npm keeps npx installs next to its cache.
    join(home, ".npm/_npx"),
    // Cloud-synced folders: removing a local copy can remove the remote one.
    join(home, "Library/CloudStorage"),
    join(home, "Library/Mobile Documents"),
  ],
);

const routine = (
  id: string,
  name: string,
  methods: number[],
): TaskIdentity => ({ id, name, methods, permission: "routine" });
const explicit = (
  id: string,
  name: string,
  methods: number[],
): TaskIdentity => ({ id, name, methods, permission: "explicit" });

/** Template Method supplies lifecycle; composition supplies policies and learned facts. */
export const cleanup = new CleanupRun(
  [
    new DockerCleanup(
      routine("docker-build-cache", "Unused Docker build cache", [1]),
      "build-cache",
    ),
    new DockerCleanup(
      routine("docker-images", "Unused downloaded Docker images", [2]),
      "images",
    ),
    new DockerCleanup(
      explicit("docker-system", "Broad Docker prune, without volumes", [3]),
      "system",
    ),
    new PackageCacheCleanup(
      routine("npm", "npm download cache, preserving npx", [4]),
      "npm",
      null,
      policy,
    ),
    new PackageCacheCleanup(
      routine("uv", "uv download cache", [5]),
      "uv",
      null,
      policy,
    ),
    new PackageCacheCleanup(
      routine("pip", "pip download cache", [5]),
      "pip",
      null,
      policy,
    ),
    new SelectedPathsCleanup(
      routine("brew-downloads", "Homebrew downloaded archives", [6]),
      [
        {
          path: join(caches, "Homebrew/downloads"),
          select: "children",
          olderThanDays: 1,
          reason: "Re-downloadable Homebrew archive",
        },
      ],
      policy,
    ),
    new HomebrewMaintenanceCleanup(
      explicit(
        "brew-maintenance",
        "Homebrew obsolete installed versions and downloads",
        [6],
      ),
    ),
    new ProjectArtifactsCleanup(
      routine(
        "dependencies",
        "Inactive project and worktree node_modules",
        [7],
      ),
      inventory,
      "dependencies",
      7,
      policy,
    ),
    new ProjectArtifactsCleanup(
      routine("nx-cache", "Nx task cache entries older than 24 hours", [8]),
      inventory,
      "nx",
      1,
      policy,
    ),
    new ProjectArtifactsCleanup(
      routine("builds", "Ignored builds in inactive projects", [8]),
      inventory,
      "builds",
      7,
      policy,
    ),
    new SelectedPathsCleanup(
      routine("app-caches", "VS Code downloaded extension archives", [9]),
      [
        {
          path: join(support, "Code/CachedExtensionVSIXs"),
          select: "children",
          olderThanDays: 1,
          reason:
            "VS Code downloaded extension archive; installed extensions preserved",
        },
      ],
      policy,
    ),
    new ObsoleteAppUpdatesCleanup(
      routine("staged-updates", "Obsolete staged application updates", [10]),
      inventory,
      caches,
      support,
    ),
    new InstallerFilesCleanup(
      explicit("installers", "Old installers and app archives", [10]),
      [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")],
      7,
      inventory,
      policy,
    ),
    new MacOSInstallersCleanup(
      explicit(
        "macos-installers",
        "macOS installers not newer than this Mac",
        [10],
      ),
      "/Applications",
    ),
    new ChromeClonesCleanup(
      routine("chrome-clones", "Stale Chrome code-sign clones", [11]),
      join(dirname(temporary), "X/com.google.Chrome.code_sign_clone"),
      inventory,
      policy,
    ),
    new SelectedPathsCleanup(
      explicit("wallpapers", "Downloaded aerial wallpapers", [12]),
      [
        {
          path: "/Library/Application Support/com.apple.idleassetsd/Customer/4KSDR240FPS",
          select: "children",
          olderThanDays: 1,
          reason:
            "Re-downloadable aerial wallpaper; macOS may download it again",
        },
      ],
      policy,
    ),
    new SelectedPathsCleanup(
      explicit("trash", "Trash items older than 30 days", [13]),
      [
        {
          path: join(home, ".Trash"),
          select: "children",
          // Finder's own "Remove items from the Trash after 30 days" rule.
          olderThanDays: 30,
          reason: "In the Trash for more than 30 days",
        },
      ],
      policy,
    ),
    new SimulatorRuntimesCleanup(
      explicit("simulators", "Superseded simulator runtimes", [14]),
    ),
    new RestartCleanup(
      explicit("restart", "Orderly macOS restart to release swap", [15]),
    ),
    new NxTempInstallsCleanup(
      routine("nx-temp-installs", "Nx installs left by exited daemons", [16]),
      "/private/tmp",
      uid,
      policy,
    ),
    new DanglingLinksCleanup(
      explicit("dangling-links", "Links on PATH to missing targets", [17]),
      inventory,
      policy,
    ),
    new NodeVersionsCleanup(
      explicit("node-versions", "nvm Node versions nothing asks for", [18]),
      inventory,
      policy,
    ),
    new LaunchAgentsCleanup(
      explicit("launch-agents", "LaunchAgents with a missing program", [19]),
      join(home, "Library/LaunchAgents"),
      uid,
      inventory,
      policy,
    ),
    new OrphanedAppDataCleanup(
      explicit(
        "orphaned-app-data",
        "App data with no installed owner, untouched for 90 days",
        [20],
      ),
      inventory,
      90,
      policy,
    ),
  ],
  home,
);
