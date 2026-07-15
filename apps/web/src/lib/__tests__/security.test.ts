import { describe, expect, it } from "vitest";
import { extractClientIpFromHeaderValues } from "@/lib/ip";
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

  it("uses container context for valid media MIME types", () => {
    const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]);
    const ogg = Buffer.from("OggS\0\0\0\0", "binary");
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

    expect(detectMimeFromBuffer(mp4, "voice.m4a")).toBe("audio/mp4");
    expect(detectMimeFromBuffer(ogg, "movie.ogv")).toBe("video/ogg");
    expect((detectMimeFromBuffer as (...args: unknown[]) => string | null)(webm, "voice.webm", "audio/webm")).toBe("audio/webm");
  });

  it("detects common document and media signatures without false mismatches", () => {
    const rtf = Buffer.from("{\\rtf1\\ansi hello}", "ascii");
    const flac = Buffer.from("fLaC\0\0\0\0", "binary");
    const avi = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("AVI ", "ascii")]);

    expect(detectMimeFromBuffer(rtf, "note.rtf")).toBe("application/rtf");
    expect(detectMimeFromBuffer(flac, "track.flac")).toBe("audio/flac");
    expect(detectMimeFromBuffer(avi, "movie.avi")).toBe("video/x-msvideo");
  });

  it("flags major mime family mismatches", () => {
    expect(isMimeMismatch("video/mp4", "application/pdf")).toBe(true);
    expect(isMimeMismatch("audio/mpeg", "audio/wav")).toBe(false);
  });

  it("ignores forwarding headers unless the reverse proxy proves its identity", () => {
    expect(extractClientIpFromHeaderValues({
      forwarded: "198.51.100.44, 203.0.113.7",
      cfConnectingIp: "192.0.2.9",
      realIp: "192.0.2.10",
      proxyToken: "attacker-controlled",
    }, "a".repeat(64))).toBe("direct");
  });

  it("uses the proxy-appended client hop after authenticating the reverse proxy", () => {
    const proxyToken = "a".repeat(64);
    expect(extractClientIpFromHeaderValues({
      forwarded: "198.51.100.44, 203.0.113.7",
      cfConnectingIp: "192.0.2.9",
      realIp: "192.0.2.10",
      proxyToken,
    }, proxyToken)).toBe("203.0.113.7");
  });
});
