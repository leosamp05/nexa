import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { config } from "./config";

type AddressRecord = { address: string; family: number };
type Lookup = (hostname: string) => Promise<AddressRecord[]>;
type Connector = (options: net.NetConnectOpts) => net.Socket;

type ProxyOptions = {
  signal?: AbortSignal;
  lookup?: Lookup;
  connect?: Connector;
};

export type SafeEgressProxy = {
  url: string;
  close: () => Promise<void>;
};

const blockedIps = new net.BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIps.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIps.addSubnet(network, prefix, "ipv6");
}

function normalizeIp(address: string) {
  return address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
}

export function isPublicIp(rawAddress: string) {
  const address = normalizeIp(rawAddress);
  if (net.isIPv4(address)) return !blockedIps.check(address, "ipv4");
  if (net.isIPv6(address)) return !blockedIps.check(address, "ipv6");
  return false;
}

function assertHostnamePolicy(hostname: string) {
  const host = hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Egress destination is not allowed");
  }

  if (config.blockedPatterns.some((pattern) => host.includes(pattern.toLowerCase()))) {
    throw new Error("Egress destination is blocked by policy");
  }
}

async function defaultLookup(hostname: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await dns.lookup(hostname, { all: true, verbatim: true }) as AddressRecord[];
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "ENETUNREACH";
      if (!transient || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
  throw lastError;
}

async function resolvePublicAddress(hostname: string, lookup: Lookup) {
  assertHostnamePolicy(hostname);
  const literalFamily = net.isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname);

  if (records.length === 0 || records.some((record) => !isPublicIp(record.address))) {
    throw new Error("Egress destination resolves to a private or special-use address");
  }

  return records[0];
}

function parseConnectAuthority(authority: string | undefined) {
  if (!authority) throw new Error("Missing proxy destination");
  const parsed = new URL(`http://${authority}`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Invalid proxy destination");
  }

  const port = Number(parsed.port || "443");
  if (port !== 80 && port !== 443) throw new Error("Egress port is not allowed");
  return { hostname: parsed.hostname, port };
}

function parseHttpDestination(rawUrl: string | undefined) {
  if (!rawUrl) throw new Error("Missing proxy URL");
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password) {
    throw new Error("Only credential-free HTTP proxy requests are allowed");
  }

  const port = Number(parsed.port || "80");
  if (port !== 80) throw new Error("Egress port is not allowed");
  return { parsed, port };
}

export async function startSafeEgressProxy(options: ProxyOptions = {}): Promise<SafeEgressProxy> {
  if (options.signal?.aborted) throw new Error("Conversion canceled");

  const lookup = options.lookup ?? defaultLookup;
  const connect = options.connect ?? ((connectOptions: net.NetConnectOpts) => net.createConnection(connectOptions));
  const sockets = new Set<net.Socket>();
  let closing: Promise<void> | null = null;

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const { parsed, port } = parseHttpDestination(request.url);
      const destination = await resolvePublicAddress(parsed.hostname, lookup);
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: parsed.host };
      delete headers["proxy-connection"];

      const upstream = http.request({
        protocol: "http:",
        hostname: parsed.hostname,
        port,
        method: request.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        lookup: (_hostname, _options, callback) => {
          callback(null, destination.address, destination.family as 4 | 6);
        },
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });

      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.once("socket", (socket) => track(socket));
      request.pipe(upstream);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(403);
      response.end();
    });
  });

  server.on("connection", (socket) => track(socket));
  server.on("connect", (request, clientSocket, head) => {
    void (async () => {
      const { hostname, port } = parseConnectAuthority(request.url);
      const destination = await resolvePublicAddress(hostname, lookup);
      const upstream = track(connect({
        host: destination.address,
        port,
        family: destination.family as 4 | 6,
      }));

      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.once("error", () => {
        if (!connected && !clientSocket.destroyed) {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        } else {
          clientSocket.destroy();
        }
      });
    })().catch(() => {
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const close = () => {
    if (closing) return closing;
    closing = new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
    return closing;
  };

  const onAbort = () => void close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  server.once("close", () => options.signal?.removeEventListener("abort", onAbort));

  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close };
}
