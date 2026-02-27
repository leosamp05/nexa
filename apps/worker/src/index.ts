import { Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { config } from "./lib/config";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { QUEUE_NAME } from "./lib/queue";
import { redis } from "./lib/redis";
import { processConversionJob, runCleanupSweep } from "./processors/convert-job";

async function main() {
  const worker = new Worker<{ jobId: string }>(
    QUEUE_NAME,
    async (job) => {
      const maxAttemptsRaw = Number(job.opts.attempts ?? config.queueAttempts);
      const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? maxAttemptsRaw : config.queueAttempts;
      await processConversionJob(job.data.jobId, {
        attempt: job.attemptsMade + 1,
        maxAttempts,
      });
    },
    {
      connection: redis as unknown as ConnectionOptions,
      concurrency: config.workerConcurrency,
    }
  );

  worker.on("ready", () => logger.info("Worker ready"));
  worker.on("completed", (job) => logger.info({ queueJobId: job.id, attemptsMade: job.attemptsMade + 1 }, "Queue job completed"));
  worker.on("failed", (job, error) => {
    const attempts = Number(job?.opts.attempts ?? config.queueAttempts);
    const attemptsMade = (job?.attemptsMade ?? 0) + 1;
    const willRetry = attemptsMade < attempts;
    logger.error({ queueJobId: job?.id, attemptsMade, attempts, willRetry, error }, "Queue job failed");
  });
  worker.on("stalled", (jobId) => logger.warn({ queueJobId: jobId }, "Queue job stalled"));

  await runCleanupSweep();
  const timer = setInterval(() => {
    runCleanupSweep().catch((error) => logger.error({ error }, "Cleanup sweep failed"));
  }, config.cleanupIntervalMs);

  async function shutdown(signal: string) {
    logger.info({ signal }, "Shutting down worker");
    clearInterval(timer);
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      logger.error({ error }, "Shutdown error");
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      logger.error({ error }, "Shutdown error");
      process.exit(1);
    });
  });
}

main().catch((error) => {
  logger.error({ error }, "Worker bootstrap failed");
  process.exit(1);
});
