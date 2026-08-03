/**
 * Group: a named set of Project members, used to say who is *asked* a
 * Question — never who may do what (CONTEXT.md). The one invariant this
 * file exists to hold structurally: a Group's members are always members of
 * the Group's Project, checked here, not left to the UI to enforce (this
 * issue's acceptance criteria, verbatim).
 */
import { eq } from "drizzle-orm";
import { generateId, type Id } from "@factory/shared";
import { groupMembers, groups } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { isProjectMember, requireProjectMembership } from "./projects.js";
import { recordAuditEvent } from "./audit.js";
import { DomainValidationError, NotFoundError } from "./errors.js";

export type Group = typeof groups.$inferSelect;

/** Any Project member may create a Group — it names "who answers", not a permission, so it carries none of the stakes `admin`-gated actions do. */
export async function createGroup(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  name: string,
): Promise<Group> {
  await requireProjectMembership(deps, principal, projectId);

  const [group] = await deps.db
    .insert(groups)
    .values({ id: generateId("group"), projectId, name })
    .returning();

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "group.created",
    targetType: "group",
    targetId: group!.id,
    metadata: { name },
  });
  return group!;
}

export async function addGroupMember(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  groupId: Id<"group">,
  targetPrincipalId: Id<"user">,
): Promise<void> {
  const [group] = await deps.db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) {
    throw new NotFoundError("group", groupId);
  }
  await requireProjectMembership(deps, principal, group.projectId);

  if (!(await isProjectMember(deps, targetPrincipalId, group.projectId))) {
    throw new DomainValidationError(
      "invalid_group_member",
      `principal ${targetPrincipalId} is not a member of project ${group.projectId}; a Group can only contain members of its own Project`,
    );
  }

  await deps.db.insert(groupMembers).values({ groupId, principalId: targetPrincipalId }).onConflictDoNothing();

  await recordAuditEvent(deps, {
    actor: principal,
    projectId: group.projectId,
    action: "group.member_added",
    targetType: "user",
    targetId: targetPrincipalId,
    metadata: { groupId },
  });
}
