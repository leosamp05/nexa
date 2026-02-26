import { z } from "zod";

const OUTPUT_FORMATS = ["mp3", "aac", "ogg", "wav", "mp4", "webm", "mkv", "pdf", "docx", "txt"] as const;
const URL_OUTPUT_FORMATS = ["mp3", "aac", "ogg", "wav", "mp4", "webm", "mkv"] as const;
const AUDIO_QUALITY = ["low", "standard", "high"] as const;
const VIDEO_QUALITY = ["p720", "p1080"] as const;

export const MEDIA_OUTPUTS = ["mp3", "aac", "ogg", "wav", "mp4", "webm", "mkv"] as const;
export const DOCUMENT_OUTPUTS = ["pdf", "docx", "txt"] as const;

const DOCUMENT_MIME_PREFIXES = ["text/"] as const;
const DOCUMENT_MIME_EXACT = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
] as const;

export const createUrlJobSchema = z.object({
  url: z.string().url(),
  outputFormat: z.enum(URL_OUTPUT_FORMATS),
  audioQuality: z.enum(AUDIO_QUALITY).default("standard"),
  videoQuality: z.enum(VIDEO_QUALITY).default("p720"),
  captchaToken: z.string().nullable().optional(),
});

export const createUploadJobSchema = z.object({
  outputFormat: z.enum(OUTPUT_FORMATS),
  audioQuality: z.enum(AUDIO_QUALITY).default("standard"),
  videoQuality: z.enum(VIDEO_QUALITY).default("p720"),
});

function isDocumentInputMime(mimeType: string) {
  const mime = mimeType.toLowerCase();
  return DOCUMENT_MIME_EXACT.includes(mime as (typeof DOCUMENT_MIME_EXACT)[number]) || DOCUMENT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isMediaInputMime(mimeType: string) {
  const mime = mimeType.toLowerCase();
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

export function inferMimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".rtf")) return "application/rtf";
  if (lower.endsWith(".odt")) return "application/vnd.oasis.opendocument.text";
  return "application/octet-stream";
}

export function isUploadConversionSupported(inputMimeType: string, outputFormat: string): { ok: true } | { ok: false; reason: string } {
  const mime = inputMimeType.toLowerCase();
  const wantsMedia = MEDIA_OUTPUTS.includes(outputFormat as (typeof MEDIA_OUTPUTS)[number]);
  const wantsDocument = DOCUMENT_OUTPUTS.includes(outputFormat as (typeof DOCUMENT_OUTPUTS)[number]);

  if (!wantsMedia && !wantsDocument) {
    return { ok: false, reason: "Unsupported output format." };
  }

  if (wantsMedia) {
    if (!isMediaInputMime(mime)) {
      return { ok: false, reason: "Conversion not possible: audio/video output requires an audio or video input file." };
    }
    return { ok: true };
  }

  if (!isDocumentInputMime(mime)) {
    return { ok: false, reason: "Conversion not possible: document output requires a text/document input file." };
  }

  if (mime === "application/pdf" && (outputFormat === "txt" || outputFormat === "docx")) {
    return { ok: false, reason: "Conversion not possible: PDF to TXT/DOCX is not supported." };
  }

  return { ok: true };
}
