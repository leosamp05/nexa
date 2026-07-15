import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  enqueue: vi.fn(),
  removeQueued: vi.fn(),
  createAudit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    job: { create: mocks.createJob, update: mocks.updateJob, delete: mocks.deleteJob },
    auditEvent: { create: mocks.createAudit },
  },
}));
vi.mock("@/lib/queue", () => ({ enqueueConversionJob: mocks.enqueue, removeQueuedJob: mocks.removeQueued }));
vi.mock("@/lib/security", () => ({
  consumeRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue("203.0.113.7"),
  validateSourceUrl: vi.fn().mockResolvedValue({ valid: true, host: "youtube.com" }),
  verifyCaptcha: vi.fn().mockResolvedValue(true),
}));

import { POST } from "../../../app/api/jobs/url/route";

const storedJob = {
  id: "job-1",
  userId: "user-1",
  sourceType: "url",
  status: "queued",
  attemptCount: 0,
  maxAttempts: 3,
  sourceUrl: "https://youtube.com/watch?v=abc",
  inputFilename: null,
  outputFormat: "mp3",
  purpose: "personal",
  hasRights: false,
  audioQuality: "standard",
  videoQuality: "p720",
  errorMessage: null,
  queueJobId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  lastErrorAt: null,
  expiresAt: new Date("2026-01-02T00:00:00Z"),
  files: [],
};

describe("URL job creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createJob.mockResolvedValue(storedJob);
    mocks.updateJob.mockResolvedValue({});
    mocks.deleteJob.mockResolvedValue({});
    mocks.removeQueued.mockResolvedValue(undefined);
    mocks.createAudit.mockResolvedValue({});
    mocks.enqueue.mockResolvedValue({ id: "queue-1" });
  });

  it("removes the database job when queueing fails", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));
    const request = new Request("http://localhost/api/jobs/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://youtube.com/watch?v=abc", outputFormat: "mp3" }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(503);
    expect(mocks.deleteJob).toHaveBeenCalledWith({ where: { id: "job-1" } });
  });

  it("returns the accepted job when audit logging fails after queueing", async () => {
    mocks.createAudit.mockRejectedValueOnce(new Error("audit store unavailable"));
    const request = new Request("http://localhost/api/jobs/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://youtube.com/watch?v=abc", outputFormat: "mp3" }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(201);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
  });
});
