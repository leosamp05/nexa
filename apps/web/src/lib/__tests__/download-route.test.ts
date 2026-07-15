import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  audit: vi.fn(),
  readFile: vi.fn().mockRejectedValue(new Error("whole-file reads are forbidden")),
  outputPath: "",
}));

vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    job: { findFirst: mocks.findFirst },
    auditEvent: { create: mocks.audit },
  },
}));
vi.mock("@/lib/storage", () => ({ resolveInsideDataDir: vi.fn(() => mocks.outputPath) }));

import { GET } from "../../../app/api/jobs/[id]/download/route";

let tempDir = "";

describe("download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexa-download-test-"));
    mocks.outputPath = path.join(tempDir, "converted.txt");
    fs.writeFileSync(mocks.outputPath, "streamed output");
    mocks.findFirst.mockResolvedValue({
      id: "job-1",
      status: "done",
      expiresAt: new Date(Date.now() + 60_000),
      files: [{ kind: "output", path: mocks.outputPath, filename: "converted.txt", mimeType: "text/plain", sizeBytes: 15n }],
    });
    mocks.audit.mockResolvedValue({});
  });

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("streams the artifact instead of buffering it with readFile", async () => {
    const response = await GET({} as never, { params: Promise.resolve({ id: "job-1" }) });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("streamed output");
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
