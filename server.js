import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyze } from "./analysis.js";

const indexFile = fileURLToPath(new URL("./index.html", import.meta.url));
const bundleDir = fileURLToPath(new URL("./dist", import.meta.url));
const reject = (res, status, error) => res.status(status).json({ error });

function requireJson(req, res, next) {
  const origin = req.get("Origin");
  const host = req.get("Host");
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
    return reject(res, 403, "Origin rejected.");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.get("Content-Type") || "")) {
    return reject(res, 415, "Send JSON.");
  }
  next();
}

function analysisError(res, err) {
  if (err.name === "TimeoutError") {
    return reject(res, 504, "Analysis timed out. Try a shorter excerpt.");
  }
  switch (err.upstreamStatus) {
    case 401:
    case 403:
      return reject(res, 502, "Groq rejected the credentials. Check GROQ_API_KEY and restart the server.");
    case 429:
      return reject(res, 429, "Groq rate limit reached. Wait briefly or try a shorter excerpt.");
    default:
      return reject(res, 502, "Groq could not return a complete, verifiable analysis. Try again.");
  }
}

export function app({ apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL, fetchImpl } = {}) {
  const server = express();
  let active = 0;

  server.disable("x-powered-by");
  server.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    });
    next();
  });

  server.get("/", (req, res) => res.sendFile(indexFile));
  server.get("/app.js", (req, res) => res.sendFile("app.js", { root: bundleDir }));
  server.get("/app.css", (req, res) => res.sendFile("app.css", { root: bundleDir }));

  server.post("/api/analyze", requireJson, express.json({ limit: 512000, inflate: false }), async (req, res) => {
    const transcripts = req.body?.transcripts;
    if (!Array.isArray(transcripts) || transcripts.length !== 2 ||
        transcripts.some(text => typeof text !== "string" || !text.trim() || text.length > 50000)) {
      return reject(res, 400, "Provide two transcripts of up to 50,000 characters each.");
    }
    if (!apiKey) return reject(res, 503, "Set GROQ_API_KEY in .env and restart the server.");
    if (active >= 3) return reject(res, 429, "Analysis is busy. Try again shortly.");

    active++;
    try {
      const findings = await analyze(transcripts, { apiKey, model, fetchImpl });
      res.json({ findings });
    } catch (err) {
      analysisError(res, err);
    } finally {
      active--;
    }
  });

  server.all("/api/analyze", (req, res) => reject(res.set("Allow", "POST"), 405, "Use POST."));
  server.use((req, res) => reject(res, 404, "Unknown endpoint."));
  server.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.too.large") return reject(res, 413, "Request too large.");
    if (err.type === "entity.parse.failed") return reject(res, 400, "Invalid JSON.");
    if (err.status === 415) return reject(res, 415, "Unsupported request encoding.");
    return reject(res, 500, "Server error.");
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  app().listen(port, "127.0.0.1", () => console.log(`Deposition review at http://127.0.0.1:${port}`));
}
