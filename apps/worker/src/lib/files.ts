import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export function resolveInsideDataDir(targetPath: string) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(config.dataDir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path: ${targetPath}`);
  }
  return resolved;
}

export async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export async function removeJobDirectory(jobId: string) {
  const dir = resolveInsideDataDir(path.join(config.dataDir, "jobs", jobId));
  await fs.rm(dir, { recursive: true, force: true });
}
