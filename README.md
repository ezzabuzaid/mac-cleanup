# mac-cleanup

A Mac fills up with caches, old app data, unused Node versions and leftovers of apps you removed. This tool finds them on **your** machine, shows you what it found, and removes only what you allow.

It does not use a list of known paths. Each task **learns from the machine**: the installed apps, the commands on `PATH`, Homebrew, your git projects, nvm, Docker, and running processes. Each removal is checked again immediately before it runs.

macOS only. Node LTS (see `.nvmrc`). No runtime dependencies.

## Use

```sh
node cleanup.ts                       # preview: read-only, the default
node cleanup.ts --list                # the tasks
node cleanup.ts --details             # print every target
node cleanup.ts --report reports/preview.json
```

Apply the routine tasks you want:

```sh
node cleanup.ts --apply --only npm,uv,pip,brew-downloads
```

An **explicit** task removes things that are not plain caches. It also needs its ID in `--allow`:

```sh
node cleanup.ts --preview --only launch-agents
node cleanup.ts --apply --only launch-agents --allow launch-agents
```

`orphaned-app-data` only proposes. Its preview lists each candidate with its size, last use and the owner sources it checked. It removes only the candidates you name exactly for that run with `--select` (a parent folder approves nothing):

```sh
node cleanup.ts --preview --only orphaned-app-data
node cleanup.ts --apply --only orphaned-app-data --allow orphaned-app-data --select "$HOME/.exo,$HOME/Library/Application Support/sst"
```

Keep anything for one run with `--keep` (absolute paths). A target inside a kept path is skipped:

```sh
node cleanup.ts --apply --only orphaned-app-data --allow orphaned-app-data --keep "$HOME/.venvs"
```

Rules:

- `--allow` never applies anything by itself. Use it with `--apply`.
- Each run discovers the targets again. A report is a record, not a plan to replay.
- A report file is never overwritten. Use a new name each time. `reports/` is ignored by git.
- A tool that is not installed (Docker, nvm, uv) makes its task "unconfigured", not failed.
- A nonzero exit means a task could not inspect or an action failed. The JSON report has the error.

## Tasks

