import { spawn } from "node:child_process";

type Opts = {
  cwd?: string;
  timeoutMs?: number;
};

export async function runCommand(command: string, args: string[], opts: Opts = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`Command timed out: ${command}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")} :: ${stderr.trim() || stdout.trim()}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}
