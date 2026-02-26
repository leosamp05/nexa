-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN');

-- CreateEnum
CREATE TYPE "JobSourceType" AS ENUM ('url', 'upload');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'processing', 'done', 'failed', 'expired', 'canceled');

-- CreateEnum
CREATE TYPE "OutputFormat" AS ENUM ('mp3', 'aac', 'ogg', 'wav', 'mp4', 'webm', 'mkv', 'pdf', 'docx', 'txt');

-- CreateEnum
CREATE TYPE "UsagePurpose" AS ENUM ('personal', 'licensed');

-- CreateEnum
CREATE TYPE "AudioQuality" AS ENUM ('low', 'standard', 'high');

-- CreateEnum
CREATE TYPE "VideoQuality" AS ENUM ('p720', 'p1080');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('input', 'output');

-- CreateTable
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceType" "JobSourceType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'queued',
  "sourceUrl" TEXT,
  "inputFilename" TEXT,
  "outputFormat" "OutputFormat" NOT NULL,
  "purpose" "UsagePurpose" NOT NULL,
  "hasRights" BOOLEAN NOT NULL,
  "audioQuality" "AudioQuality" NOT NULL DEFAULT 'standard',
  "videoQuality" "VideoQuality" NOT NULL DEFAULT 'p720',
  "errorMessage" TEXT,
  "queueJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileArtifact" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "kind" "FileKind" NOT NULL,
  "path" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "jobId" TEXT,
  "eventType" TEXT NOT NULL,
  "ip" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "FileArtifact_jobId_kind_idx" ON "FileArtifact"("jobId", "kind");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_createdAt_idx" ON "AuditEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_jobId_idx" ON "AuditEvent"("jobId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileArtifact" ADD CONSTRAINT "FileArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
