// api/pump.js — Vercel serverless proxy for PumpPortal's Local trade endpoint.
// Reads the RAW request body and forwards it byte-for-byte, so no re-serialization
// can drop or mangle fields (a parsed-then-restringified body was causing 400s).
// PumpPortal returns a serialized transaction as raw bytes; we pass those straight
// back. Proxying avoids browser CORS and mirrors the /api/quote pattern.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const raw = await readRawBody(req);
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({ error: txt || r.statusText });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/octet-stream");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || "proxy error" });
  }
}
