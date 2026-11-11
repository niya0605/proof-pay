/**
 * Static URL policy, applied on submit. The worker re-applies it and adds DNS checks,
 * resolver pinning and per-request route checks.
 */
export function allowedHosts(): string[] {
  return (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}
/** Dev-only exact origins (e.g. http://localhost:5174) that bypass https/443. Never set in production. */
export function devLocalOrigins(): string[] {
  return (process.env.DEV_LOCAL_ORIGINS ?? "").split(",").map((h) => h.trim().replace(/\/$/, "")).filter(Boolean);
}

export function checkSubmittedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (devLocalOrigins().includes(u.origin)) return u;
  if (u.protocol !== "https:") throw new Error("only https URLs are accepted");
  if (u.username || u.password) throw new Error("credentials in the URL are not allowed");
  if (u.port && u.port !== "443") throw new Error("only port 443 is allowed");
  // URL() already lower-cases and punycodes the hostname. Exact match, no suffix matching.
  if (!allowedHosts().includes(u.hostname)) throw new Error(`host ${u.hostname} is not on the allowlist`);
  return u;
}
