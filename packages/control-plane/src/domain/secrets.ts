/**
 * ServiceAccounts and the Project's encrypted secrets.
 *
 * The structural invariant of this issue — "credential menempel ke Principal,
 * tidak pernah ke Run" — is enforced here in two ways:
 *
 *  1. **Keys attach to a ServiceAccount, not to a Project.** A stored secret
 *     carries `ownerPrincipalId` = a ServiceAccount *of that same Project*
 *     (checked, not assumed: the ServiceAccount row is re-read inside the
 *     store path). A Project's secrets are reachable only through its
 *     ServiceAccount, which is exactly the principal a Run's `credential`
 *     attribution resolves to at claim time.
 *  2. **The ciphertext is bound to the owning Principal cryptographically**:
 *     AAD = secret id + owner principal id (see `secret-crypto.ts`). Copying
 *     a row to another Principal makes it undecryptable — no `WHERE` clause
 *     needs to exist for the invariant to hold.
 *
 * Secrets are **write-only**: nothing in this file (and therefore no route)
 * ever returns a decrypted value. The metadata list (`listSecrets`) returns
 * names and key versions so an admin can observe rotation progress, and that
 * is all.
 *
 * Rotation (`rotateProjectSecrets`) re-encrypts rows under the file's current
 * master key version, one row at a time. It is incremental (each row is
 * independent) and interruptible (a row left on an old version still decrypts
 * because the old version is still in the key file), and it never disturbs a
 * Run in flight — the Run's claim payload already carried its plaintext
 * values into the Runner before rotation touched the rows.
 */
import { and, eq, ne } from "drizzle-orm";
import { generateId, type Id } from "@factory/shared";
import { principals, secrets, serviceAccounts } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { recordAuditEvent } from "./audit.js";
import { DomainValidationError, ForbiddenError, NotFoundError } from "./errors.js";
import { requireProjectAdmin, requireProjectMembership } from "./projects.js";
import {
  buildSecretAad,
  decryptSecretValue,
  encryptSecretValue,
  SECRET_MIN_VALUE_BYTES,
} from "./secret-crypto.js";
import type { Principal } from "./principal.js";

export interface ServiceAccountInfo {
  id: Id<"serviceaccount">;
  projectId: Id<"project">;
  name: string;
}

/** Creates a ServiceAccount (a `principals` row + its `service_accounts` row, one transaction). Project `admin` only. */
export async function createServiceAccount(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  name: string,
): Promise<ServiceAccountInfo> {
  await requireProjectAdmin(deps, principal, projectId);
  const id = generateId("serviceaccount");
  await deps.db.transaction(async (tx) => {
    await tx.insert(principals).values({ id, kind: "service_account" });
    await tx.insert(serviceAccounts).values({ principalId: id, projectId, name });
  });
  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "project.service_account_created",
    targetType: "serviceaccount",
    targetId: id,
    metadata: { name },
  });
  return { id, projectId, name };
}

/** Lists a Project's ServiceAccounts. Any member may read names — names are not credentials. */
export async function listServiceAccounts(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<ServiceAccountInfo[]> {
  await requireProjectMembership(deps, principal, projectId);
  const rows = await deps.db
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.projectId, projectId))
    .orderBy(serviceAccounts.principalId);
  return rows.map((row) => ({ id: row.principalId, projectId, name: row.name }));
}

/** Metadata only — never the value. `keyVersion` exists so rotation progress is observable. */
export interface StoredSecret {
  id: Id<"secret">;
  projectId: Id<"project">;
  ownerPrincipalId: Id<"user"> | Id<"serviceaccount">;
  name: string;
  keyVersion: number;
}

export interface PutSecretInput {
  /** Client-generated — the id is part of the AAD, so it must exist before the row is encrypted (spec: "AAD enkripsi butuh id ada sebelum baris dienkripsi"). */
  id: Id<"secret">;
  name: string;
  value: string;
  /** The ServiceAccount (of this same Project) that owns the secret — structurally, not by convention. */
  ownerPrincipalId: Id<"serviceaccount">;
}

