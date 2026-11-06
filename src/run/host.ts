import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Command = { file: string; args: string[] };

export interface Host {
  run(command: Command, signal: AbortSignal): Promise<string>;
}

const exec = promisify(execFile);

/** Adapter: native child-process cancellation, timeout, and error propagation. */
export class LocalHost implements Host {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }
  async run(command: Command, signal: AbortSignal): Promise<string> {
    const { stdout } = await exec(command.file, command.args, {
      signal,
      timeout: this.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  }
}
