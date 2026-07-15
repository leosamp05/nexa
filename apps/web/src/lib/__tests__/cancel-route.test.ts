import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  audit: vi.fn(),
  removeQueued: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    job: { findFirst: mocks.findFirst, update: mocks.update, updateMany: mocks.updateMany },
    auditEvent: { create: mocks.audit },
  },
}));
vi.mock("@/lib/queue", () => ({ removeQueuedJob: mocks.removeQueued }));

import { POST } from "../../../app/api/jobs/[id]/cancel/route";

describe("cancel route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ id: "job-1", status: "queued" });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.audit.mockResolvedValue({});
    mocks.removeQueued.mockResolvedValue(undefined);
  });

  it("changes state only while the owned job is still active", async () => {
    const response = await POST({} as never, { params: Promise.resolve({ id: "job-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1", userId: "user-1", status: { in: ["queued", "processing"] } },
    }));
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