/**
 * Stores (or, on a `(project_id, name)` conflict, re-stores) a secret.
 * Project `admin` only. Write-only: the value is encrypted and the returned
 * metadata carries no plaintext.
 *
 * The AAD binds the ciphertext to the row's *actual* id. On a name conflict
 * the row keeps its original id (the primary key cannot change), so the
 * effective id — used for both encryption and the returned metadata — is the
 * existing row's, never the caller's fresh id. Otherwise a same-name re-store
 * with a new id would encrypt under one id and decrypt under another.
 */
export async function storeSecret(
  deps: Pick<AppDeps, "db" | "keyring" | "random">,
  principal: Principal,
  projectId: Id<"project">,
  input: PutSecretInput,
): Promise<StoredSecret> {
  await requireProjectAdmin(deps, principal, projectId);
  if (Buffer.byteLength(input.value, "utf-8") < SECRET_MIN_VALUE_BYTES) {
    throw new DomainValidationError(
      "secret_too_short",
      `secret values must be at least ${SECRET_MIN_VALUE_BYTES} bytes (shorter values cannot be reliably redacted)`,
    );
  }
  await requireServiceAccountOfProject(deps, projectId, input.ownerPrincipalId);

  const [existing] = await deps.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.projectId, projectId), eq(secrets.name, input.name)));
  const effectiveId = existing?.id ?? input.id;

  const keyVersion = deps.keyring.currentVersion();
  const key = deps.keyring.key(keyVersion);
  const aad = buildSecretAad(effectiveId, input.ownerPrincipalId);
  const { ciphertext, nonce, authTag } = encryptSecretValue(key, aad, input.value, deps.random);

  await deps.db
    .insert(secrets)
    .values({
      id: effectiveId,
      projectId,
      ownerPrincipalId: input.ownerPrincipalId,
      name: input.name,
      ciphertext,
      nonce,
      authTag,
      keyVersion,
    })
    .onConflictDoUpdate({
      target: [secrets.projectId, secrets.name],
      set: { ciphertext, nonce, authTag, keyVersion },
    });

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "secret.stored",
    targetType: "secret",
    targetId: effectiveId,
    metadata: { name: input.name, keyVersion },
  });

  return { id: effectiveId, projectId, ownerPrincipalId: input.ownerPrincipalId, name: input.name, keyVersion };
}

/**
 * Updates a stored secret's value, re-encrypting under the *current* master
 * key version (so a store-after-rotation writes the newest version). Project
 * `admin` only. Never returns the value.
 */
export async function updateSecretValue(
  deps: Pick<AppDeps, "db" | "keyring" | "random">,
  principal: Principal,
  projectId: Id<"project">,
  secretId: Id<"secret">,
  value: string,
): Promise<StoredSecret> {
  await requireProjectAdmin(deps, principal, projectId);
  if (Buffer.byteLength(value, "utf-8") < SECRET_MIN_VALUE_BYTES) {
    throw new DomainValidationError(
      "secret_too_short",
      `secret values must be at least ${SECRET_MIN_VALUE_BYTES} bytes (shorter values cannot be reliably redacted)`,
    );
  }
  const [row] = await deps.db.select().from(secrets).where(eq(secrets.id, secretId));
  if (!row) {
    throw new NotFoundError("secret", secretId);
  }
  if (row.projectId !== projectId) {
    throw new NotFoundError("secret", secretId);
  }

  const keyVersion = deps.keyring.currentVersion();
  const key = deps.keyring.key(keyVersion);
  const aad = buildSecretAad(row.id, row.ownerPrincipalId);
  const { ciphertext, nonce, authTag } = encryptSecretValue(key, aad, value, deps.random);

  await deps.db
    .update(secrets)
    .set({ ciphertext, nonce, authTag, keyVersion })
    .where(eq(secrets.id, secretId));

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "secret.updated",
    targetType: "secret",
    targetId: secretId,
    metadata: { name: row.name, keyVersion },
  });

  return { id: secretId, projectId, ownerPrincipalId: row.ownerPrincipalId, name: row.name, keyVersion };
}

