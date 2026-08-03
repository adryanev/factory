/**
 * Acceptance criterion: "tidak ada credential di path maupun query string"
 * enforced as a test over the generated OpenAPI document — not left as a
 * convention future route authors have to remember.
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
    it(`path template "${pathTemplate}" has no credential-shaped segment`, () => {
      for (const segment of pathTemplate.split("/")) {
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
