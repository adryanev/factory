import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's automatic afterEach(cleanup) only registers
// itself when vitest's globals are enabled. This package's tests import
// describe/it/expect explicitly (matching packages/shared, packages/control-
// plane) rather than turning on vitest globals, so cleanup is wired here
// instead — without it, DOM from one test leaks into the next and queries
// like getByRole start matching more than one element.
afterEach(() => {
  cleanup();
});
