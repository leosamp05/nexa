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
    expect(args).toContain("scale=1920:-2");
  });
});
