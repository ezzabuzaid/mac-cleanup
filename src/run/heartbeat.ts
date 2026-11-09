export interface Clock<Timer> {
  setInterval(callback: () => void, ms: number): Timer;
  clearInterval(timer: Timer | undefined): void;
}

/** A step can stay silent for minutes; a repeated line tells the reader the run is alive. */
export class Heartbeat<Timer> implements Disposable {
  readonly print: (line: string) => void;
  readonly everyMs: number;
  readonly clock: Clock<Timer>;
  private timer: Timer | undefined;
  constructor(
    print: (line: string) => void,
    everyMs: number,
    clock: Clock<Timer>,
  ) {
    this.print = print;
    this.everyMs = everyMs;
    this.clock = clock;
  }
  step(message: string): void {
    this.print(message);
    this.clock.clearInterval(this.timer);
    let silentMs = 0;
    this.timer = this.clock.setInterval(() => {
      silentMs += this.everyMs;
      this.print(
        `Still running after ${silentMs / 1000} s; last step: ${message}`,
      );
    }, this.everyMs);
  }
  [Symbol.dispose](): void {
    this.clock.clearInterval(this.timer);
  }
}
