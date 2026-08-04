import { generateId, type Id } from "@factory/shared";
import { auditLog } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";

/**
 * Closed-ish vocabulary of audit event kinds written so far. The spec says
 * "sepuluh jenis kejadian" (ten kinds) for the whole system; issue #3 added
 * seven (login x2, logout, project create/add-member, group
 * create/add-member) and issue #4 added `run.triggered`. `action` is `text`
 * without a CHECK in the schema on purpose (see `db/schema/audit_log.ts`) —
 * later issues add their own kinds here without a migration. This union is
 * the closed set *this file* is willing to write; it is not a DB-level
 * constraint.
 */
export type AuditAction =
  | "auth.login_github"
  | "auth.login_breakglass"
  | "auth.logout"
  | "project.created"
  | "project.member_added"
  | "group.created"
  | "group.member_added"
  | "run.triggered"
  | "run.cancel_requested"
  | "project.service_account_created"
  | "project.egress_allowlist_updated"
  | "project.settings_updated"
  | "secret.stored"
  | "secret.updated"
  | "secret.deleted"
  | "secret.rotated";

export interface AuditEvent {
  actor: Principal;
  projectId?: Id<"project">;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  /**
   * Free-form context for the event. Never put a secret, password, or
   * session token value here — see the callers in `auth.ts`, which pass
   * only identifiers and booleans, never credential material (spec: "Nilai
   * secret tidak pernah dicatat").
   */
  metadata?: Record<string, unknown>;
}

/**
 * The only function in this codebase that inserts into `audit_log`. Not
 * itself Principal-gated — writing an audit row is a side effect of an
 * authorization decision some *other* domain function already made, not a
 * decision of its own. Callers are every other file in `src/domain/**`;
 * routes never call this directly.
 */
export async function recordAuditEvent(deps: Pick<AppDeps, "db">, event: AuditEvent): Promise<void> {
  await deps.db.insert(auditLog).values({
    id: generateId("audit"),
    projectId: event.projectId,
    actorPrincipalId: event.actor.id,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: event.metadata,
  });
}
