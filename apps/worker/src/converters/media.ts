import fs from "node:fs/promises";
import path from "node:path";
import { AudioQuality, OutputFormat, VideoQuality } from "@prisma/client";
import { runCommand } from "../lib/command";

const AUDIO_BITRATE: Record<AudioQuality, string> = {
  low: "128k",
  standard: "192k",
  high: "256k",
};

const VIDEO_SCALE: Record<VideoQuality, string> = {
  p720: "scale=1280:-2",
  p1080: "scale=1920:-2",
};

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: "audio/mpeg",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

function isAudio(format: OutputFormat) {
  return ["mp3", "aac", "ogg", "wav"].includes(format);
}

function isVideo(format: OutputFormat) {
  return ["mp4", "webm", "mkv"].includes(format);
}

export function buildFfmpegArgs(inputPath: string, outputPath: string, format: OutputFormat, aq: AudioQuality, vq: VideoQuality) {
  if (isAudio(format)) {
    if (format === "mp3") return ["-y", "-i", inputPath, "-map_metadata", "0", "-map_chapters", "0", "-vn", "-c:a", "libmp3lame", "-b:a", AUDIO_BITRATE[aq], outputPath];
    if (format === "aac") return ["-y", "-i", inputPath, "-map_metadata", "0", "-map_chapters", "0", "-vn", "-c:a", "aac", "-b:a", AUDIO_BITRATE[aq], outputPath];
    if (format === "ogg") return ["-y", "-i", inputPath, "-map_metadata", "0", "-map_chapters", "0", "-vn", "-c:a", "libvorbis", "-b:a", AUDIO_BITRATE[aq], outputPath];
    return ["-y", "-i", inputPath, "-map_metadata", "0", "-map_chapters", "0", "-vn", "-c:a", "pcm_s16le", outputPath];
  }

  if (isVideo(format)) {
    if (format === "webm") {
      return [
        "-y", "-i", inputPath,
        "-map_metadata", "0",
        "-map_chapters", "0",
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1",
        "-vf", VIDEO_SCALE[vq],
        "-c:a", "libopus", "-b:a", "128k",
        outputPath,
      ];
    }

    return [
      "-y", "-i", inputPath,
      "-map_metadata", "0",
      "-map_chapters", "0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-vf", VIDEO_SCALE[vq],
      "-c:a", "aac", "-b:a", "192k",
      outputPath,
    ];
  }

  throw new Error(`Unsupported media format: ${format}`);
}

export function isMediaOutput(format: OutputFormat) {
  return isAudio(format) || isVideo(format);
}

export async function convertMedia(params: {
  inputPath: string;
  outputDir: string;
  format: OutputFormat;
  audioQuality: AudioQuality;
  videoQuality: VideoQuality;
  outputBaseName: string;
  timeoutMs: number;
}) {
  const outputFilename = `${params.outputBaseName}.${params.format}`;
  const outputPath = path.join(params.outputDir, outputFilename);

  // Fast path: if source extension already matches requested output format, skip re-encoding.
  const inputExt = path.extname(params.inputPath).replace(".", "").toLowerCase();
  if (inputExt === params.format) {
    await fs.copyFile(params.inputPath, outputPath);
    return {
      outputPath,
      outputFilename,
      mimeType: MIME_BY_FORMAT[params.format] ?? "application/octet-stream",
    };
  }

  const args = buildFfmpegArgs(params.inputPath, outputPath, params.format, params.audioQuality, params.videoQuality);
  await runCommand("ffmpeg", args, { timeoutMs: params.timeoutMs });

  return {
    outputPath,
    outputFilename,
    mimeType: MIME_BY_FORMAT[params.format] ?? "application/octet-stream",
  };
}
