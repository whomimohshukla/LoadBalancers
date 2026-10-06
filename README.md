# Load Balancer — L4 + L7 Learning Project

A small, single-process TypeScript load balancer for learning system design. It exposes:

- **L7 HTTP reverse proxy** at `http://localhost:8080` (default), using round robin across healthy HTTP backends.
- **L4 TCP proxy** on port `9000` (default), copying a TCP connection in both directions to a healthy TCP backend.
- **Health and status endpoints** at `/health` and `/lb/status` on the L7 listener.

This project is intentionally small and educational. It is **not production-ready** and is not a replacement for NGINX, HAProxy, Envoy, a cloud load balancer, or a Kubernetes ingress.

## Run it

Requirements: Node.js 18 or newer and npm.

```sh
npm install
npm run dev
```

Or run without watch mode:

```sh
npm start
```

The load balancer starts even if a backend is down. Until at least one backend in a pool passes its health check, requests for that pool receive no healthy backend: L7 responds `503`; an L4 client connection is closed with a short message.

### Configure backends

Environment variables are optional; defaults are shown below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | L7 HTTP listener port |
| `L4_PORT` | `9000` | L4 TCP listener port |
| `BACKENDS` | `http://localhost:3001,http://localhost:3002` | Comma-separated HTTP(S) origins; each must answer `GET /health` with 2xx |
| `L4_BACKENDS` | `localhost:3001,localhost:3002` | Comma-separated TCP `host:port` targets |
| `HEALTH_INTERVAL_MS` | `5000` | Time between active backend probes |
| `HEALTH_TIMEOUT_MS` | `2000` | Per-probe timeout |

Example:

```sh
BACKENDS=http://127.0.0.1:3001,http://127.0.0.1:3002 \
L4_BACKENDS=127.0.0.1:9101,127.0.0.1:9102 \
PORT=8080 L4_PORT=9000 npm run dev
```

The L7 reverse proxy forwards the original HTTP method, path, headers, and body. Its health endpoint is `GET /health`; its operational view is `GET /lb/status`. The L4 listener is a raw TCP stream and does not understand HTTP paths, headers, or status codes.

### Quick backend examples

Run a tiny HTTP backend on port 3001 in a separate terminal:

```sh
node -e 'const e=require("node:http"); const s=e.createServer((q,r)=>{if(q.url==="/health"){r.writeHead(200);r.end("ok");return}r.end(`backend 3001: ${q.method} ${q.url}\n`)});s.listen(3001,"127.0.0.1",()=>console.log("backend on 3001"))'
```

Start another copy on port 3002 by changing `3001` to `3002` in that command. Once both health checks pass:

```sh
curl http://localhost:8080/example
curl http://localhost:8080/example
curl http://localhost:8080/lb/status
```

The first two requests should alternate backend responses. To test TCP forwarding, set `L4_BACKENDS` to TCP echo servers and connect to `localhost:9000` with a TCP client such as `nc`; TCP echo backends are not HTTP health endpoints.

## What this implementation demonstrates

- Independent L4 and L7 listeners in one process.
- Round-robin distribution over currently healthy backend pools.
- Active health checks and recovery detection.
- L7 `503 Service Unavailable` when all HTTP targets are unhealthy and `502 Bad Gateway` on an upstream proxy failure.
- Bidirectional TCP piping and L4 connection failure handling.
- Basic operational visibility through health/status endpoints and console logs.
- Graceful shutdown handling for `SIGINT` and `SIGTERM`.

## System design notes

### What is a load balancer?

A load balancer accepts client traffic and selects a backend to serve it. It can improve capacity, availability, and deployment flexibility, but it does not make an application highly available by itself. The load balancer, its network path, and the backend fleet all need capacity and failure planning.

Typical request path:

```text
Client -> DNS -> (optional CDN/WAF) -> Load balancer -> Healthy application backend -> Cache/database/other dependencies
```

### L4 vs L7

| Property | Layer 4 | Layer 7 |
| --- | --- | --- |
| OSI layer | Transport (usually TCP or UDP) | Application (HTTP/HTTPS, gRPC, etc.) |
| Routing can inspect | IP addresses, ports, transport protocol | Host, URL/path, headers, cookies, method, application metadata |
| Knows HTTP semantics? | No | Yes |
| Typical behavior | Forwards connections or packets | Terminates/parses requests and proxies them |
| Strengths | Lower overhead, protocol-agnostic, useful for non-HTTP TCP | Flexible routing, TLS termination, authentication/rate limits, richer observability |
| Trade-offs | Cannot route by URL or HTTP host; TCP connection selection can pin many requests to one backend | More CPU/memory, understands and may modify protocol, more complex |
| Examples | TCP proxy, cloud network load balancer | HTTP reverse proxy, ingress controller, API gateway |

