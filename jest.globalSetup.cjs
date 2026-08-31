/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest globalSetup — stamps a unique id on this test run.
 *
 * `TestDataTracker` embeds this id in the crash-recovery ledger filenames it
 * writes, and `jest.globalTeardown.cjs` only drains ledgers carrying its OWN id
 * (plus ones whose owning process is provably dead). That scoping is what makes
 * the safety net safe when two jest processes share a worktree and point at the
 * same shared cluster — neither can delete the other's in-flight test data.
 *
 * FORMAT CONTRACT: the generated id is `<pid>-<timestamp>` where `<pid>` is
 * THIS process — the jest parent, which owns the whole run and stays alive
 * until globalTeardown completes. Teardown parses that leading pid out of
 * foreign ledger filenames and probes it with `process.kill(pid, 0)`: a live
 * pid means the run is still in flight (skip its ledgers), a dead pid means
 * the run can never clean up after itself (adopt its ledgers immediately).
 * If you override AH_TEST_RUN_ID in the environment, prefer a value that does
 * NOT look like `<digits>-<digits>` unless the leading digits are a real
 * owning pid; unparseable ids simply fall back to a conservative mtime rule.
 *
 * Jest runs globalSetup in the parent process before workers spawn, so
 * `process.env` mutations here are inherited by every worker and are still
 * visible in globalTeardown.
 */
module.exports = async () => {
  if (!process.env.AH_TEST_RUN_ID) {
    process.env.AH_TEST_RUN_ID = `${process.pid}-${Date.now()}`;
  }
};
