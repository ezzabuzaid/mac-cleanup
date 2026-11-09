import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Command = { file: string; args: string[] };

export interface Host {
  run(command: Command, signal: AbortSignal): Promise<string>;
}

const exec = promisify(execFile);

/** Decorator: one answer to one command for as long as this host lives; every other command runs. */
export class SnapshotHost implements Host {
  readonly host: Host;
  readonly command: Command;
  private answer: Promise<string> | undefined;
  constructor(host: Host, command: Command) {
    this.host = host;
    this.command = command;
  }
  run(command: Command, signal: AbortSignal): Promise<string> {
    if (command !== this.command) return this.host.run(command, signal);
    this.answer ??= this.host.run(command, signal);
    return this.answer;
  }
}

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
