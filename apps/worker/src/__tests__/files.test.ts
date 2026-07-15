import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../lib/config";
import { resolveInsideDataDir, sha256File } from "../lib/files";

const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempPaths.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
});

describe("worker file helpers", () => {
  it("hashes through a stream without calling whole-file readFile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexa-hash-test-"));
    tempPaths.push(dir);
    const file = path.join(dir, "output.bin");
    const bytes = Buffer.from("stream me");
    await fs.writeFile(file, bytes);
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("whole-file reads are forbidden"));

    await expect(sha256File(file)).resolves.toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("rejects sibling paths that only share the configured prefix", () => {
    expect(() => resolveInsideDataDir(path.join(`${config.dataDir}-attacker`, "file.bin"))).toThrow("Unsafe path");
  });
});
