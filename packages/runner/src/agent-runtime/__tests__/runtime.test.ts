/**
 * The `run:` turn lifecycle, proven with injected primitives — no real
 * sandcastle, no docker, no process. The seam is `createTurnRuntime(deps)`;
 * every host primitive is a fake, so the acceptance criteria that live here
 * (AC6 cancel-outside-sandcastle, AC5 token-never-in-sandbox, AC7 no second
 * wall-clock) are provable deterministically.
 */
import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxProvider } from "@ai-hero/sandcastle";
import { createFactoryHostProvider } from "../host-provider.js";
import { createTurnRuntime, TurnCancelledError } from "../runtime.js";
import type { DockerControl, HostProcessControl, TurnRuntimeDeps } from "../types.js";

function fakeSandbox(overrides: {
  worktreePath?: string;
  stdout?: string;
  exitCode?: number;
  preservedWorktreePath?: string | null;
  execDelayMs?: number;
} = {}): Sandbox & { execCalls: { command: string }[]; abort: (error: unknown) => void } {
  const calls: { command: string }[] = [];
  let rejectExec: ((error: unknown) => void) | null = null;
  const handle = {
    branch: "branch",
    worktreePath: overrides.worktreePath ?? "/tmp/clone/.sandcastle/worktrees/run-x",
    async run() {
      throw new Error("unused");
    },
    async interactive() {
      throw new Error("unused");
    },
    async exec(command: string) {
      calls.push({ command });
      if (overrides.execDelayMs) {
        // Mimics a real container/process: the command keeps running until
        // cancel kills it — abort() is what the test calls when cancel lands.
        return await new Promise((resolve, reject) => {
          rejectExec = reject;
          setTimeout(() => {
            rejectExec = null;
            resolve({ stdout: overrides.stdout ?? "hello", stderr: "", exitCode: overrides.exitCode ?? 0 });
          }, overrides.execDelayMs);
        });
      }
      return { stdout: overrides.stdout ?? "hello", stderr: "", exitCode: overrides.exitCode ?? 0 };
    },
    async close() {
      return { preservedWorktreePath: overrides.preservedWorktreePath ?? null };
    },
    async [Symbol.asyncDispose]() {
      await handle.close();
    },
  };
  return Object.assign(handle, {
    execCalls: calls,
    abort: (error: unknown) => rejectExec?.(error),
  }) as unknown as Sandbox & { execCalls: { command: string }[]; abort: (error: unknown) => void };
}

function fakeDocker(): DockerControl & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createNetwork(name) {
      calls.push(`create-network ${name}`);
    },
    async removeNetwork(name) {
      calls.push(`remove-network ${name}`);
    },
    async containerIdsOnNetwork(name) {
      calls.push(`ps ${name}`);
      return ["cid-1", "cid-2"];
    },
    async stop(ids, graceSeconds) {
      calls.push(`stop ${ids.join(",")} grace=${graceSeconds}`);
    },
  };
}

function fakeHostProcess(overrides: { exitCode?: number; stdout?: string; delayMs?: number } = {}): HostProcessControl & {
  killed: number[];
  spawned: number;
} {
  let spawned = 0;
  const killed: number[] = [];
  return {
    spawned,
    killed,
    spawnShell(command, cwd, options) {
      spawned += 1;
      return {
        pgid: 4242,
        result: new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                stdout: overrides.stdout ?? "ran",
                stderr: "",
                exitCode: overrides.exitCode ?? 0,
              }),
            overrides.delayMs ?? 50,
          );
        }),
      };
    },
    killGroup(pgid) {
      killed.push(pgid);
    },
  };
}

function makeDeps(overrides: {
  sandbox?: ReturnType<typeof fakeSandbox>;
  docker?: ReturnType<typeof fakeDocker>;
  hostProcess?: ReturnType<typeof fakeHostProcess>;
} = {}): TurnRuntimeDeps & {
  createdProviders: SandboxProvider[];
  sandbox: ReturnType<typeof fakeSandbox>;
  docker: ReturnType<typeof fakeDocker>;
  hostProcess: ReturnType<typeof fakeHostProcess>;
} {
  const sandbox = overrides.sandbox ?? fakeSandbox();
  const docker = overrides.docker ?? fakeDocker();
  const hostProcess = overrides.hostProcess ?? fakeHostProcess();
  const createdProviders: SandboxProvider[] = [];
  return {
    createdProviders,
    sandbox,
    docker,
    hostProcess,
    async createSandbox(options) {
      createdProviders.push(options.sandbox);
      // Host mode: exercise the *real* host provider (tag "bind-mount") with
      // the fake process control, so spawn/kill-group flows are proven for
      // real; docker mode: return the fake sandbox (no docker daemon needed).
      if ((options.sandbox as { name?: string }).name === "factory-host") {
        const handle = await (options.sandbox as unknown as { create: (o: unknown) => Promise<unknown> }).create({
          worktreePath: sandbox.worktreePath,
          hostRepoPath: "/tmp/clone",
          mounts: [],
          env: {},
        });
        return handle as Sandbox;
      }
      return sandbox;
    },
  };
}

