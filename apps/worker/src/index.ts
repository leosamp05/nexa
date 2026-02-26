import { Worker } from "bullmq";
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
      await processConversionJob(job.data.jobId);
    },
    {
      connection: redis,
      concurrency: config.workerConcurrency,
    }
  );

  worker.on("ready", () => logger.info("Worker ready"));
  worker.on("completed", (job) => logger.info({ queueJobId: job.id }, "Queue job completed"));
  worker.on("failed", (job, error) => logger.error({ queueJobId: job?.id, error }, "Queue job failed"));

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
