import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { appConfig } from "@/lib/config";
import { getRedis } from "@/lib/redis";

export const CONVERSION_QUEUE_NAME = "conversion-jobs";

let queue: Queue<{ jobId: string }> | null = null;

function getQueue() {
  if (queue) return queue;

  const redis = getRedis();
  if (!redis) throw new Error("REDIS_URL is missing");

  queue = new Queue(CONVERSION_QUEUE_NAME, {
    connection: redis as unknown as ConnectionOptions,
  });

  return queue;
}

export function getQueuePolicy() {
  return {
    attempts: appConfig.queueAttempts,
    removeOnComplete: 200,
    removeOnFail: 500,
    backoff: {
      type: "exponential" as const,
      delay: appConfig.queueRetryDelayMs,
    },
  };
}

export async function enqueueConversionJob(jobId: string) {
  const q = getQueue();
  const policy = getQueuePolicy();
  return q.add(
    "convert",
    { jobId },
    {
      jobId,
      ...policy,
    }
  );
}

export async function removeQueuedJob(jobId: string) {
  const q = getQueue();
  const job = await q.getJob(jobId);
  if (job) {
    await job.remove();
  }
}

export async function getQueueStats() {
  const q = getQueue();
  return q.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
}
