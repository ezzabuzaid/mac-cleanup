import { infoPlist } from "../../machine/info-plist.ts";
import { Ineligible } from "../../run/action.ts";
import { type Context } from "../../run/context.ts";

export interface Bundle {
  CFBundleIdentifier: string;
  CFBundleShortVersionString: string;
  CFBundleVersion: string;
}

export async function bundle(path: string, context: Context): Promise<Bundle> {
  const value = await infoPlist(
    path,
    ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"],
    context,
  );
  const { CFBundleIdentifier, CFBundleShortVersionString, CFBundleVersion } =
    value;
  if (!CFBundleIdentifier || !CFBundleShortVersionString || !CFBundleVersion)
    throw new Ineligible(`Incomplete application bundle metadata: ${path}`);
  return { CFBundleIdentifier, CFBundleShortVersionString, CFBundleVersion };
}
