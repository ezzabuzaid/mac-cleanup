# Implementation and removal review

## Scope recorded before implementation

The workspace was empty: zero source files, consumers, existing tests, or baseline checks. This is an additive implementation of the 24 historical methods. No existing behavior is being removed. No staging or commits are authorized.

Candidates to avoid or remove as classes are added: custom process spawning and timeout loops; handwritten package-cache deletion when a native CLI provides it; recursive deletion implementations; duplicated preview/apply/report flows; one-line subclasses that only change a path; custom SQLite backup engines; wrappers around wrappers; duplicated path and open-file checks.

Retain: exact-target validation, protection of user data, explicit local Docker context, preservation of Docker volumes in routine tasks, inactive-project checks, target revalidation, cancellation, and accurate failure reporting. These are live constraints from the source chats.

## Capability discovery

- Node: `execFile` with timeout and AbortSignal, `fs.rm`, `fs.glob`, `statfs`, `util.parseArgs`, `util.parseEnv`, `node:sqlite` DatabaseSync/backup; runtime exports probed on Node 26.10.0.
- npm: `cache clean --force`; installed config definitions lines 429-430 derive separate `_cacache` and `_npx` locations. Retain native cleanup.
- uv: `cache dir`, `cache clean`, `--cache-dir`, `--offline`; never use `--force` (it disables in-use checks).
- pip: `cache dir`, `cache purge`; Homebrew: `--cache`, `cleanup --dry-run`, `cleanup`. The latter also removes old installed versions, so whole download-cache deletion and native maintenance remain distinct operations.
- Docker: explicit `--context`, JSON inventory/inspect, image removal by ID, buildx prune, system prune without `--volumes`. Preserve volumes by before/after inventory, not by trusting a size estimate.
- simctl: `runtime delete --outdated --dry-run` and `runtime delete <id>`. Native help says it can shut down booted devices: a booted-device guard is necessary. Initial sandbox probe could not connect to CoreSimulator; this is an access limitation, not evidence that no runtimes exist.
- Mole installed source inspected: purge has dry-run and artifact-activity checks, but its artifact-only age rule is not whole-project inactivity. REJECTED as replacement for that policy. Broad clean/uninstall also exceeds the selected paths and per-task reporting contract.
- Airbyte: official https://github.com/airbytehq/abctl documents `local uninstall --persisted`; retained only for explicitly configured Airbyte removal.

## Proof plan

For each class: review owned behavior and composition before proceeding; execute focused tests once its dependencies exist. Preview must never invoke mutation, changed/in-use/protected paths must survive, command errors must not become empty success, Docker volumes must survive, and SQLite relocation must preserve content and update only the selected setting. Native destructive commands will be exercised with injected hosts; real-machine execution is preview only. No claim of live deletion verification will be made.

## Verdict

Retain the common lifecycle and domain guards. The task is a new program, so the result is necessarily additive. Native APIs own process execution, timeouts, cancellation, recursive removal, CLI parsing, SQLite backup, and package-manager cleanup. No runtime dependency was introduced to replace a small local function.

### Removed

- Removed the unused `findNamedDirectories` scaffold after explicit custom-cache selections supplied the actual caller contract. It had zero callers; module loading/typechecking and the coverage test still pass. No public API had been shipped.
- Inlined the one-use `contextLabel` method. The Docker prune test asserts the observable report target remains `Docker local/system`.
- Removed a test-helper default for allowed task IDs; 26 callers now pass the decision explicitly. All tests pass unchanged in meaning.
- Moved artifact name filtering before `lstat`, removing one filesystem call for every irrelevant source file. Selected candidate type checks remain; the monorepo activity fixture still protects a recently edited sibling. The initial live preview was intentionally interrupted through its own PID before rerunning.
- Replaced the inadequate boolean version comparison with an ordered comparison. This is a correction to new code, not a behavior-preserving removal: fixtures demonstrate that equivalent numeric versions still compare build numbers and unknown metadata is retained.
- Old-shape search over source/tests returns zero occurrences of the removed helper/method/default/comparator names. There was no pre-existing repository implementation or test suite to preserve.

