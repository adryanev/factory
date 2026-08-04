# Security model

What factory protects, how, and — explicitly — the five things it
**deliberately does not** protect (spec: "Lima hal yang sengaja tidak
dilindungi ditulis eksplisit di dokumentasi keamanan"). The accepted threat
class throughout is **prompt injection**: an agent *persuaded* to read its
process environment, steal tokens, and push code. Everything below follows
from defending against that, and only that.

## What is protected, structurally

- **Master key lives in a file, never an env var.** The path may ride
  `FACTORY_MASTER_KEY_FILE`; the material never does. A prompt-injected
  agent that dumps `/proc/self/environ` gets a path, not a key
  (CVE-2025-66032).
- **Secrets are AES-256-GCM encrypted at rest** with AAD = secret id +
  owning Principal id. A row copied to another Principal cannot decrypt —
  the invariant is cryptographic, not a `WHERE` clause. `nonce` and
  `auth_tag` are separate columns, so a wrong length cannot be written
  silently. `key_version` per row makes master-key rotation incremental and
  interruptible.
- **Keys attach to a ServiceAccount, not to a Project** — a Run's secrets
  resolve through its credential Principal. The fallback
  `allowSharedAgentCredential` (User → ServiceAccount) defaults **off** and
  its use is visible in two separate `runs` attribution columns.
- **Secrets ride the `/claim` payload** and are handed directly to the agent
  call — never written to a file inside the sandbox.
- **Default-deny egress** from the sandbox; the per-Project allowlist is the
  only exception set, and every change is audited.
- **`exec:host` runs the agent as a separate OS user** from the Runner, so
  that user cannot read the Runner's secret files (mode `0600`).

## The five things deliberately NOT protected

These are accepted costs, stated explicitly so nobody mistakes a documented
non-goal for a regression.

1. **An agent that is malicious by design.** We defend against an agent that
   is *persuaded* to misbehave, not one built to steal. A hostile agent can
   print its own key material to stdout — redaction is best-effort and is
   explicitly not a security control.
2. **Local privilege escalation on a Runner in `exec:host`.** Host execution
   has no hard isolation boundary; its trust level is a developer laptop.
3. **Secrets visible via `ps` / `docker inspect`** to anyone with a shell on
   that Runner. Docker-mode secrets are passed as shell env assignments in
   the command line, which `docker inspect` shows; host-mode secrets ride the
   process environment (not argv), but a shell on the Runner is already a
   Runner.
4. **A Project `admin` leaking that Project's own secrets.** An admin holds
   them; that is the role.
5. **Retroactive log cleanup.** A secret already captured in a log is not
   scrubbed when the secret is rotated or deleted.
