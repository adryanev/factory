/**
 * Every read or write of `projects` / `project_members` goes through here.
 * This is the file the "line this issue exists to establish" is actually
 * about — see `domain/index.ts` for how routes are structurally prevented
 * from reaching these tables any other way.
 */
import { and, eq } from "drizzle-orm";
import { generateId, type Id } from "@factory/shared";
import { orgMembers, projectMembers, projects } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { recordAuditEvent } from "./audit.js";
import { DomainValidationError, ForbiddenError, NotFoundError } from "./errors.js";

export type ProjectRole = "admin" | "member";
export type Project = typeof projects.$inferSelect;

/**
 * Exported for `domain/runners.ts`: the Runner pool is org-wide, not
 * Project-scoped (see `db/schema/runners.ts` — no `project_id`), so its
 * operator actions (mint a join token, set policy, drain, revoke) gate on
 * org `owner`, the same role this file already resolves for Project
 * creation. Reused rather than reimplemented — a second copy of "how do we
 * find someone's org role" is exactly the kind of duplicate this codebase's
 * DRY rule (third occurrence, not second) still doesn't justify skipping the
 * export for.
 */
export async function getOrgRole(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
): Promise<"owner" | "member" | null> {
  if (principal.kind !== "user") {
    return null;
  }
  const [row] = await deps.db.select().from(orgMembers).where(eq(orgMembers.principalId, principal.id));
  return row?.role ?? null;
}

async function getProjectRole(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<ProjectRole | null> {
  // Only Users can be Project members — `project_members.principal_id`
  // references `users.principal_id`, not `principals.id` (see
  // `db/schema/projects.ts`). A ServiceAccount is a member of exactly one
  // Project structurally (`service_accounts.project_id`), never via this
  // table.
  if (principal.kind !== "user") {
    return null;
  }
  const [row] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.principalId, principal.id)));
  return row?.role ?? null;
}

/** Plain membership check by principal id, not by `Principal` object — used by `groups.ts` to validate a *target* of a write, not the caller. Not itself a permission check, so it doesn't throw. */
export async function isProjectMember(
  deps: Pick<AppDeps, "db">,
  principalId: Id<"user">,
  projectId: Id<"project">,
): Promise<boolean> {
  const [row] = await deps.db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.principalId, principalId)));
  return row !== undefined;
}

/** Projects the caller is a member of. Never all Projects — there is no "list everything" for anyone but a direct table query, which routes cannot do (see `domain/index.ts`). */
export async function listProjectsForPrincipal(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
): Promise<Project[]> {
  if (principal.kind !== "user") {
    return []; // see `getProjectRole` — a ServiceAccount is never a `project_members` row.
  }
  const rows = await deps.db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.principalId, principal.id));
  return rows.map((row) => row.project);
}

/** Org `owner` power (spec: "Auth, tim, dan otorisasi" — `owner` "buat Project"). Deliberately does not add the creator as a member — see `selfAddAsProjectMember`; creating infrastructure is not the same act as accessing its data. */
export async function createProject(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  name: string,
): Promise<Project> {
  const orgRole = await getOrgRole(deps, principal);
  if (orgRole !== "owner") {
    throw new ForbiddenError("forbidden_not_org_owner", "only an org owner may create a project");
  }

  const [project] = await deps.db.insert(projects).values({ id: generateId("project"), name }).returning();
  await recordAuditEvent(deps, {
    actor: principal,
    projectId: project!.id,
    action: "project.created",
    targetType: "project",
    targetId: project!.id,
  });
  return project!;
}

/**
 * Read gate for every Project-scoped resource. 403 is checked before 404 is
 * even possible to observe from outside: a non-member gets the same 403
 * whether the id exists or not is **not** true here — the spec is explicit
 * that "403 beats 404" only in the sense that a *real* Project answers 403
 * before 404 would otherwise apply, and a Project that truly does not exist
 * still answers 404. What's deliberately leaked is exactly stated: id
 * existence, not membership.
 */
export async function getProjectForPrincipal(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<Project> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) {
    throw new NotFoundError("project", projectId);
  }

  const role = await getProjectRole(deps, principal, projectId);
  if (role) {
    return project;
  }

  const orgRole = await getOrgRole(deps, principal);
  if (orgRole === "owner") {
    throw new ForbiddenError(
      "forbidden_not_project_member_org_owner",
      `you are not a member of project ${projectId}. As an org owner you may add yourself as an admin member via POST /projects/${projectId}/members/self — this action is recorded in the audit log.`,
    );
  }
  throw new ForbiddenError(
    "forbidden_not_project_member",
    `you are not a member of project ${projectId}. Ask a project admin to add you.`,
  );
}