### Net delta

Measured against the empty workspace: **3,260 authored code/config/test lines added, 0 pre-existing lines deleted** (2,454 application, 720 tests, 86 config). The dependency lockfile adds 3,156 generated lines. Documentation, preview reports, installed dependencies, Nx state, and generated `dist` files are excluded from this source-line measure. Session-local removals above reduce the new implementation, but are not represented as pre-existing deletions.

The additive scope implements the requested OOP API, 24 method registrations, native adapters, and focused behavioral tests. TypeScript constructor field declarations are retained because direct Node execution requires erasable TypeScript; parameter properties would require transpilation at runtime.

### Retained: class-by-class DRY review

| Class                         | Review and retained responsibility                                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalHost`                   | One native `execFile` adapter; no shell interpolation, custom timer, process polling, retry, or timeout loop. Timeout and nonzero-exit tests execute real owned child processes.                                                                                                         |
| `Ineligible`                  | Distinguishes a guard rejection from an execution failure. It preserves skipped/failed reporting semantics.                                                                                                                                                                              |
| `CleanupAction`               | Template Method owns preview, authorization, cancellation, check/perform/verify order once. Direct execution in preview is tested to fail.                                                                                                                                               |
| `CommandAction`               | Composition of the native command and domain guards; avoids a subclass for each CLI invocation.                                                                                                                                                                                          |
| `CleanupTask`                 | One discovery/error boundary. A discovery failure cannot silently become an empty successful plan.                                                                                                                                                                                       |
| `CleanupRun`                  | One ordered task runner and report accumulator, with unique IDs and independent error reporting. Filesystem delta is observed, never confused with estimated reclaim.                                                                                                                    |
| `PathPolicy`                  | Shared containment, protected-ancestor, symlink, and open-file constraints. Preview shares an open-file snapshot; apply refreshes it. Separate narrow updater roots preserve Dia's browser cache.                                                                                        |
| `RemovePathAction`            | Uses native `fs.rm`; keeps identity and guard revalidation. File deletion, changed-target refusal, open-file refusal, and untouched sibling are tested with temporary fixtures.                                                                                                          |
| `PackageCacheCleanup`         | Three package-manager protocols share one lifecycle. npm uses its own `_cacache` scope; `_npx` content is tested to survive. No handwritten package-store GC.                                                                                                                            |
| `HomebrewMaintenanceCleanup`  | Native `brew cleanup --dry-run` supplies discovery. Separate from cache-only archive cleanup because installed-version removal is a materially different user choice.                                                                                                                    |
| `SelectedPathsCleanup`        | One selection implementation covers caches, temp files, wallpapers, Trash, logs, models, residue, and task artifacts. No directory-name subclasses.                                                                                                                                      |
| `DownloadedInstallersCleanup` | Distinct extension/age discovery; reuses the removal action. Age is not represented as proof the installer is unwanted, so the profile requires explicit permission.                                                                                                                     |
| `ProjectArtifactsCleanup`     | Dependency, Nx, and build discovery share Git/path checks. Lockfile and whole-repository activity checks remain meaningful; a recent sibling fixture prevents removal. Unexpected tool failures now propagate, while non-repository/not-ignored candidates are classified as ineligible. |
| `LocalDocker`                 | One context-bound command/inventory adapter. Every cleanup command names the local context; the local Buildx builder is independently verified.                                                                                                                                          |
| `DockerCleanup`               | Shared native prune and image-selection lifecycle. Tests cover referenced images, locally built-only images, local-only context, builder binding, no forced image removal, and detection of lost volumes.                                                                                |
| `ObsoleteAppUpdatesCleanup`   | Bundle-specific selection remains separate from generic age selection. Metadata completeness, version ordering, and build ordering are tested.                                                                                                                                           |
| `ChromeClonesCleanup`         | Exact clone shape, bundle identity, installed version, age and open-file checks justify separate discovery; removal is shared.                                                                                                                                                           |
| `SimulatorRuntimesCleanup`    | Native outdated selection plus booted-device protection; fixtures cover booted devices and the exact native no-match protocol (exit 2 plus the matching stderr). Other service errors remain failures.                                                                                   |
| `DuplicateReferencesCleanup`  | Native streaming/gunzip/hash primitives prove equality; generic removal does not know gzip semantics. Equal/different copies and preservation of the original are tested.                                                                                                                |
| `AirbyteRemovalCleanup`       | Native abctl owns application removal. Configured ownership inventory supplies postconditions; null configuration produces no actions. No generic uninstall framework was invented.                                                                                                      |
| `DockerOffloadCleanup`        | Verified context-selection workflow only. It deliberately reports zero recovery and does not claim to migrate databases or volumes. Preview tests prove no context mutation.                                                                                                             |
| `RestartCleanup`              | macOS owns restart; the command's acceptance is the observable, not a claimed completed reboot. Preview reads swap only.                                                                                                                                                                 |
| `SqliteRelocationAction`      | Native `backup` owns database copying. The action coordinates exclusive destination creation, integrity, environment replacement, and source removal. Real fixture rows and unrelated configuration survive. WAL/existing destination/changed configuration are refused.                 |
| `SqliteRelocationCleanup`     | Typed configuration and read-only discovery; uses the relocation action for execution. Unconfigured state remains visible.                                                                                                                                                               |

Retained containers: source modules, the public composition in `profile.ts`, runnable CLI, Nx targets, focused fixtures, README method catalog, and this review. No probe script, server, watcher, or agent-created long-running service is retained. Temporary test directories are removed by `node:test` cleanup hooks.

### Rejected

- **REJECTED** Mole's blanket cleanup: scope and project-age semantics do not match the requested selection contract.
- **REJECTED** a general plugin registry, DI container, factory hierarchy, or one class per folder: no consumer needs those layers.
- **REJECTED** broad `rm -rf` commands and manual deletion of swap, Docker VM disks, simulator directories, or SQLite files before backup.
- **REJECTED** `docker builder prune` as an implicitly context-bound primitive: installed help shows it aliases Buildx. The implementation explicitly names the builder and validates its driver/endpoint.
- **REJECTED** a guessed `pkgutil --compare-versions` capability: installed help exposes no such option. Numeric version comparison is narrow; unknown forms are retained.
- **REJECTED** native system prune with volumes, or forced image removal: would violate retained data/container constraints.
- **REJECTED** running historical one-off paths automatically: current target selection is required. Empty selections are reported as unconfigured.

### Self-audit

Searched new source for `??`, `||`, optional markers, defaults and compatibility branches. No nullish fallback or compatibility shim remains. Boolean ORs express guards, not substituted dependency values. Optional access on parser matches preserves honest absence, which rejects the candidate. CLI option absence is defined by `util.parseArgs`; choosing preview when `--apply` is absent is the deliberate execution boundary. `null` cache directories mean native configuration discovery, while `null` workflows mean unconfigured, not a fabricated value. Numeric version component zero-padding defines equivalent dotted versions; it does not fill missing bundle metadata. Test helper defaults were removed. No lint suppression was added.

### Unproven at initial implementation (2026-10-23)

- Real-machine destructive native commands were not executed. Docker, package-manager and simulator command contracts use injected hosts; real file removal and SQLite backup use isolated fixtures. There is no claim of live recovered bytes.
- Airbyte removal is unconfigured because current application ownership has not been selected. Its live uninstall and resource postconditions have not been exercised.
- Remote deployment/data migration is application-specific and outside the implemented context-switch step. A context switch is not represented as migration or local recovery.
- Restart acceptance cannot prove a successful reboot from the process requesting it.
- Open-file checks and path revalidation reduce races but do not provide a transactional lock over external applications or privileged processes.

### Unresolved

No pending user question or approval blocks the implemented preview. One-off path selections, Airbyte ownership, remote context and SQLite relocation remain explicit profile inputs; their current unconfigured status is visible in the preview report. No invented target ships silently.

## Executed checks

- `nx run disk-cleanup:typecheck`: passed formatter, ESLint and TypeScript checks.
- `nx run disk-cleanup:test`: build passed; **24/24 tests passed**, no skips.
- Runtime: Node 26.10.0. npm installed declared dev tools after offline metadata was unavailable. Installation and all check processes exited.
- The first CoreSimulator invocation refreshed its mismatched native service version and reported no matching images. A separate probe verified that its empty result is exit 2 with exact stderr; a targeted dry-run also verified successful candidate output on stdout. No runtime was deleted.
- Full-machine preview: results and exact limitations are recorded in the generated JSON report and the final response. No real cleanup action was authorized or executed during this implementation run.

## Final preview result

Completed 2026-10-23T10:02:01.811Z in 159.0 seconds, exit 0. The report contains 4,233 proposed actions across 28 tasks, 10 unconfigured tasks, and 0 inspection errors. All items have planned status. See [preview-final.json](./preview-final.json). No cleanup action executed.

Pending Docker and Dia updates were retained. No project dependencies passed the inactive-project policy. Apple marked no runtime image as superseded. All launched preview/check/test processes exited; the deliberately interrupted first preview also exited. No server or watcher remains owned by this task.

## 2026-10-29 configuration correction and live cleanup

Corrected the Codex updater's installed-app mapping from `/Applications/Codex.app` to `/Applications/ChatGPT.app`. The installed app and both staged copies have bundle ID `com.openai.codex`, version `26.1021.31345`, and build `21828`. The existing `ObsoleteAppUpdatesCleanup` handles the renamed bundle without another class or changes to its identity, version, path, and open-file checks. Generated apply reports now join preview reports in `.prettierignore`; their audit contents remain unchanged.

- `nx run disk-cleanup:typecheck`: formatter, lint, and type checks passed.
- `nx run disk-cleanup:test`: build and all 24 tests passed.
- [Preview](./preview-2026-10-29.json): 2,332 candidates across 28 tasks, with no inspection errors. Both obsolete updater copies were detected.
- [Apply](./apply-2026-10-29.json): 2,323 completed actions, 9 explicit actions skipped, no inspection errors, and no failed actions. Completed cleanup includes 2,301 Nx entries, 12 Docker images, Docker build cache, npm/uv/pip caches, one Homebrew archive, three extension archives, and both updater copies.
- Post-run verification confirmed both staged bundles are absent and `/Applications/ChatGPT.app` remains present. No explicit task executed; installers and restart remained disabled.
- Observed free space increased from 14.197 GiB to 17.450 GiB, a net gain of 3.253 GiB. Free space fluctuated during the run; concurrent disk activity and shared storage mean candidate sizes cannot be summed as physical recovery.

The preview and cleanup processes exited normally. No server or watcher was started.

## 2026-11-06: learn from the machine, add removals from a manual cleanup session

### Context

The tool will be shared publicly. Rule from its owner: nothing is personalized; every task learns from the machine it runs on. A manual cleanup session on 2026-11-06 also removed dangling CLI links, unused nvm Node versions, empty LaunchAgents and leftovers of uninstalled apps. Those removals are now deterministic tasks.

### Added

| Class                          | Learns from                                                                                                                                               | Guard immediately before removal                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `MachineInventory`             | App bundles (`plutil -extract <key> raw`), PATH executables, brew, uv tools, VS Code extensions, processes, shell startup files, git projects + worktrees | Read-only; an absent tool contributes nothing, a failing one errors |
| `NxTempInstallsCleanup`        | `/private/tmp/tmp-<pid>-*` with `node_modules/nx`, owned by this uid                                                                                      | `process.kill(pid, 0)` gives ESRCH                                  |
| `DanglingLinksCleanup`         | Symlinks in PATH folders with a missing target                                                                                                            | Same link, same target, target still missing (`UnlinkAction`)       |
| `NodeVersionsCleanup`          | `nvm version` for the default and every `.nvmrc`/`.node-version` in learned projects                                                                      | lsof shows the version folder unused; still not the default         |
| `LaunchAgentsCleanup`          | `~/Library/LaunchAgents/*.plist` whose program is missing or absent                                                                                       | `launchctl print` exits 113 (not loaded); program still missing     |
| `OrphanedAppDataCleanup`       | Application Support and hidden home folders with no owner in the inventory and nothing changed in 90 days                                                 | Newest file still older than 90 days; lsof; identity                |
| `--keep` (CLI, `Context.kept`) | Run-time input only                                                                                                                                       | `CleanupRun` skips targets inside a kept path                       |
| Missing tool                   | `CleanupTask.inspect`: spawn ENOENT → unconfigured with "<tool> is not installed"                                                                         | —                                                                   |

Changed to learned input: Docker context (`docker context show`; `assertLocal` still refuses non-Unix endpoints), project roots (`ProjectArtifactsCleanup`), staged updates (Sparkle, Squirrel/ShipIt, Docker Desktop from installed apps), Chrome (by bundle ID).

### Removed

Never applied in 23 recorded apply runs, and not learnable without personal selections: `DuplicateReferencesCleanup` (`src/duplicates.ts`), `SqliteRelocationCleanup`/`Action` (`src/sqlite.ts`), `AirbyteRemovalCleanup` and `DockerOffloadCleanup` (`src/workflows.ts`; `RestartCleanup` moved to `src/macos.ts`), and the selection-only tasks codex-temp, experiment-logs, models-runtimes, application-residue, task-artifacts and custom uv caches. `task-artifacts` was used 91 times, always for Nx daemon temp installs; `nx-temp-installs` learns those. The `selections` export of `profile.ts` is gone. Their 5 tests were deleted with them. The 43 run reports moved to the ignored `reports/` folder.

### Net delta

Tracked source and tests: +480, −1009. New files (`src/inventory.ts`, `residue.ts`, `node.ts`, `launchd.ts`, `links.ts`, `test/learned.test.ts`): 1,671 lines. Net +1,142, most of it tests. Methods: 24 → 20 (renumbered).

### Defects found by the live preview, not by fixtures

- `plutil -convert json` fails for plists that hold data or date values (`/System/Applications/Stocks.app`). Fixed: per-key `-extract … raw`.
- A `.git` file inside package caches (pixi, uv sdists) was taken as a repository. Fixed: git decides; exit 128 means "not a repository" and the walk continues inside.
- `stat` of a link into an unreadable folder gives EACCES (`/usr/sbin/weakpass_edit`). Fixed: not proven missing, so not a candidate.

### orphaned-app-data: the machine proposes, the user confirms (backlog #3833)

The first live preview proposed 13 folders; about 6 had an owner that a name match cannot see (`~/.aspnet`, `~/.venvs`, `~/.beads`, `Application Support/gk`, `virtualenv`, `~/.terraform.d`). Measured sources of "the owner was installed and is gone":

| Source                                                 | Result on the author's Mac                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Library/Receipts/InstallHistory.plist`, pkg receipts | 1,582 entries and 120 receipts; none name drag-installed apps or CLIs (Kiro, Cursor, exo, sst)                                                                                                          |
| Launch Services registrations of missing bundles       | Deleted apps are removed; only Chrome helpers and updater stubs remain                                                                                                                                  |
| Homebrew                                               | No trace of uninstalled formulae                                                                                                                                                                        |
| Bundle-ID folders whose vendor has no installed app    | 58 entries, including SDK storage written by installed apps (com.segment, com.telemetrydeck), CLIs (com.vercel.cli, dev.rainfrog), own builds outside /Applications and Docker Desktop's Electron prefs |
| Access time                                            | Not "last read": a file read and a folder listing did not update it (APFS data volume, not `noatime`)                                                                                                   |

No source proves abandonment. Decision: discovery stays learned (owners, references, 90 days of modify and access times, system exclusions), and removal needs confirmation in the same run: `--select <paths>`. Without it the task removes nothing and lists each candidate as a review note with size, last use and the owner sources checked, largest first. A selected path that is owned, recent or not a candidate gets a "Not removed" note with the reason. Live: 11 review notes, 0 actions; `--select ~/.matplotlib` gives exactly 1 action.

The protected-path entries for Codex and Dia were removed: the Codex and Dia folders are kept by ownership (`codex` command, Dia app), and app-specific entries do not belong in a shared tool.

### Rejected

- **REJECTED** owner evidence from installed binaries (search every PATH and app executable for `/<folder>`): 2,167 executables, 8.4 GB, 39 s per run. It found `bd` → `.beads` and `uv` → `virtualenv`, but cleaners such as Mole name every path they clean (`.m2`, `.terraform.d`), short names match unrelated binaries (`/gk` in flyctl), and it missed `.aspnet` and `.venvs`.

- **REJECTED** a catalog of known residue paths: it describes one machine, not the machine under work.
- **REJECTED** `CACHEDIR.TAG` as a deletion signal: uv also tags virtual environments with it.
- **REJECTED** `NVM_SYMLINK_CURRENT` for Node resolution: it tracks the last `nvm use`, not the default, and nvm documents multi-tab races.
- **REJECTED** reinstalling global npm packages on Node upgrades: links were `npm link` development links.

## 2026-11-06: folders by concept, workflows restored as opt-in

**Why:** the owner asked why 3 files were deleted and chose to keep them in their own folder instead. The earlier removal ("never applied in 23 runs, needs personal selections") was a reason to take them out of the default run, not to delete them.

**Layout:** `src/` is now one folder per concept (`run/`, `paths/`, `machine/`, `tasks/<area>/`), one task per file. Functions with one calling class became private static members (`#owned`, `#lastUsed`, `#compareVersion`, `#notInstalled`). Proof of no behavior change: the same 39 tests pass, and a live preview before and after the move gives the same task IDs and candidate counts. One count (`docker-images` 3 → 4) changed between the two runs; running the old and the new `DockerCleanup` against the same Docker state gave the same 4 images, so the change came from the machine.

**Workflows:** `workflows/` holds `sqlite-relocation`, `airbyte`, `docker-offload` and `duplicate-references` (methods 21–24, all explicit), restored from the import commit. Their input is required, so the old "unconfigured" branches were removed. Airbyte learns its Docker context. Input comes from a JSON file at run time (`--workflow <name> --input <file>`), read by `WorkflowInput`, which names the bad field. `profile.ts` exports its `PathPolicy` so that workflows reuse the same protected paths; `sqlite-relocation` also owns the destination folder for that run. Tests: the 5 deleted tests are back in `test/workflows.test.ts` with `try`/`finally`, driven through the registry; the old "unconfigured" test became an input-refusal test.

**Workflow coverage (backlog #3839, 2026-11-06):** `AirbyteRemovalCleanup` and `DockerOffloadCleanup` take `env` as an input (`Workflow.build(value, env)`; the CLI passes `process.env`), so tests never set the shell environment. New tests cover SQLite rollback when the source is opened after the copy, and Airbyte's refusals (running container, Docker env overrides, changed context), its happy path and its postconditions; every targeted mutation was caught. Not testable without a test-only hook: a source or `.env` change during the in-process backup, and the integrity-check failure.

## 2026-11-06: installer rules proven, an interrupted run keeps its report (#3845, #3847)

**Installers (#3845), live preview:** `node cleanup.ts --preview --only installers,macos-installers` gives 0 candidates. `~/Downloads/Hoy-0-9-5.dmg` is named as installed (`Hoy.app`) and kept as recent. Three old `.zip` files in Downloads hold no installed app, so they are not proposed. No subfolder is scanned. This Mac has no `Install macOS` app.

**Installers, proof:** a mutation prover caught 11 of 12 mutations of the 4 tests. A test review found 2 more gaps. The changes:

- A `.zip` that holds an installed app and another top-level file was proposed when the single-root rule was dropped. The zip test now has `Mixed.zip`.
- No installer had the same major as this Mac, so `>` → `>=` survived. The macOS test now removes `Install macOS Current` (27 on a Mac that runs 27).
- One unreadable `.zip` made the whole `installers` task fail. `zipinfo` exits 9 for a junk, empty, truncated or permission-denied archive (probed on macOS 27). The task now catches exit 9 only and notes `Unreadable archive, kept: <path>`.
- `Math.max` for each macOS title is removed as dead logic. The live listing shows one major for each title: `macOS 27 Golden Gate` 27.0–27.2, `macOS Tahoe` 26.6.1–26.7.2, `macOS Sequoia` 15.7.9–15.8.2.
- Unproven: the bundle name of the macOS 27 installer. Its title holds the version number (#3854).

**Interrupted runs (#3847), before:** a SIGINT or SIGTERM made the abort reason escape `CleanupRun.run`. The CLI printed a stack trace, exited with 1 and wrote no report. The full apply of 2026-11-06 lost the record of the 10 tasks it had already run. A missing report folder or an existing report file failed only after the run.

**Interrupted runs, now:** `CleanupRun.run` returns the partial report. `interrupted` holds the reason. The action that was running has the status `interrupted`, because its target can be partly changed. Actions that did not start stay `planned`. Tasks that were not inspected are not in the report. The CLI opens `--report` with flag `wx` before the first task and writes the report into that file. At the signal it prints one line (`Interrupted by SIGINT: stopping after the current step. A second SIGINT stops at once.`) and it exits with 128 + the signal number (130, 143). The line is there because some steps cannot stop at once: a blocked read, or `fs.rm` of a large folder. A second signal stops the process at once (`process.once`).

**Interrupted runs, tests:** two tests go through `CleanupRun` with a Host stub that blocks until the abort: one abort lands during a later task's inspect, one during an action. Five tests go through the real CLI: a report path that cannot be created, a full report, SIGINT and SIGTERM, and a second signal. To interrupt the CLI at a known point with no seam, the CLI tests give the `duplicate-references` workflow a FIFO as its original file. The hash read then waits until the test writes to the FIFO. Trap: if the test closes the write end before the CLI opens the FIFO, the CLI's open blocks for good. The test keeps the write end open and writes bytes that are not gzip.

**Interrupted runs, live check:** a read-only preview of `nx-cache`, `builds` and `app-caches`, with SIGINT during `builds`, exits with 130. Its report lists `nx-cache` only. Before the change, the same command printed a stack trace, exited with 1 and wrote no report.

**Proof:** **Proof:** before the first test, a claim comparator checked the claims against both tickets. Then three mutation-prover rounds and one test review ran on the new tests. The rounds caught 23 of 26, 3 of 5 and 8 of 8 mutations. Each survivor led to a fix: R2 now has a second task and checks the progress lines, which proves the check of the signal at the top of the task loop, and the second-signal test now covers SIGTERM as well as SIGINT. One survivor is answered, not fixed: the inspect-abort test cannot reach the check before an action, and the action-abort test catches it. Every claim has a caught mutation. Full suite: 65 tests pass, and typecheck passes.