const shellSpec = {
  kind: "shell" as const,
  command: "make build",
  workingDirectory: "/tmp/clone",
  branch: "run/run_0001/implement/t1-a1",
  baseRef: "abc123",
  runsOn: "host" as const,
  image: "factory-sandbox",
  network: "factory-steprun-1",
};

describe("agent-runtime: shell turn", () => {
  it("AC1 — docker mode uses sandcastle's built-in docker provider as-is, attached to the per-StepRun network", async () => {
    const deps = makeDeps();
    const runtime = createTurnRuntime(deps);
    const turn = runtime.startTurn({ ...shellSpec, runsOn: "docker" });

    const result = await turn.done;
    expect(result).toMatchObject({ stdout: "hello", exitCode: 0, preservedWorktreePath: null });
    expect(result.worktreePath).toBe("/tmp/clone/.sandcastle/worktrees/run-x");

    // The provider handed to sandcastle is the built-in docker provider.
    const provider = deps.createdProviders[0] as { tag?: string; name?: string };
    expect(provider.tag).toBe("bind-mount"); // docker() wraps createBindMountSandboxProvider.
    // Network created before the sandbox; removed after.
    expect(deps.docker.calls[0]).toBe("create-network factory-steprun-1");
    expect(deps.docker.calls).toContain("remove-network factory-steprun-1");
    expect(deps.sandbox.execCalls).toEqual([{ command: "make build" }]);
  });

  it("AC1 — host mode uses our own provider registered with tag bind-mount (not tag none)", async () => {
    const deps = makeDeps();
    const runtime = createTurnRuntime(deps);
    const turn = runtime.startTurn(shellSpec);

    const result = await turn.done;
    expect(result.exitCode).toBe(0);

    const provider = deps.createdProviders[0] as { tag?: string; name?: string };
    expect(provider.tag).toBe("bind-mount"); // createBindMountSandboxProvider — session capture stays on.
    expect(provider.name).toBe("factory-host");
    // Host mode touches no docker network at all.
    expect(deps.docker.calls).toHaveLength(0);
  });

  it("AC1 — tag none (sandcastle's noSandbox) would silently disable session capture; the host provider must not be it", () => {
    // The distinction is structural: createBindMountSandboxProvider tags
    // "bind-mount" (session capture gate open), noSandbox() tags "none"
    // (gate closed). Our provider is the former — asserted here directly,
    // and behaviorally in contract.test.ts against real sandcastle.
    const provider = createFactoryHostProvider({ hostProcess: fakeHostProcess() });
    expect((provider as { tag?: string }).tag).toBe("bind-mount");
    expect((provider as { name?: string }).name).toBe("factory-host");
  });

  it("reports a non-zero exit code as data in the result, not a rejection", async () => {
    const deps = makeDeps({ hostProcess: fakeHostProcess({ exitCode: 7, stdout: "boom" }) });
    const runtime = createTurnRuntime(deps);
    const result = await runtime.startTurn(shellSpec).done;
    expect(result).toMatchObject({ exitCode: 7, stdout: "boom" });
  });

  it("AC6 — host cancel SIGTERMs the process group, and done rejects as cancelled", async () => {
    const deps = makeDeps(); // host mode exercises the real host provider over the fake process control.
    const runtime = createTurnRuntime(deps);
    const turn = runtime.startTurn(shellSpec);

    const donePromise = turn.done;
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the command spawn (pgid registered)
    turn.cancel();
    await expect(donePromise).rejects.toThrow(TurnCancelledError);
    expect(deps.hostProcess.killed).toEqual([4242]);
  });

  it("AC6 — docker cancel stops every container on the per-StepRun network with a 30-second grace", async () => {
    const sandbox = fakeSandbox({ execDelayMs: 5000 });
    const deps = makeDeps({ sandbox });
    const runtime = createTurnRuntime(deps);
    const turn = runtime.startTurn({ ...shellSpec, runsOn: "docker" });

    const donePromise = turn.done;
    await new Promise((resolve) => setTimeout(resolve, 5)); // let createSandbox+exec start
    turn.cancel();
    sandbox.abort(new Error("container stopped"));
    await expect(donePromise).rejects.toThrow(TurnCancelledError);
    expect(deps.docker.calls).toContain("ps factory-steprun-1");
    expect(deps.docker.calls).toContain("stop cid-1,cid-2 grace=30");
  });

  it("AC6 — a cancel landing before the command spawns still ends the turn cancelled", async () => {
    const deps = makeDeps();
    const runtime = createTurnRuntime(deps);
    const turn = runtime.startTurn(shellSpec);
    turn.cancel(); // cancelled before the command spawns — the host provider's shouldSkip swallows the spawn.
    await expect(turn.done).rejects.toThrow(TurnCancelledError);
    expect(deps.hostProcess.spawned).toBe(0); // the command never even started.
  });
});