**TLS note:** an L4 proxy can pass encrypted TLS bytes through without decrypting them. An L7 proxy commonly terminates TLS, reads HTTP, and may create a separate TLS connection to the backend. TLS termination changes where certificates, encryption, and trust boundaries are managed.

### Balancing algorithms

- **Round robin:** choose each backend in sequence. Simple; this project uses round robin over healthy targets.
- **Weighted round robin:** give larger/stronger backends more turns.
- **Least connections:** choose the backend with the fewest active connections; helpful when connection/request durations vary.
- **Least response time / power of two choices:** prefer lower observed latency or compare two random backends. Requires meaningful metrics and careful smoothing.
- **Consistent hashing:** map a key (often client/session/cache key) to a backend with limited remapping as the fleet changes. Useful for locality; can create hotspots.
- **Random:** simple distribution; often works well at scale, especially with power-of-two choices.

Choose based on workload, backend differences, request cost, state, and failure behavior—not just popularity. HTTP request balancing and TCP connection balancing have different granularity: a long-lived TCP connection stays on the backend selected at connection setup.

### Health checks and failure handling

- **Active checks** send periodic probes; this project calls each HTTP target's `/health` and attempts a TCP connection for L4 targets.
- **Passive checks** infer failure from real request errors, timeouts, or bad responses.
- Health endpoints should report readiness for the work the service can actually perform. Avoid marking a service healthy merely because its process is alive.
- Production systems use thresholds, cooldowns, and recovery policies to avoid flapping. This demo marks health based on each probe and does not implement hysteresis.
- Set timeouts on connection establishment, response headers, and total request duration. Retry only when safe; retries can amplify overload and duplicate non-idempotent writes.
- Return clear overload/unavailable responses, and use bounded queues rather than allowing unlimited waiting.

### Important system-design concerns

1. **Capacity and bottlenecks:** estimate requests/second, concurrent connections, payload sizes, TLS cost, and backend capacity. Load balancers can become CPU, bandwidth, file-descriptor, or connection-table bottlenecks.
2. **Availability and scaling:** use redundant load-balancer instances across failure zones; health-check the load balancers themselves; avoid one DNS/IP/control-plane dependency. Define failover behavior.
3. **Connection lifecycle:** consider keep-alive, idle and request timeouts, connection draining during deploys, maximum connections, backpressure, and slow clients.
4. **State and sessions:** prefer stateless backends and shared external state. If sessions are local, affinity/sticky sessions may be needed, but they reduce flexibility and can cause uneven load.
5. **TLS and security:** certificate lifecycle, TLS policy, trusted proxy headers, access control, request-size limits, rate limits, DDoS protection, and not trusting client-supplied forwarding headers blindly.
6. **Routing:** host/path rules, API versions, canary/blue-green rollout, weighted traffic shifting, and a safe default route.
7. **Observability:** request rate, error rate, latency percentiles, active connections, per-backend traffic/health, saturation, and structured logs. Avoid high-cardinality labels such as raw URLs or user IDs.
8. **Retries and overload:** use bounded retries with backoff/jitter and retry budgets. Apply circuit breakers/load shedding carefully; cascading retries can worsen an outage.
9. **Deployment and configuration:** validate backend lists, support safe reloads, drain connections, keep configuration versioned, and test rollback procedures.
10. **Protocol and topology:** choose L4 or L7 based on required routing/visibility; decide whether a CDN, WAF, API gateway, service mesh, or ingress already provides overlapping functions.

### What this demo does not provide

It has no TLS termination, UDP proxy, weights, least-connections strategy, sticky sessions, passive health tracking, retries, circuit breaker, rate limiting, authentication, request-body limits, metrics exporter, config reload, multi-process coordination, connection draining, or high availability. Health/counters are in memory and disappear on restart. TCP listeners and health checks are intentionally minimal; production proxying needs more detailed timeouts, resource limits, protocol handling, and security hardening.

## Troubleshooting

- **L7 responds 503:** inspect `GET /lb/status`; make sure configured HTTP backends answer `GET /health` with a 2xx response and the right ports are reachable.
- **L7 responds 502:** the chosen backend stopped accepting connections or failed during the request.
- **L4 connection is closed:** check that a TCP backend is reachable and passed its connection probe. An HTTP service can accept TCP connections, but raw data sent to it still needs to be valid for its protocol.
- **Address already in use:** change `PORT` or `L4_PORT`.
- **Stop the server:** press `Ctrl+C` once; repeated `^C` is just repeated interrupts, not a command to type into the shell.

## Suggested learning exercises

1. Add weighted round robin and compare distributions over 100 requests.
2. Add separate failure and recovery thresholds to prevent health flapping.
3. Add per-backend request/connection counters and latency histograms.
4. Implement least-connections for L4 and discuss what a connection count means for HTTP keep-alive.
5. Add graceful backend draining before removing a target.
6. Draw a multi-zone architecture and identify every single point of failure.
7. Decide where TLS terminates and which components are trusted to set `X-Forwarded-For`.
