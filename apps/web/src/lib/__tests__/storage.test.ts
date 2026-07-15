import path from "node:path";
import { describe, expect, it } from "vitest";
import { appConfig } from "@/lib/config";
import { resolveInsideDataDir } from "@/lib/storage";

describe("storage containment", () => {
  it("rejects sibling paths that merely share the data-dir prefix", () => {
    const sibling = path.join(`${appConfig.dataDir}-attacker`, "file.bin");
    expect(() => resolveInsideDataDir(sibling)).toThrow("Path traversal rejected");
  });
});
