import { Queue } from "bullmq";
import { getRedis } from "@/lib/redis";

export const CONVERSION_QUEUE_NAME = "conversion-jobs";

let queue: Queue<{ jobId: string }> | null = null;

function getQueue() {
  if (queue) return queue;

  const redis = getRedis();
  if (!redis) throw new Error("REDIS_URL is missing");

  queue = new Queue(CONVERSION_QUEUE_NAME, {
    connection: redis,
  });

  return queue;
}

export async function enqueueConversionJob(jobId: string) {
  const q = getQueue();
  return q.add(
    "convert",
    { jobId },
    {
      jobId,
      attempts: 2,
      removeOnComplete: 200,
      removeOnFail: 500,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
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
