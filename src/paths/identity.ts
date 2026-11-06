import { lstat } from "node:fs/promises";

export interface Identity {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

export async function identity(path: string): Promise<Identity> {
  const { dev, ino, mtimeMs, size } = await lstat(path);
  return { dev, ino, mtimeMs, size };
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size
  );
}
