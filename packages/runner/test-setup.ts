/**
 * Redirects `git config --global` away from the developer's real `~/.gitconfig`
 * for the duration of a test run.
 *
 * sandcastle runs three global writes for every sandbox it creates —
 * `safe.directory`, `user.name`, `user.email` — and the contract tests create
 * a lot of sandboxes. Two consequences, both of which this file removes:
 *
 *  - **The writes race.** vitest runs test files in parallel, and the root
 *    `pnpm -r test` runs packages in parallel on top of that. Two `git config`
 *    processes writing the same file fail with "could not lock config file:
 *    File exists" — a flake that appears only under load, which is exactly
 *    when CI runs.
 *  - **The writes persist.** `safe.directory` is append-only, so every sandbox
 *    ever created leaves a line behind pointing at a temp directory that no
 *    longer exists. A test may not edit the machine it runs on.
 *
 * `GIT_CONFIG_GLOBAL` is git's own override for the path `--global` resolves
 * to. One directory per worker process, so parallel workers cannot contend
 * with each other either. The OS reclaims it; nothing here has to be cleaned
 * up, and a leaked file is a few bytes in the temp dir rather than a line in
 * the developer's config.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), `factory-gitconfig-${process.pid}-`));
process.env["GIT_CONFIG_GLOBAL"] = path.join(scratch, "gitconfig");
