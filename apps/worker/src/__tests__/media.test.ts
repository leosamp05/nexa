import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "../converters/media";

describe("ffmpeg presets", () => {
  it("builds mp3 preset", () => {
    const args = buildFfmpegArgs("in.mp4", "out.mp3", "mp3", "high", "p720");
    expect(args).toContain("libmp3lame");
    expect(args).toContain("256k");
  });

  it("builds webm preset", () => {
    const args = buildFfmpegArgs("in.mp4", "out.webm", "webm", "standard", "p1080");
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("libopus");
    expect(args).toContain("scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2");
  });

  it("uses Vorbis quality mode so OGG works across low sample rates and channel layouts", () => {
    const args = buildFfmpegArgs("in.aiff", "out.ogg", "ogg", "standard", "p720");

    expect(args).toEqual(expect.arrayContaining(["-c:a", "libvorbis", "-q:a", "5"]));
    expect(args).not.toContain("-b:a");
  });
});
