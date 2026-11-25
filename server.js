import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyze } from "./analysis.js";

const assets = new Map([["/", ["index.html", "text/html"]], ["/app.js", ["dist/app.js", "text/javascript"]], ["/app.css", ["dist/app.css", "text/css"]]]);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function app({ apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL, fetchImpl } = {}) {
  let active = 0;
  return createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.method === "GET" && assets.has(req.url)) {
        const [file, type] = assets.get(req.url);
        const bytes = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
        return res.end(bytes);
      }
      if (req.url !== "/api/analyze") throw fail(404, "Unknown endpoint.");
      if (req.method !== "POST") throw fail(405, "Use POST.");
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) throw fail(403, "Origin rejected.");
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw fail(415, "Send JSON.");
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 512000) throw fail(413, "Request too large.");
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, "Invalid JSON."); }
      const inputs = body?.transcripts;
      if (!Array.isArray(inputs) || inputs.length !== 2 || inputs.some(value => typeof value !== "string" || !value.trim() || value.length > 50000)) throw fail(400, "Provide two transcripts of up to 50,000 characters each.");
      if (!apiKey) throw fail(503, "Set GROQ_API_KEY in .env and restart the server.");
      if (active >= 3) throw fail(429, "Analysis is busy. Try again shortly.");
      active++;
      try {
        const findings = await analyze(inputs, { apiKey, model, fetchImpl });
        send(200, { findings });
      } catch (err) {
        if (err.name === "TimeoutError") throw fail(504, "Analysis timed out. Try a shorter excerpt.");
        if (err.upstreamStatus === 401 || err.upstreamStatus === 403) throw fail(502, "Groq rejected the credentials. Check GROQ_API_KEY and restart the server.");
        if (err.upstreamStatus === 429) throw fail(429, "Groq rate limit reached. Wait briefly or try a shorter excerpt.");
        throw fail(502, `Groq could not return a complete, verifiable analysis. Try again.`);
      } finally { active--; }
    } catch (err) { send(err.status || 500, { error: err.status ? err.message : "Server error." }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  app().listen(port, "127.0.0.1", () => console.log(`Deposition review at http://127.0.0.1:${port}`));
}
