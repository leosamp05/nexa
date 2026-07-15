import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicIp, startSafeEgressProxy, type SafeEgressProxy } from "../lib/safe-egress-proxy";

const openProxies: SafeEgressProxy[] = [];
const openServers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function proxyPort(proxy: SafeEgressProxy) {
  return Number(new URL(proxy.url).port);
}

function readConnectResponse(port: number, authority: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let output = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for proxy response"));
    }, 2000);

    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(output);
      }
    });
    socket.once("error", reject);
  });
}

describe("safe egress proxy", () => {
  it("rejects private and special-use address ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ]) {
      expect(isPublicIp(address), address).toBe(false);
    }

    expect(isPublicIp("93.184.216.34")).toBe(true);
    expect(isPublicIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("rejects a CONNECT destination when any DNS result is private", async () => {
    const connect = vi.fn(() => net.createConnection({ host: "127.0.0.1", port: 9 }));
    const proxy = await startSafeEgressProxy({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      connect,
    });
    openProxies.push(proxy);

    const response = await readConnectResponse(proxyPort(proxy), "example.com:443");

    expect(response).toContain("403 Forbidden");
    expect(connect).not.toHaveBeenCalled();
  });

  it("pins an allowed CONNECT tunnel to the validated address", async () => {
    const upstream = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    openServers.push(upstream);
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const connect = vi.fn(() => net.createConnection({ host: "127.0.0.1", port: upstreamPort }));
    const proxy = await startSafeEgressProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect,
    });
    openProxies.push(proxy);

    const output = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort(proxy) });
      let response = "";
      let sentPayload = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out waiting for tunnel echo"));
      }, 2000);

      socket.once("connect", () => {
        socket.write("CONNECT media.example.com:443 HTTP/1.1\r\nHost: media.example.com:443\r\n\r\n");
      });
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (!sentPayload && response.includes("200 Connection Established\r\n\r\n")) {
          sentPayload = true;
          socket.write("probe");
        }
        if (sentPayload && response.endsWith("probe")) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(response);
        }
      });
      socket.once("error", reject);
    });

    expect(output).toContain("200 Connection Established");
    expect(output).toContain("probe");
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34", port: 443, family: 4 }));
  });
});
