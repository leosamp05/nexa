import Redis from "ioredis";
import { config } from "./config";

if (!config.redisUrl) {
  throw new Error("REDIS_URL is required in worker");
}

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
