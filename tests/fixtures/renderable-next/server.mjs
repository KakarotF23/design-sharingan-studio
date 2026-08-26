import { createServer } from "node:http";

const port = Number.parseInt(process.env.RENDER_FIXTURE_PORT ?? "", 10);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("RENDER_FIXTURE_PORT must be a valid non-privileged port");
}

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Render Evidence Fixture</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        min-height: 100vh;
        display: grid;
        place-items: center;
        color: #e8edf4;
        background: #0b0d10;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      main { width: min(760px, calc(100% - 48px)); border-top: 1px solid #b5473f; padding-top: 32px; }
      p { color: #a9b1bc; line-height: 1.6; }
      small { color: #d67a70; letter-spacing: .16em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <main>
      <small>Real render target</small>
      <h1>Evidence comes from the browser.</h1>
      <p>This page is served by a real child process and captured at the requested viewport.</p>
    </main>
  </body>
</html>`;

const server = createServer((request, response) => {
  if (request.url !== "/") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(page);
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
