import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "@/lib/config";

export function sanitizeFilename(filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return safe.slice(0, 180) || "file";
}

export function jobDirPath(jobId: string) {
  return path.join(appConfig.dataDir, "jobs", jobId);
}

export async function ensureJobDir(jobId: string) {
  const dir = jobDirPath(jobId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function sha256Buffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function resolveInsideDataDir(targetPath: string) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(appConfig.dataDir);
  if (!resolved.startsWith(root)) {
    throw new Error("Path traversal rejected");
  }
  return resolved;
}

export async function removeFileIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export async function removeDirectoryIfEmpty(dirPath: string) {
  try {
    await fs.rmdir(dirPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}
