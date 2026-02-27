import { FileArtifact, Job } from "@prisma/client";

export function serializeJob(job: Job & { files?: FileArtifact[] }) {
  return {
    id: job.id,
    sourceType: job.sourceType,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    sourceUrl: job.sourceUrl,
    inputFilename: job.inputFilename,
    outputFormat: job.outputFormat,
    purpose: job.purpose,
    hasRights: job.hasRights,
    audioQuality: job.audioQuality,
    videoQuality: job.videoQuality,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    canceledAt: job.canceledAt?.toISOString() ?? null,
    lastErrorAt: job.lastErrorAt?.toISOString() ?? null,
    expiresAt: job.expiresAt.toISOString(),
    files: (job.files ?? []).map((file) => ({
      id: file.id,
      kind: file.kind,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes.toString(),
      expiresAt: file.expiresAt.toISOString(),
      createdAt: file.createdAt.toISOString(),
    })),
  };
}

export type SerializedJob = ReturnType<typeof serializeJob>;
