import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/command", () => ({
  runCommand: vi.fn().mockResolvedValue(""),
}));

import { convertDocument } from "../converters/document";
import { buildFfmpegArgs, convertMedia } from "../converters/media";
import { runCommand } from "../lib/command";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexa-conversion-test-"));
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockImplementation(async (command, args) => {
    if (command === "pdftotext") {
      const outputPath = args.at(-1);
      if (!outputPath) throw new Error("Missing pdftotext output path");
      await fs.writeFile(outputPath, "Extracted PDF text\n");
    }

    if (command === "soffice") {
      const outputDir = args[args.indexOf("--outdir") + 1];
      const inputPath = args.at(-1);
      const outputFormat = args[args.indexOf("--convert-to") + 1]?.split(":")[0];
      if (!outputDir || !inputPath || !outputFormat) throw new Error("Incomplete soffice arguments");
      await fs.writeFile(path.join(outputDir, `${path.parse(inputPath).name}.${outputFormat}`), "Office output");
    }

    return "";
  });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("conversion behavior", () => {
  it("re-encodes media even when input and output extensions match", async () => {
    const inputPath = path.join(tempDir, "input.mp3");
    await fs.writeFile(inputPath, "source");

    await convertMedia({
      inputPath,
      outputDir: tempDir,
      format: "mp3",
      audioQuality: "high",
      videoQuality: "p720",
      outputBaseName: "converted",
      timeoutMs: 1000,
    });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(runCommand).mock.calls[0]?.[1]).toContain("256k");
  });

  it("treats the selected video quality as a maximum and never upscales small inputs", () => {
    const args = buildFfmpegArgs("input.mp4", "output.mp4", "mp4", "standard", "p720");
    const filter = args[args.indexOf("-vf") + 1];

    expect(filter).toContain("min(1280,iw)");
    expect(filter).toContain("min(720,ih)");
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    expect(filter).toContain("force_divisible_by=2");
  });

  it("copies a document when input and output formats already match", async () => {
    const inputPath = path.join(tempDir, "input.txt");
    await fs.writeFile(inputPath, "hello");

    const result = await convertDocument({
      inputPath,
      outputDir: tempDir,
      format: "txt",
      outputBaseName: "converted",
      timeoutMs: 1000,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(await fs.readFile(result.outputPath, "utf8")).toBe("hello");
  });

  it("extracts PDF text with pdftotext layout preservation", async () => {
    const inputPath = path.join(tempDir, "source.pdf");
    const signal = new AbortController().signal;
    await fs.writeFile(inputPath, "%PDF-1.7\nfixture");

    const result = await convertDocument({
      inputPath,
      outputDir: tempDir,
      format: "txt",
      outputBaseName: "converted",
      timeoutMs: 1000,
      signal,
    });

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      "pdftotext",
      ["-layout", inputPath, result.outputPath],
      { timeoutMs: 1000, signal },
    );
    expect(await fs.readFile(result.outputPath, "utf8")).toBe("Extracted PDF text\n");
  });

  it("converts PDF to DOCX through a temporary extracted text file and cleans it up", async () => {
    const inputPath = path.join(tempDir, "source.pdf");
    const signal = new AbortController().signal;
    await fs.writeFile(inputPath, "%PDF-1.7\nfixture");

    const result = await convertDocument({
      inputPath,
      outputDir: tempDir,
      format: "docx",
      outputBaseName: "converted",
      timeoutMs: 1000,
      signal,
    });

    expect(runCommand).toHaveBeenCalledTimes(2);
    const [extractCall, officeCall] = vi.mocked(runCommand).mock.calls;
    expect(extractCall?.[0]).toBe("pdftotext");
    expect(extractCall?.[1].slice(0, 2)).toEqual(["-layout", inputPath]);
    expect(extractCall?.[2]).toEqual({ timeoutMs: 1000, signal });

    const extractedTextPath = extractCall?.[1].at(-1);
    expect(extractedTextPath).toMatch(/\.txt$/);
    expect(extractedTextPath).not.toBe(result.outputPath);
    expect(officeCall?.[0]).toBe("soffice");
    expect(officeCall?.[1]).toEqual(expect.arrayContaining(["--convert-to", "docx", extractedTextPath]));
    expect(officeCall?.[2]).toEqual({ timeoutMs: 1000, signal });
    expect(await fs.readFile(result.outputPath, "utf8")).toBe("Office output");
    await expect(fs.stat(extractedTextPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(tempDir)).sort()).toEqual(["converted.docx", "source.pdf"]);
  });

  it("cleans temporary PDF extraction files when DOCX conversion fails", async () => {
    const inputPath = path.join(tempDir, "source.pdf");
    await fs.writeFile(inputPath, "%PDF-1.7\nfixture");
    vi.mocked(runCommand)
      .mockImplementationOnce(async (_command, args) => {
        const extractedTextPath = args.at(-1);
        if (!extractedTextPath) throw new Error("Missing pdftotext output path");
        await fs.writeFile(extractedTextPath, "Extracted PDF text\n");
        return "";
      })
      .mockRejectedValueOnce(new Error("LibreOffice failed"));

    await expect(convertDocument({
      inputPath,
      outputDir: tempDir,
      format: "docx",
      outputBaseName: "converted",
      timeoutMs: 1000,
    })).rejects.toThrow("LibreOffice failed");

    const extractedTextPath = vi.mocked(runCommand).mock.calls[0]?.[1].at(-1);
    await expect(fs.stat(extractedTextPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(tempDir)).toEqual(["source.pdf"]);
  });

  it("forwards cancellation to standard LibreOffice conversions", async () => {
    const inputPath = path.join(tempDir, "source.txt");
    const signal = new AbortController().signal;
    await fs.writeFile(inputPath, "source text");

    await convertDocument({
      inputPath,
      outputDir: tempDir,
      format: "pdf",
      outputBaseName: "converted",
      timeoutMs: 1000,
      signal,
    });

    expect(runCommand).toHaveBeenCalledWith(
      "soffice",
      expect.any(Array),
      { timeoutMs: 1000, signal },
    );
  });

  it("rejects Office archives that claim an excessive expanded size before LibreOffice", async () => {
    const inputPath = path.join(tempDir, "bomb.docx");
    const filename = Buffer.from("word/document.xml");
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(1, 20);
    central.writeUInt32LE(1_500_000_000, 24);
    central.writeUInt16LE(filename.length, 28);
    filename.copy(central, 46);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(0, 16);
    await fs.writeFile(inputPath, Buffer.concat([central, eocd]));

    await expect(convertDocument({
      inputPath,
      outputDir: tempDir,
      format: "pdf",
      outputBaseName: "converted",
      timeoutMs: 1000,
    })).rejects.toThrow("expanded size");

    expect(runCommand).not.toHaveBeenCalled();
  });
});
