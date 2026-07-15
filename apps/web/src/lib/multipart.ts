import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";

const ALLOWED_FIELDS = new Set(["outputFormat", "audioQuality", "videoQuality"]);
const HEADER_SAMPLE_BYTES = 8192;

export class MultipartUploadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export type ParsedUpload = {
  tempDir: string;
  tempPath: string;
  filename: string;
  reportedMime: string;
  sizeBytes: number;
  sha256: string;
  headerSample: Buffer;
  fields: Record<string, string>;
};

export async function parseUploadMultipart(request: Request, options: { maxFileBytes: number; tempRoot: string }): Promise<ParsedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new MultipartUploadError("Expected multipart/form-data", 415);
  }
  if (!request.body) throw new MultipartUploadError("Request body required", 400);

  await fs.mkdir(options.tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(options.tempRoot, "upload-"));
  const tempPath = path.join(tempDir, "payload");

  try {
    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: {
        fieldNameSize: 64,
        fieldSize: 1024,
        fields: ALLOWED_FIELDS.size,
        fileSize: options.maxFileBytes,
        files: 1,
        // Busboy emits partsLimit as soon as the configured count is reached,
        // so leave one sentinel slot while file/field limits enforce the schema.
        parts: ALLOWED_FIELDS.size + 2,
        headerPairs: 50,
      },
    });

    const fields: Record<string, string> = {};
    const hash = createHash("sha256");
    let filename = "";
    let reportedMime = "";
    let sizeBytes = 0;
    let headerSample = Buffer.alloc(0);
    let fileSeen = false;
    let fileLimited = false;
    let limitError: MultipartUploadError | null = null;
    let fileWrite: Promise<void> | null = null;

    parser.on("field", (name, value, info) => {
      if (!ALLOWED_FIELDS.has(name) || info.nameTruncated || info.valueTruncated) {
        limitError ??= new MultipartUploadError("Invalid multipart fields", 400);
        return;
      }
      fields[name] = value;
    });

    parser.on("file", (name, stream, info) => {
      if (name !== "file" || fileSeen) {
        limitError ??= new MultipartUploadError("Exactly one file is required", 400);
        stream.resume();
        return;
      }

      fileSeen = true;
      filename = info.filename;
      reportedMime = info.mimeType;
      stream.once("limit", () => {
        fileLimited = true;
      });

      const inspector = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          hash.update(chunk);
          if (headerSample.length < HEADER_SAMPLE_BYTES) {
            const remaining = HEADER_SAMPLE_BYTES - headerSample.length;
            headerSample = Buffer.concat([headerSample, chunk.subarray(0, remaining)]);
          }
          callback(null, chunk);
        },
      });

      fileWrite = pipeline(stream, inspector, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
    });

    parser.on("filesLimit", () => {
      limitError ??= new MultipartUploadError("Exactly one file is required", 400);
    });
    parser.on("fieldsLimit", () => {
      limitError ??= new MultipartUploadError("Too many multipart fields", 400);
    });
    parser.on("partsLimit", () => {
      limitError ??= new MultipartUploadError("Too many multipart parts", 400);
    });

    await pipeline(Readable.fromWeb(request.body as never), parser);
    if (fileWrite) await fileWrite;
    if (fileLimited || sizeBytes > options.maxFileBytes) {
      throw new MultipartUploadError(`File exceeds max size ${options.maxFileBytes}`, 413);
    }
    if (limitError) throw limitError;
    if (!fileSeen || !filename || !fileWrite) {
      throw new MultipartUploadError("File required", 400);
    }

    return {
      tempDir,
      tempPath,
      filename,
      reportedMime,
      sizeBytes,
      sha256: hash.digest("hex"),
      headerSample,
      fields,
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
