import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  createFile: vi.fn(),
  createAudit: vi.fn(),
  transaction: vi.fn(),
  convertMedia: vi.fn(),
  runCommand: vi.fn(),
  unlink: vi.fn(),
  removeJobDirectory: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  startProxy: vi.fn(),
  closeProxy: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) },
}));
vi.mock("node:fs/promises", () => ({
  default: { mkdir: mocks.mkdir, stat: mocks.stat, readdir: mocks.readdir, rm: vi.fn() },
}));
vi.mock("../converters/media", () => ({
  isMediaOutput: vi.fn((format: string) => ["mp3", "aac", "ogg", "wav", "mp4", "webm", "mkv"].includes(format)),
  convertMedia: mocks.convertMedia,
}));
vi.mock("../converters/document", () => ({ isDocumentOutput: vi.fn().mockReturnValue(false), convertDocument: vi.fn() }));
vi.mock("../lib/command", () => ({ runCommand: mocks.runCommand }));
vi.mock("../lib/config", () => ({
  config: {
    dataDir: "/data",
    maxDurationSeconds: 3600,
    maxRemoteDownloadBytes: 500 * 1024 * 1024,
    jobTimeoutMs: 900000,
    queueAttempts: 3,
    blockedPatterns: [],
    allowedHosts: ["youtube.com", "youtu.be", "soundcloud.com", "bandcamp.com"],
  },
}));
vi.mock("../lib/files", () => ({
  resolveInsideDataDir: vi.fn((value: string) => value),
  sha256File: vi.fn().mockResolvedValue("sha256"),
  unlinkIfExists: mocks.unlink,
  removeJobDirectory: mocks.removeJobDirectory,
}));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/safe-egress-proxy", () => ({ startSafeEgressProxy: mocks.startProxy }));
vi.mock("../lib/prisma", () => {
  const tx = {
    job: { update: mocks.update, updateMany: mocks.updateMany },
    fileArtifact: { deleteMany: mocks.deleteMany, create: mocks.createFile },
    auditEvent: { create: mocks.createAudit },
  };
  mocks.transaction.mockImplementation(async (operation: unknown) => {
    if (typeof operation === "function") return (operation as (value: typeof tx) => unknown)(tx);
    return Promise.all(operation as Promise<unknown>[]);
  });
  return {
    prisma: {
      job: { findUnique: mocks.findUnique, findMany: mocks.findMany, update: mocks.update, updateMany: mocks.updateMany },
      fileArtifact: { deleteMany: mocks.deleteMany, create: mocks.createFile },
      auditEvent: { create: mocks.createAudit },
      $transaction: mocks.transaction,
    },
  };
});

import { processConversionJob, runCleanupSweep } from "../processors/convert-job";

const uploadJob = {
  id: "job-1",
  userId: "user-1",
  sourceType: "upload",
  status: "queued",
  sourceUrl: null,
  inputFilename: "input.mp3",
  outputFormat: "mp3",
  audioQuality: "standard",
  videoQuality: "p720",
  expiresAt: new Date(Date.now() + 60_000),
  files: [{ kind: "input", path: "/data/jobs/job-1/input.mp3", filename: "input.mp3" }],
};

const converted = {
  outputPath: "/data/jobs/job-1/converted.mp3",
  outputFilename: "converted.mp3",
  mimeType: "audio/mpeg",
};

function currentLeaseStatus() {
  const claim = mocks.updateMany.mock.calls[0]?.[0] as { data?: { startedAt?: Date } } | undefined;
  return { status: "processing", startedAt: claim?.data?.startedAt };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const value of Object.values(mocks)) {
    if (typeof (value as { mockReset?: () => void }).mockReset === "function") {
      (value as { mockReset: () => void }).mockReset();
    }
  }
  const tx = {
    job: { update: mocks.update, updateMany: mocks.updateMany },
    fileArtifact: { deleteMany: mocks.deleteMany, create: mocks.createFile },
    auditEvent: { create: mocks.createAudit },
  };
  mocks.transaction.mockImplementation(async (operation: unknown) => {
    if (typeof operation === "function") return (operation as (value: typeof tx) => unknown)(tx);
    return Promise.all(operation as Promise<unknown>[]);
  });
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ size: 1234 });
  mocks.readdir.mockResolvedValue(["source.mp4"]);
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.createFile.mockResolvedValue({});
  mocks.createAudit.mockResolvedValue({});
  mocks.convertMedia.mockResolvedValue(converted);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.removeJobDirectory.mockResolvedValue(undefined);
  mocks.closeProxy.mockResolvedValue(undefined);
  mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:43123", close: mocks.closeProxy });
  mocks.runCommand.mockImplementation(async (command: string) => command === "ffprobe" ? "60" : "");
});

