import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  transaction: vi.fn(),
  removeDirectory: vi.fn(),
  audit: vi.fn(),
  deleteJob: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    job: { findFirst: mocks.findFirst, delete: mocks.deleteJob },
    auditEvent: { create: mocks.audit },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/storage", () => ({
  jobDirPath: vi.fn().mockReturnValue("/data/jobs/job-1"),
  removeJobDirectory: mocks.removeDirectory,
  removeDirectoryIfEmpty: mocks.removeDirectory,
  removeFileIfExists: vi.fn(),
  resolveInsideDataDir: vi.fn((value: string) => value),
}));

import { DELETE } from "../../../app/api/jobs/[id]/route";

describe("delete route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ id: "job-1", status: "processing", files: [] });
    mocks.transaction.mockResolvedValue([]);
  });

  it("refuses deletion while conversion work is active", async () => {
    const response = await DELETE({} as never, { params: Promise.resolve({ id: "job-1" }) });

    expect(response.status).toBe(409);
    expect(mocks.removeDirectory).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
