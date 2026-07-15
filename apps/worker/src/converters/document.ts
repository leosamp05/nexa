import fs from "node:fs/promises";
import path from "node:path";
import { OutputFormat } from "@prisma/client";
import { runCommand } from "../lib/command";

const DOC_FORMATS: OutputFormat[] = ["pdf", "docx", "txt"];
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 65_535;
const MAX_OFFICE_ARCHIVE_ENTRIES = 10_000;
const MAX_OFFICE_EXPANDED_BYTES = 1024n * 1024n * 1024n;
const MAX_OFFICE_EXPANSION_RATIO = 100n;

const MIME: Record<OutputFormat, string> = {
  mp3: "audio/mpeg",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

function target(format: OutputFormat) {
  if (format === "pdf") return "pdf";
  if (format === "docx") return "docx";
  if (format === "txt") return "txt:Text";
  throw new Error(`Unsupported document format ${format}`);
}

export function isDocumentOutput(format: OutputFormat) {
  return DOC_FORMATS.includes(format);
}

async function readExact(handle: Awaited<ReturnType<typeof fs.open>>, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Invalid Office document archive.");
  return buffer;
}

async function validateOfficeArchive(inputPath: string) {
  const extension = path.extname(inputPath).toLowerCase();
  if (extension !== ".docx" && extension !== ".odt") return;

  const handle = await fs.open(inputPath, "r");
  try {
    const stats = await handle.stat();
    if (stats.size < ZIP_EOCD_MIN_SIZE) throw new Error("Invalid Office document archive.");

    const tailLength = Math.min(stats.size, ZIP_EOCD_MIN_SIZE + ZIP_MAX_COMMENT_SIZE);
    const tail = await readExact(handle, tailLength, stats.size - tailLength);
    let eocdOffset = -1;
    for (let offset = tail.length - ZIP_EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
        const commentLength = tail.readUInt16LE(offset + 20);
        if (offset + ZIP_EOCD_MIN_SIZE + commentLength === tail.length) {
          eocdOffset = offset;
          break;
        }
      }
    }
    if (eocdOffset < 0) throw new Error("Invalid Office document archive.");

    const entries = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error("Office archive exceeds safe ZIP limits.");
    }
    if (entries > MAX_OFFICE_ARCHIVE_ENTRIES) {
      throw new Error("Office archive contains too many files.");
    }
    if (centralOffset + centralSize > stats.size) {
      throw new Error("Invalid Office document archive.");
    }

    let cursor = centralOffset;
    let compressedBytes = 0n;
    let expandedBytes = 0n;
    for (let index = 0; index < entries; index += 1) {
      const header = await readExact(handle, 46, cursor);
      if (header.readUInt32LE(0) !== ZIP_CENTRAL_SIGNATURE) {
        throw new Error("Invalid Office document archive.");
      }

      compressedBytes += BigInt(header.readUInt32LE(20));
      expandedBytes += BigInt(header.readUInt32LE(24));
      const variableLength = header.readUInt16LE(28) + header.readUInt16LE(30) + header.readUInt16LE(32);
      cursor += 46 + variableLength;
      if (cursor > centralOffset + centralSize || cursor > stats.size) {
        throw new Error("Invalid Office document archive.");
      }
      if (expandedBytes > MAX_OFFICE_EXPANDED_BYTES) {
        throw new Error("Office archive expanded size exceeds safe limit.");
      }
    }

    if (expandedBytes > 256n * 1024n * 1024n && (compressedBytes === 0n || expandedBytes > compressedBytes * MAX_OFFICE_EXPANSION_RATIO)) {
      throw new Error("Office archive expansion ratio exceeds safe limit.");
    }
  } finally {
    await handle.close();
  }
}

export async function convertDocument(params: {
  inputPath: string;
  outputDir: string;
  format: OutputFormat;
  outputBaseName: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  if (!DOC_FORMATS.includes(params.format)) {
    throw new Error(`Unsupported document format ${params.format}`);
  }

  const inputBase = path.parse(params.inputPath).name;
  const inputFormat = path.extname(params.inputPath).slice(1).toLowerCase();
  const outputFilename = `${params.outputBaseName}.${params.format}`;
  const outputPath = path.join(params.outputDir, outputFilename);
  const producedPath = path.join(params.outputDir, `${inputBase}.${params.format}`);
  const commandOptions = { timeoutMs: params.timeoutMs, signal: params.signal };

  if (inputFormat === params.format) {
    await fs.copyFile(params.inputPath, outputPath);
    return {
      outputPath,
      outputFilename,
      mimeType: MIME[params.format],
    };
  }

  if (inputFormat === "pdf" && params.format === "txt") {
    await runCommand("pdftotext", ["-layout", params.inputPath, outputPath], commandOptions);
    return {
      outputPath,
      outputFilename,
      mimeType: MIME[params.format],
    };
  }

  if (inputFormat === "pdf" && params.format === "docx") {
    const temporaryDir = await fs.mkdtemp(path.join(params.outputDir, ".pdf-docx-"));
    const extractedTextPath = path.join(temporaryDir, "extracted.txt");
    const temporaryDocxPath = path.join(temporaryDir, "extracted.docx");

    try {
      await runCommand("pdftotext", ["-layout", params.inputPath, extractedTextPath], commandOptions);
      await runCommand("soffice", ["--headless", "--convert-to", "docx", "--outdir", temporaryDir, extractedTextPath], commandOptions);

      try {
        await fs.stat(temporaryDocxPath);
        await fs.rename(temporaryDocxPath, outputPath);
      } catch {
        throw new Error("Conversion is not possible with the requested output format.");
      }

      return {
        outputPath,
        outputFilename,
        mimeType: MIME[params.format],
      };
    } finally {
      await fs.rm(temporaryDir, { recursive: true, force: true });
    }
  }

  await validateOfficeArchive(params.inputPath);

  await runCommand("soffice", ["--headless", "--convert-to", target(params.format), "--outdir", params.outputDir, params.inputPath], commandOptions);

  try {
    await fs.stat(producedPath);
    if (producedPath !== outputPath) {
      await fs.rename(producedPath, outputPath);
    }
  } catch {
    throw new Error("Conversion is not possible with the requested output format.");
  }

  return {
    outputPath,
    outputFilename,
    mimeType: MIME[params.format],
  };
}
