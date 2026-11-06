import { join } from "node:path";
import { type Context } from "../run/context.ts";

/**
 * String values from a bundle's Info.plist. `-extract … raw` reads one key; a whole-file
 * JSON conversion fails for plists that hold data or date values (Stocks.app does).
 */
export async function infoPlist<Key extends string>(
  bundle: string,
  keys: readonly Key[],
  context: Context,
): Promise<Record<Key, string | null>> {
  const values = {} as Record<Key, string | null>;
  for (const key of keys) {
    try {
      values[key] = (
        await context.host.run(
          {
            file: "plutil",
            args: [
              "-extract",
              key,
              "raw",
              "-o",
              "-",
              join(bundle, "Contents/Info.plist"),
            ],
          },
          context.signal,
        )
      ).trim();
    } catch (error) {
      // plutil exits 1 when the key is absent.
      if (!(error instanceof Error && "code" in error && error.code === 1))
        throw error;
      values[key] = null;
    }
  }
  return values;
}
