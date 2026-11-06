import { isAbsolute } from "node:path";

/** Reads a workflow's JSON input and names the exact field that is missing or wrong. */
export class WorkflowInput {
  readonly label: string;
  readonly value: Record<string, unknown>;
  constructor(label: string, value: unknown) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`${label}: the input must be a JSON object`);
    this.label = label;
    this.value = value as Record<string, unknown>;
  }
  #fail(key: string, expected: string): never {
    throw new Error(`${this.label}: "${key}" must be ${expected}`);
  }
  text(key: string): string {
    const value = this.value[key];
    if (typeof value !== "string" || value === "")
      this.#fail(key, "a non-empty string");
    return value;
  }
  path(key: string): string {
    const value = this.text(key);
    if (!isAbsolute(value)) this.#fail(key, "an absolute path");
    return value;
  }
  count(key: string): number {
    const value = this.value[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      this.#fail(key, "a whole number of 0 or more");
    return value;
  }
  texts(key: string): string[] {
    const value = this.value[key];
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((item) => typeof item === "string" && item !== "")
    )
      this.#fail(key, "a non-empty list of strings");
    return value as string[];
  }
  list<T>(key: string, read: (item: WorkflowInput) => T): T[] {
    const value = this.value[key];
    if (!Array.isArray(value) || value.length === 0)
      this.#fail(key, "a non-empty list");
    return value.map((item, index) =>
      read(new WorkflowInput(`${this.label}.${key}[${index}]`, item)),
    );
  }
}
