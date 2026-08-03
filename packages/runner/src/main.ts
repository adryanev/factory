/**
 * Scaffold entrypoint. No product behavior yet — this exists to prove the
 * `runner` package builds, typechecks, and imports `@factory/shared` as a
 * workspace package. The real join/claim/heartbeat loop (spec: "Kontrak
 * API control-plane <-> Runner") lands in a later issue.
 */
import { isValidId } from "@factory/shared";

export function describeRunnerScaffold(): string {
  return `factory-runner scaffold (shared id validator loaded: ${typeof isValidId === "function"})`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  console.log(describeRunnerScaffold());
}
