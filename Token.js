// Vercel serverless function: forwards the OAuth token exchange to Deriv.
// app.js only uses this if the browser blocks the direct request (CORS).
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string" ? req.body : new URLSearchParams(req.body || {}).toString();

    const upstream = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "proxy_failed", error_description: "Could not reach Deriv." });
  }
};