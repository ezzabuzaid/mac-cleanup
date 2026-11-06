import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { infoPlist } from "./info-plist.ts";
import { exists } from "../paths/within.ts";
import { type Context } from "../run/context.ts";

export interface AppBundle {
  path: string;
  id: string;
  name: string;
  executable: string;
}

export interface MachineRoots {
  home: string;
  applicationDirs: readonly string[];
  pathDirs: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

/** One owner source and the normalized names it contributes. */
export interface OwnerSource {
  source: string;
  keys: ReadonlySet<string>;
}

export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Tokens this short or this common name no owner on their own.
const genericTokens = new Set([
  "com",
  "org",
  "net",
  "app",
  "apps",
  "dev",
  "www",
  "inc",
  "ltd",
  "mac",
  "macos",
  "osx",
  "desktop",
  "helper",
  "the",
  "cli",
  "beta",
  "nightly",
  "studio",
  "code",
  "data",
  "cache",
  "caches",
  "config",
  "local",
  "shared",
]);

export function nameTokens(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+/)
    .map(nameKey)
    .filter((token) => token.length >= 3 && !genericTokens.has(token));
}

/** Read-only facts about the machine under work, learned once per run. */
export class MachineInventory {
  static #notInstalled(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "syscall" in error &&
      typeof error.syscall === "string" &&
      error.syscall.startsWith("spawn ")
    );
  }
  readonly roots: MachineRoots;
  private readonly memo = new Map<string, Promise<unknown>>();
  constructor(roots: MachineRoots) {
    this.roots = roots;
  }
  private once<T>(key: string, learn: () => Promise<T>): Promise<T> {
    let value = this.memo.get(key) as Promise<T> | undefined;
    if (value === undefined) {
      value = learn();
      this.memo.set(key, value);
    }
    return value;
  }
  /** Output of an optional tool; an absent tool contributes nothing. */
  private async optional(
    file: string,
    args: string[],
    context: Context,
  ): Promise<string> {
    try {
      return await context.host.run({ file, args }, context.signal);
    } catch (error) {
      if (MachineInventory.#notInstalled(error)) return "";
      throw error;
    }
  }

  apps(context: Context): Promise<AppBundle[]> {
    return this.once("apps", async () => {
      const bundles: string[] = [];
      for (const directory of this.roots.applicationDirs) {
        if (!(await exists(directory))) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const path = join(directory, entry.name);
          if (entry.name.endsWith(".app")) bundles.push(path);
          // Folders such as Utilities or Setapp hold one more level of apps.
          else
            for (const inner of await readdir(path, { withFileTypes: true }))
              if (inner.isDirectory() && inner.name.endsWith(".app"))
                bundles.push(join(path, inner.name));
        }
      }
      const apps: AppBundle[] = [];
      for (const path of bundles) {
        if (!(await exists(join(path, "Contents/Info.plist")))) continue;
        const plist = await infoPlist(
          path,
          ["CFBundleIdentifier", "CFBundleName", "CFBundleExecutable"],
          context,
        );
        apps.push({
          path,
          id: plist.CFBundleIdentifier ?? "",
          name: plist.CFBundleName ?? basename(path, ".app"),
          executable: plist.CFBundleExecutable ?? "",
        });
      }
      return apps;
    });
  }

  /** Executable names on PATH; a link whose target is gone is not a command. */
  commands(): Promise<Set<string>> {
    return this.once("commands", async () => {
      const names = new Set<string>();
      for (const directory of this.roots.pathDirs) {
        if (!(await exists(directory))) continue;
        for (const name of await readdir(directory)) {
          try {
            const info = await stat(join(directory, name));
            if (info.isFile() && (info.mode & 0o111) !== 0) names.add(name);
          } catch (error) {
            if (!(error instanceof Error && "code" in error)) throw error;
          }
        }
      }
      return names;
    });
  }

  owners(context: Context): Promise<OwnerSource[]> {
    return this.once("owners", async () => {
      const keys = (values: Iterable<string>) => {
        const set = new Set<string>();
        for (const value of values) {
          if (nameKey(value) !== "") set.add(nameKey(value));
          for (const token of nameTokens(value)) set.add(token);
        }
        return set;
      };
      const lines = (output: string) =>
        output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      const extensions = join(this.roots.home, ".vscode/extensions");
      return [
        {
          source: "installed apps",
          keys: keys(
            (await this.apps(context)).flatMap((app) => [
              app.id,
              app.name,
              app.executable,
            ]),
          ),
        },
        { source: "commands on PATH", keys: keys(await this.commands()) },
        {
          source: "Homebrew packages",
          keys: keys([
            ...lines(
              await this.optional("brew", ["list", "--formula", "-1"], context),
            ),
            ...lines(
              await this.optional("brew", ["list", "--cask", "-1"], context),
            ),
          ]),
        },
        {
          source: "uv tools",
          keys: keys(
            lines(await this.optional("uv", ["tool", "list"], context))
              .filter((line) => !line.startsWith("-"))
              .map((line) => line.split(" ")[0]),
          ),
        },
        {
          source: "VS Code extensions",
          keys: keys(
            (await exists(extensions))
              ? (await readdir(extensions)).flatMap((name) =>
                  name.replace(/-\d[\w.-]*$/, "").split("."),
                )
              : [],
          ),
        },
        {
          source: "running processes",
          keys: keys(
            lines(await this.optional("ps", ["-axo", "comm="], context)).map(
              (line) => basename(line),
            ),
          ),
        },
      ];
    });
  }

  /** Text of the shell startup files; a folder they name is in use. */
  shellStartup(): Promise<string> {
    return this.once("shell", async () => {
      const files = [
        ".zshenv",
        ".zprofile",
        ".zshrc",
        ".zlogin",
        ".bash_profile",
        ".bashrc",
        ".profile",
        ".config/fish/config.fish",
      ];
      const texts: string[] = [];
      for (const file of files) {
        const path = join(this.roots.home, file);
        if (await exists(path)) texts.push(await readFile(path, "utf8"));
      }
      return texts.join("\n");
    });
  }

  /** Git projects under the home folder, plus every worktree git knows for them. */
  projects(context: Context): Promise<string[]> {
    return this.once("projects", async () => {
      const projects = new Set<string>();
      const stops =
        /^(Library|Applications|node_modules|.*\.(app|photoslibrary|musiclibrary|bundle))$/;
      /** git itself decides: a `.git` file in package test data is not a repository. */
      const worktrees = async (directory: string): Promise<string[] | null> => {
        try {
          const listing = await context.host.run(
            {
              file: "git",
              args: ["-C", directory, "worktree", "list", "--porcelain"],
            },
            context.signal,
          );
          return [...listing.matchAll(/^worktree (.+)$/gm)].map(
            (match) => match[1],
          );
        } catch (error) {
          // git exits 128 for a .git entry that is not a repository (invalid gitfile, bare data).
          if (error instanceof Error && "code" in error && error.code === 128)
            return null;
          throw error;
        }
      };
      const visit = async (directory: string): Promise<void> => {
        context.signal.throwIfAborted();
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.some((entry) => entry.name === ".git")) {
          const trees = await worktrees(directory);
          if (trees !== null) {
            projects.add(directory);
            for (const tree of trees)
              if (await exists(tree)) projects.add(tree);
            return;
          }
        }
        for (const entry of entries)
          if (
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !stops.test(entry.name)
          )
            await visit(join(directory, entry.name));
      };
      for (const entry of await readdir(this.roots.home, {
        withFileTypes: true,
      }))
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !stops.test(entry.name)
        )
          await visit(join(this.roots.home, entry.name));
      return [...projects];
    });
  }
}
