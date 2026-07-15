import { beforeEach, describe, expect, it, vi } from "vitest";
import { appConfig } from "@/lib/config";

const mocks = vi.hoisted(() => ({
  parseUpload: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  createFile: vi.fn(),
  createAudit: vi.fn(),
  enqueue: vi.fn(),
  removeQueued: vi.fn(),
  removeDirectory: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ default: { rename: mocks.rename, rm: mocks.rm } }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    job: { create: mocks.createJob, update: mocks.updateJob, delete: mocks.deleteJob },
    fileArtifact: { create: mocks.createFile },
    auditEvent: { create: mocks.createAudit },
  },
}));
vi.mock("@/lib/queue", () => ({ enqueueConversionJob: mocks.enqueue, removeQueuedJob: mocks.removeQueued }));
vi.mock("@/lib/multipart", () => ({
  MultipartUploadError: class MultipartUploadError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  },
  parseUploadMultipart: mocks.parseUpload,
}));
vi.mock("@/lib/security", () => ({
  consumeRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue("203.0.113.7"),
  detectMimeFromBuffer: vi.fn().mockReturnValue("audio/mpeg"),
  isMimeMismatch: vi.fn().mockReturnValue(false),
  scanUploadFile: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/storage", () => ({
  ensureJobDir: vi.fn().mockResolvedValue("/data/jobs/job-1"),
  sanitizeFilename: vi.fn((value: string) => value),
  removeJobDirectory: mocks.removeDirectory,
}));

import { POST } from "../../../app/api/jobs/upload/route";

const storedJob = {
  id: "job-1",
  userId: "user-1",
  sourceType: "upload",
  status: "queued",
  attemptCount: 0,
  maxAttempts: 3,
  sourceUrl: null,
  inputFilename: "song.mp3",
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

describe("upload route admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createJob.mockResolvedValue(storedJob);
    mocks.updateJob.mockResolvedValue({});
    mocks.deleteJob.mockResolvedValue({});
    mocks.createFile.mockResolvedValue({});
    mocks.createAudit.mockResolvedValue({});
    mocks.enqueue.mockResolvedValue({ id: "queue-1" });
    mocks.parseUpload.mockResolvedValue({
      tempDir: "/data/incoming/upload-1",
      tempPath: "/data/incoming/upload-1/payload",
      filename: "song.mp3",
      reportedMime: "audio/mpeg",
      sizeBytes: 5,
      sha256: "sha256",
      headerSample: Buffer.from("ID3-audio"),
      fields: { outputFormat: "mp3", audioQuality: "standard", videoQuality: "p720" },
    });
    mocks.rename.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.removeQueued.mockResolvedValue(undefined);
    mocks.removeDirectory.mockResolvedValue(undefined);
  });

  it("rejects an oversized request before parsing multipart data", async () => {
    const request = {
      headers: new Headers({ "content-length": String(appConfig.maxUploadBytes + 1024 * 1024 + 1) }),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(413);
    expect(mocks.parseUpload).not.toHaveBeenCalled();
  });

  it("compensates database and disk state when queueing fails", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await POST({ headers: new Headers({ "content-length": "512" }) } as never);

    expect(response.status).toBe(503);
    expect(mocks.removeDirectory).toHaveBeenCalledWith("job-1");
    expect(mocks.deleteJob).toHaveBeenCalledWith({ where: { id: "job-1" } });
  });

  it("returns the accepted job when audit logging fails after queueing", async () => {
    mocks.createAudit.mockRejectedValueOnce(new Error("audit store unavailable"));

    const response = await POST({ headers: new Headers({ "content-length": "512" }) } as never);

    expect(response.status).toBe(201);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.deleteJob).not.toHaveBeenCalled();
  });
});
