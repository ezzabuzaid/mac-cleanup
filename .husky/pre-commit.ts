#!/usr/bin/env node
// .husky/pre-commit is a committed link to this file. Each step reads the
// staged commit: Format refuses unformatted staged files instead of rewriting
// them, the npm steps refuse a commit that npm ci would not install, and
// WorkflowChecks lints the staged workflows under .github.
import {
  DockerfileInstallsFromLockfile,
  Format,
  LockfileSync,
  NoNumericPins,
  NpmrcPolicy,
  WorkflowChecks,
  preCommit,
} from "@zukhruf/git-hooks";

await preCommit([
  new Format(),
  new NoNumericPins(),
  new NpmrcPolicy(),
  new LockfileSync(),
  new DockerfileInstallsFromLockfile(),
  new WorkflowChecks(),
]);