describe("worker lifecycle", () => {
  it("does not process a job when the queued-to-processing claim loses a cancellation race", async () => {
    mocks.findUnique.mockResolvedValueOnce(uploadJob);
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await processConversionJob("job-1");

    expect(mocks.convertMedia).not.toHaveBeenCalled();
  });

  it("does not requeue a job that was canceled while conversion failed", async () => {
    mocks.findUnique.mockResolvedValueOnce(uploadJob).mockResolvedValueOnce({ status: "canceled" });
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.convertMedia.mockRejectedValueOnce(new Error("ffmpeg failed"));

    await expect(processConversionJob("job-1", { attempt: 1, maxAttempts: 3 })).resolves.toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "queued" }) }));
  });

  it("caps URL downloads before yt-dlp writes the source", async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ ...uploadJob, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=abc", files: [] })
      .mockImplementationOnce(async () => currentLeaseStatus());

    await processConversionJob("job-1");

    const ytDlpCall = mocks.runCommand.mock.calls.find(([command]) => command === "yt-dlp");
    expect(ytDlpCall?.[1]).toEqual(expect.arrayContaining(["--max-filesize", String(500 * 1024 * 1024)]));
  });

  it("routes every yt-dlp request through the validating egress proxy", async () => {
    const sourceUrl = "https://on.soundcloud.com/short";
    mocks.findUnique
      .mockResolvedValueOnce({ ...uploadJob, sourceType: "url", sourceUrl, files: [] })
      .mockImplementationOnce(async () => currentLeaseStatus());

    await processConversionJob("job-1");

    const ytDlpCall = mocks.runCommand.mock.calls.find(([command]) => command === "yt-dlp");
    expect(ytDlpCall?.[1]).toEqual(expect.arrayContaining(["--proxy", "http://127.0.0.1:43123", sourceUrl]));
    expect(mocks.closeProxy).toHaveBeenCalledOnce();
  });

  it("removes the downloaded URL source after publishing the converted output", async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ ...uploadJob, sourceType: "url", sourceUrl: "https://youtube.com/watch?v=abc", files: [] })
      .mockImplementationOnce(async () => currentLeaseStatus());

    await processConversionJob("job-1");

    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/data\/jobs\/job-1\/runs\/[^/]+\/source\.mp4$/));
  });

  it("removes the complete job directory when cancellation wins during conversion", async () => {
    mocks.findUnique.mockResolvedValueOnce(uploadJob).mockResolvedValueOnce({ status: "canceled" });

    await processConversionJob("job-1");

    expect(mocks.removeJobDirectory).toHaveBeenCalledWith("job-1");
  });

  it("enforces duration limits for uploaded media before conversion", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(uploadJob)
      .mockImplementationOnce(async () => currentLeaseStatus());
    mocks.runCommand.mockImplementation(async (command: string) => command === "ffprobe" ? "7200" : "");

    await expect(processConversionJob("job-1", { attempt: 1, maxAttempts: 1 })).rejects.toThrow("Source duration exceeds limit");
    expect(mocks.convertMedia).not.toHaveBeenCalled();
  });

  it("fails deterministic validation errors immediately instead of retrying them", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(uploadJob)
      .mockImplementationOnce(async () => currentLeaseStatus());
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mocks.runCommand.mockImplementation(async (command: string) => command === "ffprobe" ? "7200" : "");

    const result = processConversionJob("job-1", { attempt: 1, maxAttempts: 3 });
    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(result).rejects.toThrow("Source duration exceeds limit");

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "job-1", status: "processing" }),
      data: expect.objectContaining({ status: "failed" }),
    }));
  });

  it("moves a claimed job to a terminal state when its work directory cannot be created", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(uploadJob)
      .mockImplementationOnce(async () => currentLeaseStatus());
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mocks.mkdir.mockRejectedValueOnce(Object.assign(new Error("no space left"), { code: "ENOSPC" }));

    await expect(processConversionJob("job-1", { attempt: 1, maxAttempts: 3 }))
      .rejects.toBeInstanceOf(UnrecoverableError);

    expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "job-1", status: "processing" }),
      data: expect.objectContaining({ status: "failed" }),
    }));
  });

  it("reclaims a processing row when BullMQ redelivers a stalled job", async () => {
    const previousStartedAt = new Date("2026-07-15T10:00:00.000Z");
    mocks.findUnique
      .mockResolvedValueOnce({ ...uploadJob, status: "processing", startedAt: previousStartedAt })
      .mockImplementationOnce(async () => currentLeaseStatus());

    await processConversionJob("job-1", { attempt: 1, maxAttempts: 3 });

    expect(mocks.convertMedia).toHaveBeenCalledOnce();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1", status: "processing", startedAt: previousStartedAt },
      data: expect.objectContaining({ status: "processing" }),
    }));
  });

  it("aborts a running converter when the job is canceled", async () => {
    vi.useFakeTimers();
    mocks.findUnique
      .mockResolvedValueOnce(uploadJob)
      .mockResolvedValueOnce({ status: "canceled" })
      .mockResolvedValueOnce({ status: "canceled" });
    mocks.convertMedia.mockImplementationOnce(async (params: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () => reject(params.signal?.reason ?? new Error("aborted")), { once: true });
      });
      return converted;
    });

    const processing = processConversionJob("job-1", { attempt: 1, maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(750);

    await expect(processing).resolves.toBeUndefined();
    expect(mocks.convertMedia.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(mocks.removeJobDirectory).toHaveBeenCalledWith("job-1");
    vi.useRealTimers();
  });

  it("still retries transient network failures", async () => {
    mocks.findUnique
      .mockResolvedValueOnce(uploadJob)
      .mockImplementationOnce(async () => currentLeaseStatus());
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mocks.convertMedia.mockRejectedValueOnce(new Error("Temporary DNS resolution error. Please retry."));

    await expect(processConversionJob("job-1", { attempt: 1, maxAttempts: 3 })).rejects.toThrow("Temporary DNS resolution error");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "queued" }),
    }));
  });

  it("expires terminal jobs only and removes the complete per-job directory", async () => {
    mocks.findMany.mockResolvedValueOnce([{ ...uploadJob, status: "done" }]);

    await runCleanupSweep();

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["done", "failed", "canceled"] } }),
    }));
    expect(mocks.removeJobDirectory).toHaveBeenCalledWith("job-1");
  });
});
