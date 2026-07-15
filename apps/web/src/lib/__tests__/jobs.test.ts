import { describe, expect, it } from "vitest";
import { createUploadJobSchema, createUrlJobSchema, inferMimeFromFilename, isUploadConversionSupported } from "@/lib/jobs";

describe("jobs schema", () => {
  it("accepts valid URL payload", () => {
    const parsed = createUrlJobSchema.safeParse({
      url: "https://www.youtube.com/watch?v=abc123",
      outputFormat: "mp3",
      audioQuality: "standard",
      videoQuality: "p720",
      captchaToken: null,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts URL payload without rights metadata", () => {
    const parsed = createUrlJobSchema.safeParse({
      url: "https://www.youtube.com/watch?v=abc123",
      outputFormat: "mp3",
      audioQuality: "standard",
      videoQuality: "p720",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts upload payload", () => {
    const parsed = createUploadJobSchema.safeParse({
      outputFormat: "docx",
      audioQuality: "low",
      videoQuality: "p1080",
    });

    expect(parsed.success).toBe(true);
  });

  it.each(["txt", "docx"])("allows PDF to %s conversion", (outputFormat) => {
    const supported = isUploadConversionSupported("application/pdf", outputFormat);
    expect(supported.ok).toBe(true);
  });

  it("rejects an audio-only upload when a video output is requested", () => {
    expect(isUploadConversionSupported("audio/mpeg", "mp4").ok).toBe(false);
    expect(isUploadConversionSupported("audio/flac", "webm").ok).toBe(false);
  });

  it("allows video inputs to produce either audio or video outputs", () => {
    expect(isUploadConversionSupported("video/quicktime", "mp3").ok).toBe(true);
    expect(isUploadConversionSupported("video/x-msvideo", "mkv").ok).toBe(true);
  });

  it.each([
    ["track.flac", "audio/flac"],
    ["track.m4a", "audio/mp4"],
    ["clip.mov", "video/quicktime"],
    ["clip.avi", "video/x-msvideo"],
    ["clip.ogv", "video/ogg"],
    ["voice.weba", "audio/webm"],
  ])("infers converter-compatible MIME for %s", (filename, expected) => {
    expect(inferMimeFromFilename(filename)).toBe(expected);
  });

  it("rejects video output for audio-only URL services", () => {
    expect(createUrlJobSchema.safeParse({ url: "https://soundcloud.com/artist/track", outputFormat: "mp4" }).success).toBe(false);
    expect(createUrlJobSchema.safeParse({ url: "https://artist.bandcamp.com/track/song", outputFormat: "webm" }).success).toBe(false);
  });
});
