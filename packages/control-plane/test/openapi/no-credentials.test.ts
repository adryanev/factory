/**
 * Acceptance criterion: "tidak ada credential di path maupun query string"
 * enforced as a test over the generated OpenAPI document — not left as a
 * convention future route authors have to remember.
 *
 * The rule is scoped to *value-bearing slots*: a path or query **parameter**
 * must never be named credential-shaped, because a caller could substitute a
 * credential value there. A **static resource-noun segment** like `/secrets`
 * or `/service-accounts` is the name of a resource collection, not a value
 * slot — issue #8's admin surface for managing Project secrets lives at
 * `/projects/{id}/secrets`, and the word "secret" in that path is the
 * resource's name, not a place a value could ride. This split is deliberate
 * and documented here so it isn't silently re-narrowed by a future editor.
 */
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../../src/openapi/document.js";

const CREDENTIAL_PATTERN = /token|secret|password|credential|api[-_]?key|access[-_]?key/i;

describe("OpenAPI document: no credentials in path or query string", () => {
  const document = buildOpenApiDocument();

  it("has at least one path to check (fails loudly if the surface goes empty)", () => {
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
  });

  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    it(`path template "${pathTemplate}": every {parameter} is a value-bearing slot, so its name must not be credential-shaped`, () => {
      for (const segment of pathTemplate.split("/")) {
        if (!segment.startsWith("{") || !segment.endsWith("}")) {
          continue; // static segments name resources (/secrets), not value slots.
        }
        const name = segment.replace(/[{}]/g, "");
        expect(CREDENTIAL_PATTERN.test(name)).toBe(false);
      }
    });

    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (typeof operation !== "object" || operation === null || !("parameters" in operation)) {
        continue;
      }
      const parameters = (operation.parameters ?? []) as { name: string; in: string }[];
      for (const parameter of parameters) {
        if (parameter.in !== "query" && parameter.in !== "path") {
          continue;
        }
        it(`${method.toUpperCase()} ${pathTemplate}: ${parameter.in} param "${parameter.name}" is not credential-shaped`, () => {
          expect(CREDENTIAL_PATTERN.test(parameter.name)).toBe(false);
        });
      }
    }
  }
});
