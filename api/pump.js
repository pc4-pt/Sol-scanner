// api/pump.js — Vercel serverless proxy for PumpPortal's Local trade endpoint.
// Browser → /api/pump → https://pumpportal.fun/api/trade-local. The endpoint
// returns a serialized transaction as raw bytes, which we pass straight through;
// the client deserializes, signs locally, and broadcasts it. Proxying avoids
// browser CORS and keeps the call server-side, matching the /api/quote pattern.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  try {
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
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
