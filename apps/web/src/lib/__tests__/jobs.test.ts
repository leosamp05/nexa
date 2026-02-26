import { describe, expect, it } from "vitest";
import { createUploadJobSchema, createUrlJobSchema, isUploadConversionSupported } from "@/lib/jobs";

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

  it("rejects pdf to txt conversion", () => {
    const supported = isUploadConversionSupported("application/pdf", "txt");
    expect(supported.ok).toBe(false);
  });
});
