#!/usr/bin/env node
// .husky/pre-commit is a committed link to this file. Each step reads the
// staged commit: Format refuses unformatted staged files instead of rewriting
// them, and the npm steps refuse a commit that npm ci would not install.
import {
  DockerfileInstallsFromLockfile,
  Format,
  LockfileSync,
  NoNumericPins,
  NpmrcPolicy,
  preCommit,
} from "@zukhruf/git-hooks";

await preCommit([
  new Format(),
  new NoNumericPins(),
  new NpmrcPolicy(),
  new LockfileSync(),
  new DockerfileInstallsFromLockfile(),
]);
