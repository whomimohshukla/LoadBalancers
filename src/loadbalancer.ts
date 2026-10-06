import express, { type Request } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createServer as createHttpServer } from "node:http";
import net, { type Socket } from "node:net";

interface HttpBackend {
  url: string;
  healthy: boolean;
  checking: boolean;
  failures: number;
  successes: number;
  lastCheck: string | null;
}

interface TcpBackend {
  host: string;
  port: number;
  address: string;
  healthy: boolean;
  checking: boolean;
  failures: number;
  successes: number;
  lastCheck: string | null;
}

type RequestWithTarget = Request & { lbTarget?: string };

const parseHttpBackends = (value: string | undefined): HttpBackend[] => {
  const urls = (value ?? "http://localhost:3001,http://localhost:3002")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return urls.map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`BACKENDS must contain HTTP(S) URLs; received: ${entry}`);
    }
    return {
      url: url.origin,
      healthy: false,
      checking: false,
      failures: 0,
      successes: 0,
      lastCheck: null,
    };
  });
};

const parseTcpBackends = (value: string | undefined): TcpBackend[] => {
  const entries = (value ?? "localhost:3001,localhost:3002")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.map((entry) => {
    let parsed: URL;
    try {
      parsed = new URL(`tcp://${entry}`);
    } catch {
      throw new Error(`Invalid L4 backend address: ${entry} (expected host:port)`);
    }

    const port = Number(parsed.port);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid L4 backend address: ${entry} (expected host:port)`);
    }

    return {
      host: parsed.hostname,
      port,
      address: `${parsed.hostname}:${port}`,
      healthy: false,
      checking: false,
      failures: 0,
      successes: 0,
      lastCheck: null,
    };
  });
};

const httpBackends = parseHttpBackends(process.env.BACKENDS);
const tcpBackends = parseTcpBackends(process.env.L4_BACKENDS);
if (httpBackends.length === 0 && tcpBackends.length === 0) {
  throw new Error("Configure at least one HTTP backend or TCP backend.");
}

const port = Number(process.env.PORT ?? 8080);
const l4Port = Number(process.env.L4_PORT ?? 9000);
const healthIntervalMs = Number(process.env.HEALTH_INTERVAL_MS ?? 5_000);
const healthTimeoutMs = Number(process.env.HEALTH_TIMEOUT_MS ?? 2_000);
if (![port, l4Port].every((value) => Number.isInteger(value) && value >= 0 && value <= 65535)) {
  throw new Error("PORT and L4_PORT must be integers between 0 and 65535.");
}

let nextHttpBackend = 0;
let nextTcpBackend = 0;
let shuttingDown = false;

function chooseHealthy<T extends { healthy: boolean }>(
  backends: T[],
  nextIndex: number,
): { backend: T; nextIndex: number } | null {
  const healthy = backends.filter((backend) => backend.healthy);
  if (healthy.length === 0) return null;
  const selectedIndex = nextIndex % healthy.length;
  return { backend: healthy[selectedIndex], nextIndex: (selectedIndex + 1) % healthy.length };
}

async function probeHttpBackend(backend: HttpBackend): Promise<boolean> {
  const healthUrl = new URL("/health", backend.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function probeTcpBackend(backend: TcpBackend): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: backend.host, port: backend.port });
    const finish = (healthy: boolean) => {
      socket.destroy();
      resolve(healthy);
    };
    socket.setTimeout(healthTimeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function checkBackend<T extends { healthy: boolean; checking: boolean; failures: number; successes: number; lastCheck: string | null }>(
  backend: T,
  probe: () => Promise<boolean>,
  name: string,
): Promise<void> {
  if (backend.checking || shuttingDown) return;
  backend.checking = true;
  const wasHealthy = backend.healthy;
  try {
    backend.healthy = await probe();
    backend.lastCheck = new Date().toISOString();
    if (backend.healthy) backend.successes += 1;
    else backend.failures += 1;
    if (wasHealthy !== backend.healthy) {
      console.log(`[health] ${name} ${backend.healthy ? "recovered" : "unhealthy"}`);
    }
  } finally {
    backend.checking = false;
  }
}

async function runHealthChecks(): Promise<void> {
  await Promise.all([
    ...httpBackends.map((backend) =>
      checkBackend(backend, () => probeHttpBackend(backend), `HTTP ${backend.url}`),
    ),
    ...tcpBackends.map((backend) =>
      checkBackend(backend, () => probeTcpBackend(backend), `TCP ${backend.address}`),
    ),
  ]);
}

const app = express();
app.disable("x-powered-by");

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "load-balancer" });
});

app.get("/lb/status", (_request, response) => {
  response.json({
    strategy: "round-robin among healthy backends",
    httpBackends: httpBackends.map(({ url, healthy, failures, successes, lastCheck }) => ({
      url,
      healthy,
      failures,
      successes,
      lastCheck,
    })),
    tcpBackends: tcpBackends.map(({ address, healthy, failures, successes, lastCheck }) => ({
      address,
      healthy,
      failures,
      successes,
      lastCheck,
    })),
  });
});

app.use((request: RequestWithTarget, response, next) => {
  const selected = chooseHealthy(httpBackends, nextHttpBackend);
  if (!selected) {
    response.status(503).json({ error: "No healthy HTTP backends are available." });
    return;
  }
  nextHttpBackend = selected.nextIndex;
  request.lbTarget = selected.backend.url;
  next();
});

app.use(
  createProxyMiddleware({
    target: httpBackends[0]?.url ?? "http://127.0.0.1",
    changeOrigin: true,
    router: (request) => (request as RequestWithTarget).lbTarget ?? httpBackends[0]?.url ?? "http://127.0.0.1",
    on: {
      error: (error, _request, response) => {
        console.error(`[proxy] ${error.message}`);
        if ("writeHead" in response) {
          if (!response.headersSent) {
            response.writeHead(502, { "content-type": "application/json" });
          }
          response.end(JSON.stringify({ error: "Backend request failed." }));
        } else {
          response.destroy();
        }
      },
    },
  }),
);

const httpServer = createHttpServer(app);
const tcpSockets = new Set<Socket>();
const tcpServer = net.createServer((client) => {
  const selected = chooseHealthy(tcpBackends, nextTcpBackend);
  if (!selected) {
    client.end("No healthy TCP backends are available.\n");
    return;
  }
  nextTcpBackend = selected.nextIndex;

  const backend = net.createConnection({ host: selected.backend.host, port: selected.backend.port });
  tcpSockets.add(client);
  tcpSockets.add(backend);
  const removeSockets = () => {
    tcpSockets.delete(client);
    tcpSockets.delete(backend);
  };
  client.once("close", removeSockets);
  backend.once("close", removeSockets);
  backend.once("connect", () => {
    console.log(`[L4] ${client.remoteAddress ?? "client"} -> ${selected.backend.address}`);
    client.pipe(backend);
    backend.pipe(client);
  });
  backend.once("error", (error) => {
    console.error(`[L4] ${selected.backend.address}: ${error.message}`);
    client.destroy();
  });
  client.once("error", () => backend.destroy());
});

const healthTimer = setInterval(() => void runHealthChecks(), healthIntervalMs);
healthTimer.unref();

void runHealthChecks().then(() => {
  httpServer.listen(port, () => {
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`[L7] HTTP load balancer listening on http://localhost:${actualPort}`);
  });
  tcpServer.listen(l4Port, () => {
    const address = tcpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : l4Port;
    console.log(`[L4] TCP load balancer listening on port ${actualPort}`);
  });
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}; shutting down.`);
  clearInterval(healthTimer);
  for (const socket of tcpSockets) socket.destroy();
  tcpServer.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
