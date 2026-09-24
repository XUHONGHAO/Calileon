import http from "node:http";

const port = Number(process.env.AI_PROXY_SMOKE_UPSTREAM_PORT || 8090);

const server = http.createServer((request, response) => {
  const path = new URL(request.url || "/", "http://smoke.local").pathname;
  if (path.endsWith("/sse")) {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
    });
    response.write("data: first\n\n");
    setTimeout(() => response.end("data: second\n\n"), 150);
    return;
  }
  if (path.endsWith("/binary")) {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write(Buffer.from([0, 1, 2, 255]));
    setTimeout(() => response.end(Buffer.from([254, 3, 4, 0])), 150);
    return;
  }
  if (path.endsWith("/json")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`smoke-upstream listening on ${port}\n`);
});

const shutdown = () =>
  server.close(() => {
    process.exit(0);
  });
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
