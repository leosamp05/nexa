import { spawn, type ChildProcess } from "node:child_process";

type Opts = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const MAX_CAPTURE_CHARS = 1024 * 1024;
const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

function appendBounded(current: string, chunk: Buffer) {
  const next = current + chunk.toString();
  return next.length > MAX_CAPTURE_CHARS ? next.slice(-MAX_CAPTURE_CHARS) : next;
}

function killProcessTree(child: ChildProcess) {
  if (SUPPORTS_PROCESS_GROUPS && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child if its process group is already gone.
    }
  }

  child.kill("SIGKILL");
}

export async function runCommand(command: string, args: string[], opts: Opts = {}) {
  return new Promise<string>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`Command aborted: ${command}`));
      return;
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      detached: SUPPORTS_PROCESS_GROUPS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let termination: "aborted" | "timed-out" | undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", handleAbort);
    };

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const terminate = (reason: "aborted" | "timed-out") => {
      if (termination !== undefined || settled) return;
      termination = reason;
      killProcessTree(child);
    };

    function handleAbort() {
      terminate("aborted");
    }

    opts.signal?.addEventListener("abort", handleAbort, { once: true });

    timeout = opts.timeoutMs
      ? setTimeout(() => {
          terminate("timed-out");
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });

    child.on("close", (code) => {
      if (termination === "timed-out") {
        settle(() => reject(new Error(`Command timed out: ${command}`)));
        return;
      }

      if (termination === "aborted") {
        settle(() => reject(new Error(`Command aborted: ${command}`)));
        return;
      }

      if (code !== 0) {
        settle(() => reject(new Error(`Command failed: ${command} (exit code ${code ?? "unknown"})`)));
        return;
      }

      settle(() => resolve(stdout.trim()));
    });
  });
}
