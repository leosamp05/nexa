import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export function resolveInsideDataDir(targetPath: string) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(config.dataDir);
  if (!resolved.startsWith(root)) {
    throw new Error(`Unsafe path: ${targetPath}`);
  }
  return resolved;
}

export async function sha256File(filePath: string) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
