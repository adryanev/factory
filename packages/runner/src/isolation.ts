/**
 * The isolation verification that gates Runner identity (spec "Packaging
 * self-host", decision 6, and issue #10's hard line): in `exec:host` mode
 * the agent runs as a separate OS user (`_factoryjob`) from the Runner
 * process (`_factory`), and the Runner's identity file (`runner.secret`,
 * mode 0600) must be unreadable by that agent user — otherwise the agent
 * could `cat runner.secret` and elevate itself to a Runner.
 *
 * The shape of the guarantee, per the design doc:
 *
 *   "verifikasi isolasi jadi gerbang menuju identitas ... penukaran join
 *   token baru terjadi setelah semuanya hijau."
 *
 * `join` (see `join.ts`) therefore runs `verifyIsolation` FIRST and refuses
 * to exchange the join token when the agent user can read the identity
 * file. A half-finished installation — agent running as the wrong user, or
 * a world-readable identity file — produces a machine that NEVER has an
 * identity: it never joins the pool, so it can never be handed work. The
 * failure mode ticket 10 fears ("instalasi separuh jadi yang menjalankan
 * agent sebagai user yang salah ... kegagalan diam") becomes impossible to
 * reach through a failed install.
 *
 * The probe itself is injected so tests can fake `sudo` — the real probe
 * runs `sudo -u <agentUser> cat <file>` and treats a successful read as
 * "agent user CAN read the secret" (gate fails). The installer creates the
 * identity file before join runs, so this checks a real file, not a
 * missing one (a missing file would trivially be unreadable).
 */
import { spawn } from "node:child_process";

export class IsolationVerificationError extends Error {
  override readonly name = "IsolationVerificationError";
}

/** Reports whether the agent user can read the identity file. True = isolation is BROKEN. */
export interface IsolationProbe {
  canAgentUserRead(identityFilePath: string): Promise<boolean>;
}

/**
 * The real probe: `sudo -u <agentUser> cat <file>`. Requires root (the
 * installer and join both run as root on a fresh machine). A missing file,
 * a permission denial, or a refused `sudo` all report "cannot read" —
 * isolation holds in every case except a genuinely successful read.
 */
export function createSudoIsolationProbe(agentUser: string): IsolationProbe {
  return {
    canAgentUserRead(identityFilePath: string): Promise<boolean> {
      return new Promise((resolve) => {
        const child = spawn("sudo", ["-u", agentUser, "cat", identityFilePath], { stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
    },
  };
}

/**
 * The gate: throws {@link IsolationVerificationError} when the agent user
 * can read the identity file. On success, the caller may proceed to the
 * join-token exchange — and only then.
 */
export async function verifyIsolation(
  identityFilePath: string,
  probe: IsolationProbe,
): Promise<void> {
  const readable = await probe.canAgentUserRead(identityFilePath);
  if (readable) {
    throw new IsolationVerificationError(
      `isolation check failed: the agent user can read ${identityFilePath}. ` +
        `The Runner would hand its own credential to the agent it is supposed to confine. ` +
        `Fix the installation (identity file owned by the Runner user, mode 0600, agent ` +
        `running under its own user) before exchanging the join token.`,
    );
  }
}
