import { describe, expect, it } from "vitest";
import { detectMimeFromBuffer, isMimeMismatch, isPrivateOrLocalIp } from "@/lib/security";

describe("security helpers", () => {
  it("detects private/local IP ranges", () => {
    expect(isPrivateOrLocalIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalIp("192.168.1.20")).toBe(true);
    expect(isPrivateOrLocalIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrLocalIp("8.8.8.8")).toBe(false);
  });

  it("detects mime from known signatures", () => {
    const pdf = Buffer.from("%PDF-1.7\n", "ascii");
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x03]);
    const txt = Buffer.from("hello world text", "utf8");

    expect(detectMimeFromBuffer(pdf, "doc.pdf")).toBe("application/pdf");
    expect(detectMimeFromBuffer(mp3, "song.mp3")).toBe("audio/mpeg");
    expect(detectMimeFromBuffer(txt, "note.txt")).toBe("text/plain");
  });

  it("flags major mime family mismatches", () => {
    expect(isMimeMismatch("video/mp4", "application/pdf")).toBe(true);
    expect(isMimeMismatch("audio/mpeg", "audio/wav")).toBe(false);
  });
});