| #   | Task IDs                             | What it learns and removes                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `docker-build-cache`                 | The current Docker context (`docker context show`). Only a local Unix-socket engine. Prunes the build cache of its own builder.                                                                                                                                                                                                                                                                             |
| 2   | `docker-images`                      | Unused pulled images (with a registry digest, used by no container). Never `--force`.                                                                                                                                                                                                                                                                                                                       |
| 3   | `docker-system`                      | Explicit. `docker system prune --all`, never `--volumes`. Checks that no volume disappears.                                                                                                                                                                                                                                                                                                                 |
| 4   | `npm`                                | npm's own `cache clean`. The `_npx` folder is kept.                                                                                                                                                                                                                                                                                                                                                         |
| 5   | `uv`, `pip`                          | Their own cache commands.                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | `brew-downloads`, `brew-maintenance` | Downloaded archives. Explicit `brew cleanup` for old installed versions.                                                                                                                                                                                                                                                                                                                                    |
| 7   | `dependencies`                       | `node_modules` in git projects under your home folder and in every worktree git lists. Only if git ignores it, the project has a lockfile and no recent activity (7 days).                                                                                                                                                                                                                                  |
| 8   | `nx-cache`, `builds`                 | Nx cache entries older than one day. Ignored `dist`, `build`, `out`, `.build` folders in inactive projects.                                                                                                                                                                                                                                                                                                 |
| 9   | `app-caches`                         | VS Code downloaded extension archives.                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | `staged-updates`, `installers`       | Staged updates of installed apps (Sparkle, Squirrel/ShipIt, Docker Desktop) that are not newer than the installed version. Explicit: old `.dmg`/`.pkg` files in Downloads.                                                                                                                                                                                                                                  |
| 11  | `chrome-clones`                      | Old Chrome code-sign clones that match the installed Chrome.                                                                                                                                                                                                                                                                                                                                                |
| 12  | `wallpapers`                         | Explicit. Downloaded aerial wallpaper videos.                                                                                                                                                                                                                                                                                                                                                               |
| 13  | `trash`                              | Explicit. Trash items older than 30 days (Finder's own rule).                                                                                                                                                                                                                                                                                                                                               |
| 14  | `simulators`                         | Explicit. Runtimes that `simctl` calls outdated. Refuses while a simulator is booted.                                                                                                                                                                                                                                                                                                                       |
| 15  | `restart`                            | Explicit. An orderly macOS restart to release swap. Swap files are never deleted.                                                                                                                                                                                                                                                                                                                           |
| 16  | `nx-temp-installs`                   | `/private/tmp/tmp-<pid>-*` folders that hold an Nx install, owned by you, whose process has exited.                                                                                                                                                                                                                                                                                                         |
| 17  | `dangling-links`                     | Explicit. Symlinks in `PATH` folders whose target is gone. Links in root-owned folders get a `sudo rm` note; links in Homebrew's prefix get a `brew cleanup --prune-prefix` note.                                                                                                                                                                                                                           |
| 18  | `node-versions`                      | Explicit. nvm versions that are not the default and that no `.nvmrc` or `.node-version` in your projects asks for. nvm resolves and uninstalls. A version in use is kept.                                                                                                                                                                                                                                   |
| 19  | `launch-agents`                      | Explicit. `~/Library/LaunchAgents` plists whose program is missing, or that name no program. A loaded agent is kept, with the `launchctl bootout` command.                                                                                                                                                                                                                                                  |
| 20  | `orphaned-app-data`                  | Explicit, and only on `--select`. Proposes folders in `~/Library/Application Support` and hidden folders in `~` that no installed app, command, Homebrew package, VS Code extension, uv tool or process owns, that `PATH`, the environment and your shell startup files do not name, and with no modify or access time inside newer than 90 days. A selected path that is owned or recent is never removed. |

macOS keeps no record that an app was abandoned, so the machine proposes and you confirm. The owner match is loose on purpose: a wrong "owned" only keeps a folder.

## Workflows

A workflow is an opt-in task for one situation on your machine. It is not in the default run. Its targets come from a JSON file that you keep outside the repo:

```sh
node cleanup.ts --workflow sqlite-relocation --input ~/sqlite.json            # preview
node cleanup.ts --workflow sqlite-relocation --input ~/sqlite.json --apply --allow sqlite-relocation
```

| Workflow               | Input file                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sqlite-relocation`    | `{ "source": "/abs/history.sqlite", "destination": "/Volumes/Ext/history.sqlite", "envFile": "/abs/project/.env" }` |
| `airbyte`              | `{ "containerIds": ["…"], "volumeNames": ["…"] }`                                                                   |
| `docker-offload`       | `{ "destination": "my-ssh-context" }`                                                                               |
| `duplicate-references` | `{ "groups": [{ "original": "/abs/ref.gtf.gz", "copies": "/abs/work/*/ref.gtf", "olderThanDays": 7 }] }`            |

A missing or wrong field stops the run before anything is inspected, and the error names the field. `--workflow` cannot be combined with `--only` or `--select`.

## Layout

```
cleanup.ts          CLI
profile.ts          the default run: which tasks, with which policy
src/run/            lifecycle: Host, Context, CleanupAction, CleanupTask, CleanupRun
src/paths/          PathPolicy, removal with identity checks, walk
src/machine/        MachineInventory: facts learned from this machine
src/tasks/<area>/   one task per file: packages, projects, docker, macos, node, links, residue, selected
workflows/          opt-in workflows and their input reader; nothing in src/ imports them
```

## Guards

- Preview never mutates. A direct `execute` in preview throws.
- Every path must be inside an owned root (home, the temp folders) and outside the protected paths (credentials, cloud-synced folders, npx installs). Symlinked paths are refused.
- Immediately before a removal: the target must be unchanged since inspection, no process may have a file open in it (`lsof`), and the task's own rule must still hold.
- Native tools do the work where they exist (npm, uv, pip, brew, docker, simctl, nvm). No shell string is evaluated.
- Estimates overlap and do not count APFS clones or shared Docker layers. The report records the observed free-space change separately.

## API

The ready composition is `profile.ts`:

```ts
import { cleanup } from "./profile.ts";
import { LocalHost } from "./src/core.ts";

const report = await cleanup.run(
  {
    mode: "preview",
    host: new LocalHost(60_000),
    signal: AbortSignal.timeout(10 * 60_000),
    allowed: new Set(),
    kept: [],
  },
  console.log,
);
```

`CleanupTask.inspect()` owns discovery and error reporting. `CleanupAction.execute()` owns mode, permission, guard, mutation and verification order. `MachineInventory` learns the machine once per run. `PathPolicy` holds the shared path and open-file checks.

## Develop

```sh
npm ci
npx nx run disk-cleanup:typecheck   # prettier, eslint, tsc
npx nx run disk-cleanup:test        # build, then node --test
```

`REVIEW.md` records the design review and each removal.

## License

MIT
