import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MultipartUploadError, parseUploadMultipart } from "../multipart";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexa-multipart-test-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("streaming multipart upload parser", () => {
  it("streams one file to a private temporary path while hashing and collecting bounded metadata", async () => {
    const bytes = Buffer.from("ID3-audio-payload");
    const form = new FormData();
    form.set("file", new File([bytes], "song.mp3", { type: "audio/mpeg" }));
    form.set("outputFormat", "mp3");
    form.set("audioQuality", "high");
    form.set("videoQuality", "p720");
    const request = new Request("http://localhost/upload", { method: "POST", body: form });

    const parsed = await parseUploadMultipart(request, { maxFileBytes: 1024, tempRoot });

    expect(parsed.filename).toBe("song.mp3");
    expect(parsed.reportedMime).toBe("audio/mpeg");
    expect(parsed.sizeBytes).toBe(bytes.length);
    expect(parsed.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(parsed.headerSample.equals(bytes)).toBe(true);
    expect(parsed.fields).toEqual({ outputFormat: "mp3", audioQuality: "high", videoQuality: "p720" });
    expect(await fs.readFile(parsed.tempPath)).toEqual(bytes);
  });

  it("rejects an oversized file and removes its partial temporary directory", async () => {
    const form = new FormData();
    form.set("file", new File([Buffer.alloc(64)], "large.bin", { type: "application/octet-stream" }));
    form.set("outputFormat", "mp3");
    const request = new Request("http://localhost/upload", { method: "POST", body: form });

    await expect(parseUploadMultipart(request, { maxFileBytes: 16, tempRoot })).rejects.toMatchObject<Partial<MultipartUploadError>>({
      status: 413,
    });
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });
});
