import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../lib/command";

describe("runCommand", () => {
  it("keeps command output bounded even when a child is very noisy", async () => {
    const output = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);

    expect(output.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("does not copy command arguments such as private source URLs into errors", async () => {
    const secretUrl = "https://example.com/private?token=secret-value";

    await expect(runCommand(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(2)", secretUrl]))
      .rejects.not.toThrow(secretUrl);
  });

  it("does not expose a sensitive URL echoed by a failed command", async () => {
    const secretUrl = "https://example.com/private?token=secret-value";

    await expect(runCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(secretUrl)}); process.exit(2)`]))
      .rejects.not.toThrow(secretUrl);
  });

  it.skipIf(process.platform === "win32")("kills the entire child process group on timeout", async () => {
    const startedAt = performance.now();

    await expect(runCommand("/bin/sh", ["-c", "sleep 3 & wait"], { timeoutMs: 100 }))
      .rejects.toThrow("Command timed out: /bin/sh");

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === "win32")("kills the entire child process group when aborted", async () => {
    const controller = new AbortController();
    const startedAt = performance.now();
    const abortTimer = setTimeout(() => controller.abort(), 100);

    try {
      await expect(runCommand("/bin/sh", ["-c", "sleep 3 & wait"], { signal: controller.signal }))
        .rejects.toThrow("Command aborted: /bin/sh");
    } finally {
      clearTimeout(abortTimer);
    }

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = performance.now();

    await expect(runCommand(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { signal: controller.signal }))
      .rejects.toThrow(`Command aborted: ${process.execPath}`);

    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("removes the abort listener when the command settles", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await runCommand(process.execPath, ["-e", ""], { signal: controller.signal });

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