/** Deletes a secret. Project `admin` only, audited. */
export async function deleteSecret(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  secretId: Id<"secret">,
): Promise<void> {
  await requireProjectAdmin(deps, principal, projectId);
  const [row] = await deps.db.select().from(secrets).where(eq(secrets.id, secretId));
  if (!row || row.projectId !== projectId) {
    throw new NotFoundError("secret", secretId);
  }
  await deps.db.delete(secrets).where(eq(secrets.id, secretId));
  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "secret.deleted",
    targetType: "secret",
    targetId: secretId,
    metadata: { name: row.name },
  });
}

/** Lists a Project's secrets — metadata only, never values (write-only surface). Any member may see names/versions. */
export async function listSecrets(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<StoredSecret[]> {
  await requireProjectMembership(deps, principal, projectId);
  const rows = await deps.db
    .select()
    .from(secrets)
    .where(eq(secrets.projectId, projectId))
    .orderBy(secrets.name);
  return rows.map((row) => ({
    id: row.id,
    projectId,
    ownerPrincipalId: row.ownerPrincipalId,
    name: row.name,
    keyVersion: row.keyVersion,
  }));
}

/**
 * Re-encrypts every secret of the Project whose `key_version` differs from
 * the current master key version, one row at a time. Incremental and
 * interruptible: any row not yet rewritten still decrypts under its old
 * version (still present in the key file). Never disturbs a Run in flight.
 * Returns how many rows moved to which version.
 */
export async function rotateProjectSecrets(
  deps: Pick<AppDeps, "db" | "keyring" | "random">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<{ rotated: number; toVersion: number }> {
  await requireProjectAdmin(deps, principal, projectId);
  const toVersion = deps.keyring.currentVersion();
  const rows = await deps.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.projectId, projectId), ne(secrets.keyVersion, toVersion)));

  let rotated = 0;
  for (const row of rows) {
    const oldKey = deps.keyring.key(row.keyVersion);
    const aad = buildSecretAad(row.id, row.ownerPrincipalId);
    const value = decryptSecretValue(oldKey, aad, {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.authTag,
    });
    const newKey = deps.keyring.key(toVersion);
    const { ciphertext, nonce, authTag } = encryptSecretValue(newKey, aad, value, deps.random);
    await deps.db
      .update(secrets)
      .set({ ciphertext, nonce, authTag, keyVersion: toVersion })
      .where(eq(secrets.id, row.id));
    rotated += 1;
  }

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "secret.rotated",
    targetType: "project",
    targetId: projectId,
    metadata: { rotated, toVersion },
  });

  return { rotated, toVersion };
}

/**
 * Resolves a principal's secrets for a claim: decrypts every secret owned by
 * `principalId` in `projectId` into a `name -> value` map. This is the only
 * place a stored value is ever read — and it hands the value to the Runner
 * protocol payload, never to a route. A row whose key version is no longer in
 * the key file fails loudly rather than silently dropping a secret.
 */
export async function resolveSecretsForPrincipal(
  deps: Pick<AppDeps, "db" | "keyring">,
  projectId: Id<"project">,
  principalId: Id<"user"> | Id<"serviceaccount">,
): Promise<Record<string, string>> {
  const rows = await deps.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.projectId, projectId), eq(secrets.ownerPrincipalId, principalId)));
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = deps.keyring.key(row.keyVersion);
    const aad = buildSecretAad(row.id, row.ownerPrincipalId);
    out[row.name] = decryptSecretValue(key, aad, {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.authTag,
    });
  }
  return out;
}

/** Throws unless `serviceAccountId` names a ServiceAccount of `projectId` — the structural "keys attach to this Project's ServiceAccount" check. */
async function requireServiceAccountOfProject(
  deps: Pick<AppDeps, "db">,
  projectId: Id<"project">,
  serviceAccountId: Id<"serviceaccount">,
): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.principalId, serviceAccountId), eq(serviceAccounts.projectId, projectId)));
  if (!row) {
    throw new ForbiddenError(
      "forbidden_not_project_service_account",
      `principal ${serviceAccountId} is not a ServiceAccount of this Project; Project secrets attach to a ServiceAccount, not to the Project`,
    );
  }
}
