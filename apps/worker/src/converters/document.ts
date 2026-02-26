import fs from "node:fs/promises";
import path from "node:path";
import { OutputFormat } from "@prisma/client";
import { runCommand } from "../lib/command";

const DOC_FORMATS: OutputFormat[] = ["pdf", "docx", "txt"];

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

export async function convertDocument(params: {
  inputPath: string;
  outputDir: string;
  format: OutputFormat;
  outputBaseName: string;
  timeoutMs: number;
}) {
  if (!DOC_FORMATS.includes(params.format)) {
    throw new Error(`Unsupported document format ${params.format}`);
  }

  const inputBase = path.parse(params.inputPath).name;
  const outputFilename = `${params.outputBaseName}.${params.format}`;
  const outputPath = path.join(params.outputDir, outputFilename);
  const producedPath = path.join(params.outputDir, `${inputBase}.${params.format}`);

  await runCommand("soffice", ["--headless", "--convert-to", target(params.format), "--outdir", params.outputDir, params.inputPath], {
    timeoutMs: params.timeoutMs,
  });

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
