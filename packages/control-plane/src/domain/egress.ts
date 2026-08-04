/**
 * Egress policy: default-deny from the Sandbox, with a per-Project
 * allowlist as the only exception set (spec: "Default-deny egress dari
 * Sandbox adalah kontrol utama"). The allowlist is a Project field
 * (`projects.egress_allowlist`), admin-editable, and every change is
 * recorded in the audit log — the allowlist itself is not a secret, so
 * hostnames ride in audit metadata freely.
 *
 * The enforcement half (turning this allowlist into actual default-deny
 * firewall rules on the Runner) lives in `packages/runner`'s agent-runtime
 * egress module; this file is the control-plane half: the policy shape, its
 * built-in default, and the admin write path.
 */
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { recordAuditEvent } from "./audit.js";
import { requireProjectAdmin } from "./projects.js";
import type { Principal } from "./principal.js";

export { DEFAULT_EGRESS_ALLOWLIST } from "./egress-policy.js";

/**
 * Replaces the Project's egress allowlist wholesale. Project `admin` only.
 * Always audited (`project.egress_allowlist_updated`) with the new list in
 * metadata — hostnames are not secret material, so recording them is the
 * point, not the leak.
 */
export async function setProjectEgressAllowlist(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: string,
  allowlist: string[],
): Promise<string[]> {
  await requireProjectAdmin(deps, principal, projectId as never);
  await deps.db
    .update(projects)
    .set({ egressAllowlist: allowlist })
    .where(eq(projects.id, projectId as never));
  await recordAuditEvent(deps, {
    actor: principal,
    projectId: projectId as never,
    action: "project.egress_allowlist_updated",
    targetType: "project",
    targetId: projectId as never,
    metadata: { allowlist },
  });
  return allowlist;
}
