-- Add retry metadata on jobs
ALTER TABLE "Job"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "lastErrorAt" TIMESTAMP(3);

-- Improve common query paths
CREATE INDEX "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt");
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");
CREATE INDEX "Job_expiresAt_idx" ON "Job"("expiresAt");
