/**
 * The Utilade conversion service.
 *
 * Seven tools on utilade.com cannot run in a browser, because they need
 * LibreOffice to open Word, Excel and PowerPoint files. This is where those
 * run. Everything else on the site runs on the visitor's own machine and
 * always will.
 *
 * Two rules that must survive every future change to this file:
 *
 *   1. **A file is deleted the moment its reply is sent** — not on a timer,
 *      not by a nightly sweep. We tell every visitor we do not keep their
 *      documents, and this is the only place that promise is true or false.
 *   2. **Only two jobs run at once.** This box serves other people's customers too,
 *      and the queue is what keeps a Utilade spike from becoming their outage.
 *
 * The upload is deliberately raw bytes with the name in a header rather than a
 * multipart form: the only client is our own page, multipart would mean either
 * a dependency or a parser of our own, and both are more attack surface than a
 * `Content-Length` and a filename.
 */

import { createServer } from "node:http";

import { convert, isSupported, supported } from "./convert.mjs";
import { createQueue } from "./queue.mjs";

const PORT = Number(process.env.PORT ?? 8081);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 60_000);

/* Cloudflare's free plan stops at 100 MB, so anything larger cannot reach us
   anyway — but the limit is enforced here too, because the day we move off
   Cloudflare must not be the day this becomes unbounded. */
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 100 * 1024 * 1024);

const queue = createQueue({ concurrency: MAX_CONCURRENT });

/**
 * Who is allowed to call this.
 *
 * A browser will not let utilade.com talk to api.utilade.com without being
 * told it may — different host, so it is a cross-origin request whatever the
 * domain suffix says. The list is explicit rather than `*` because this
 * endpoint spends real CPU on a box that serves other people too: anyone may *use* the
 * tools, but only our own pages get to queue work on that machine from a
 * visitor's browser.
 */
const ALLOWED_ORIGINS = new Set([
  "https://utilade.com",
  "https://www.utilade.com",
  /* The dev server, so the page can be built against the real API. */
  "http://localhost:3000",
]);

const corsHeaders = (origin) => {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    /* Tells caches that the answer differs per origin — without it a proxy can
       hand one origin's permission to another. */
    vary: "Origin",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-filename",
    /* The page reads this to name the download correctly. */
    "access-control-expose-headers": "x-extension",
    "access-control-max-age": "86400",
  };
};

const json = (response, status, body, origin) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...corsHeaders(origin),
  });
  response.end(payload);
};

/** Read the whole body, refusing anything over the limit as it arrives. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > MAX_BYTES) {
      const error = new Error("That file is too large.");
      error.status = 413;
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      /* Checked as it streams, not only from the header — a header is a claim,
         not a fact. */
      if (size > MAX_BYTES) {
        const error = new Error("That file is too large.");
        error.status = 413;
        request.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const origin = request.headers.origin;

  /* The preflight. A POST carrying X-Filename is never a "simple" request, so
     the browser asks permission before it will send a single byte of the
     file. */
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }

  if (url.pathname === "/health") {
    json(
      response,
      200,
      {
        status: "ok",
        running: queue.running,
        waiting: queue.waiting,
        capacity: MAX_CONCURRENT,
        jobTimeoutMs: JOB_TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        formats: supported(),
        service: "utilade-convert",
        version: 2,
      },
      origin,
    );
    return;
  }

  if (url.pathname !== "/convert") {
    json(response, 404, { error: "No such endpoint." }, origin);
    return;
  }

  if (request.method !== "POST") {
    json(response, 405, { error: "Send the file with POST." }, origin);
    return;
  }

  const fileName = String(request.headers["x-filename"] ?? "").trim();
  const target = (url.searchParams.get("to") ?? "pdf").toLowerCase();

  if (!fileName) {
    json(response, 400, { error: "Missing the X-Filename header." }, origin);
    return;
  }

  if (!isSupported(fileName, target)) {
    json(
      response,
      415,
      { error: `We can't convert that to ${target}.`, formats: supported() },
      origin,
    );
    return;
  }

  /* Refuse before reading the upload, so a busy server does not spend anyone's
     bandwidth on a file it will not touch. */
  if (queue.full) {
    request.resume();
    json(
      response,
      503,
      { error: "The converter is busy. Please try again in a moment." },
      origin,
    );
    return;
  }

  try {
    const bytes = await readBody(request);

    /* ?engine=editable picks the reconstruction engine over the tracing one.
       Undocumented on the site for now: it exists so the two can be compared
       on identical files before either is promised to anybody. */
    const engine = url.searchParams.get("engine") ?? "layout";

    const result = await queue.run(() =>
      convert(bytes, fileName, target, { timeoutMs: JOB_TIMEOUT_MS, engine }),
    );

    response.writeHead(200, {
      "content-type": result.type,
      "content-length": result.bytes.length,
      "cache-control": "no-store",
      /* The name is the caller's problem to display; we only say the shape. */
      "x-extension": result.extension,
      ...corsHeaders(origin),
    });
    response.end(result.bytes);
  } catch (error) {
    const status = error.status ?? 500;
    /* The message is written to be shown to whoever uploaded the file. */
    json(
      response,
      status,
      { error: error.message || "Conversion failed." },
      origin,
    );
  }
});

/* A conversion is slow by nature, so there is no whole-request timeout — the
   job's own 60 seconds is the limit that matters. Headers are a different
   story: a connection that has not sent them in a minute is not slow, it is
   gone. */
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 120_000;

server.listen(PORT, "0.0.0.0", () => {
  /* 0.0.0.0 inside the container is fine — compose publishes the port to
     127.0.0.1 only, so nginx remains the sole way in. */
  console.log(
    `utilade-convert listening on ${PORT}, ${MAX_CONCURRENT} jobs at a time`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
