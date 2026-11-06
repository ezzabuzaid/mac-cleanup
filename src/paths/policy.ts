import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { exists, within } from "./within.ts";
import { Ineligible } from "../run/action.ts";
import { type Context } from "../run/context.ts";

/** Shared live path constraints. No recursive delete implementation is owned here. */
export class PathPolicy {
  private readonly previewOpenFiles = new WeakMap<Context, Promise<string[]>>();
  readonly protectedPaths: readonly string[];
  readonly ownedRoots: readonly string[];
  constructor(
    ownedRoots: readonly string[],
    protectedPaths: readonly string[],
  ) {
    this.ownedRoots = ownedRoots.map((path) => resolve(path));
    this.protectedPaths = protectedPaths.map((path) => resolve(path));
  }
  private rootFor(path: string): string {
    const absolute = resolve(path);
    const root = this.ownedRoots.find(
      (root) => root !== absolute && within(root, absolute),
    );
    if (
      !isAbsolute(path) ||
      root === undefined ||
      absolute === parse(absolute).root
    ) {
      throw new Ineligible(`Not a child of an explicitly owned root: ${path}`);
    }
    if (
      this.protectedPaths.some(
        (p) => within(p, absolute) || within(absolute, p),
      )
    ) {
      throw new Ineligible(`Protected path or ancestor: ${path}`);
    }
    return root;
  }
  async validateNew(path: string): Promise<void> {
    const root = this.rootFor(path);
    const parent = resolve(path, "..");
    if (
      (await realpath(parent)) !==
      join(await realpath(root), relative(root, parent))
    )
      throw new Ineligible(`Symlink in destination path: ${path}`);
    if (await exists(path))
      throw new Ineligible(`Destination already exists: ${path}`);
  }
  async validate(path: string): Promise<void> {
    const root = this.rootFor(path);
    const absolute = resolve(path);
    if ((await lstat(path)).isSymbolicLink())
      throw new Ineligible(`Symlink: ${path}`);
    const expected = join(await realpath(root), relative(root, absolute));
    if ((await realpath(path)) !== expected)
      throw new Ineligible(`Symlink in path: ${path}`);
  }
  async assertUnused(path: string, context: Context): Promise<void> {
    const read = async () =>
      (
        await context.host.run(
          { file: "lsof", args: ["-nP", "-Fn"] },
          context.signal,
        )
      )
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1));
    let pending =
      context.mode === "preview"
        ? this.previewOpenFiles.get(context)
        : undefined;
    if (pending === undefined) {
      pending = read();
      if (context.mode === "preview")
        this.previewOpenFiles.set(context, pending);
    }
    const used = await pending;
    const canonical = await realpath(path);
    if (used.some((file) => within(canonical, file)))
      throw new Ineligible(`Open files: ${path}`);
  }
}