/** Throws unless `principal` is `admin` on `projectId`. The gate every mutating Project-scoped domain function in later issues is expected to call first. */
export async function requireProjectAdmin(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<void> {
  await getProjectForPrincipal(deps, principal, projectId); // 404 first: an admin check on a nonexistent project should still 404.
  const role = await getProjectRole(deps, principal, projectId);
  if (role !== "admin") {
    throw new ForbiddenError(
      "forbidden_not_project_admin",
      `you are not an admin of project ${projectId}; only a project admin may do this`,
    );
  }
}

/** Throws unless `principal` is any member (`admin` or `member`) of `projectId`. */
export async function requireProjectMembership(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<void> {
  await getProjectForPrincipal(deps, principal, projectId);
}

/**
 * Admin-only settings write for a Project. Today the knobs are
 * `allowSharedAgentCredential` (the User→ServiceAccount credential fallback,
 * **default off** — spec: "Fallback User→ServiceAccount lewat
 * `allowSharedAgentCredential`, bawaan mati"), the one notification channel
 * webhook, and `automationEnabled` — the incident kill switch that turns off
 * every automation trigger of the Project at once, without a PR to every
 * Repository that has `on:` (ticket 22: "Ia hanya bisa mematikan, tidak
 * pernah menyalakan sesuatu yang tidak ditulis di file"). It can only turn
 * off; it cannot express a trigger. The toggle is its own audit kind — an
 * incident switch deserves its own line, not a settings blob. Returning the
 * updated Project row keeps the response truthful (the write is idempotent).
 */
export async function updateProjectSettings(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  patch: {
    allowSharedAgentCredential?: boolean;
    notificationWebhookUrl?: string | null;
    automationEnabled?: boolean;
  },
): Promise<Project> {
  await requireProjectAdmin(deps, principal, projectId);
  if (patch.notificationWebhookUrl !== undefined && patch.notificationWebhookUrl !== null) {
    try {
      const url = new URL(patch.notificationWebhookUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new DomainValidationError(
        "notification_webhook_url_invalid",
        "notification webhook URL must be an HTTP or HTTPS URL",
      );
    }
  }
  const [updated] = await deps.db
    .update(projects)
    .set({
      ...(patch.allowSharedAgentCredential !== undefined
        ? { allowSharedAgentCredential: patch.allowSharedAgentCredential }
        : {}),
      ...(patch.notificationWebhookUrl !== undefined
        ? { notificationWebhookUrl: patch.notificationWebhookUrl }
        : {}),
      ...(patch.automationEnabled !== undefined ? { automationEnabled: patch.automationEnabled } : {}),
    })
    .where(eq(projects.id, projectId))
    .returning();

  const metadata: Record<string, unknown> = {};
  if (patch.allowSharedAgentCredential !== undefined) {
    metadata.allowSharedAgentCredential = patch.allowSharedAgentCredential;
  }
  if (patch.notificationWebhookUrl !== undefined) {
    metadata.notificationWebhookConfigured = patch.notificationWebhookUrl !== null;
  }
  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "project.settings_updated",
    targetType: "project",
    targetId: projectId,
    metadata,
  });
  if (patch.automationEnabled !== undefined) {
    await recordAuditEvent(deps, {
      actor: principal,
      projectId,
      action: "project.automation_enabled_updated",
      targetType: "project",
      targetId: projectId,
      metadata: { automationEnabled: patch.automationEnabled },
    });
  }
  return updated!;
}

/** Admin-only. Upserts, so changing an existing member's role is the same call as adding a new one — one endpoint, not two for adjacent behavior. */
export async function addProjectMember(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  targetPrincipalId: Id<"user">,
  role: ProjectRole,
): Promise<void> {
  await requireProjectAdmin(deps, principal, projectId);

  await deps.db
    .insert(projectMembers)
    .values({ projectId, principalId: targetPrincipalId, role })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.principalId], set: { role } });

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "project.member_added",
    targetType: "user",
    targetId: targetPrincipalId,
    metadata: { role },
  });
}

/**
 * The escape hatch the acceptance criteria names explicitly: an org owner,
 * denied a Project's data, adds themselves — always as `admin`, never
 * `member`. Anything less would leave them unable to manage the very
 * membership they just needed to bootstrap, silently reproducing the
 * lockout this exists to end. Always audited, same event kind as an
 * admin-added member, with `selfAddedByOrgOwner: true` in metadata so the
 * two paths stay distinguishable without growing the action vocabulary.
 */
export async function selfAddAsProjectMember(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<void> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) {
    throw new NotFoundError("project", projectId);
  }
  const orgRole = await getOrgRole(deps, principal);
  if (orgRole !== "owner") {
    throw new ForbiddenError(
      "forbidden_not_org_owner",
      "only an org owner may add themselves to a project they are not already a member of",
    );
  }
  if (principal.kind !== "user") {
    throw new ForbiddenError("forbidden_not_org_owner", "only a user principal can be a project member");
  }

  await deps.db
    .insert(projectMembers)
    .values({ projectId, principalId: principal.id, role: "admin" })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.principalId],
      set: { role: "admin" },
    });

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "project.member_added",
    targetType: "user",
    targetId: principal.id,
    metadata: { role: "admin", selfAddedByOrgOwner: true },
  });
}
