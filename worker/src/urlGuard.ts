/**
 * The verifier is a security boundary: it drives a real browser against a URL someone
 * else controls. Static checks + DNS checks + resolver pinning + per-request checks.
 */
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";

export type GuardConfig = { allowedHosts: string[]; devLocalOrigins: string[] };

export function configFromEnv(): GuardConfig {
  return {
    allowedHosts: (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    devLocalOrigins: (process.env.DEV_LOCAL_ORIGINS ?? "").split(",").map((h) => h.trim().replace(/\/$/, "")).filter(Boolean),
  };
}

export const isDevLocal = (u: URL, cfg: GuardConfig) => cfg.devLocalOrigins.includes(u.origin);

/** https only, no credentials, port 443 only, exact (punycode-normalised) host match. No suffix matching. */
export function staticCheck(raw: string, cfg: GuardConfig, opts: { allowHost?: string[] } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GuardError(`invalid URL: ${raw}`);
  }
  if (isDevLocal(u, cfg)) return u;
  if (u.protocol !== "https:") throw new GuardError(`blocked scheme ${u.protocol}`);
  if (u.username || u.password) throw new GuardError("credentials in URL");
  if (u.port && u.port !== "443") throw new GuardError(`blocked port ${u.port}`);
  const hosts = [...cfg.allowedHosts, ...(opts.allowHost ?? [])];
  if (!hosts.includes(u.hostname)) throw new GuardError(`host not allowlisted: ${u.hostname}`);
  return u;
}

/**
 * Only globally routable unicast addresses. Rejects loopback, private, link-local
 * (incl. 169.254.169.254 metadata), CGNAT, multicast, unique-local (fc00::/7),
 * link-local v6 (fe80::/10), reserved, unspecified, and v4-mapped forms of those.
 */
export function isForbiddenIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  const addr = ipaddr.process(ip); // unwraps ::ffff:a.b.c.d
  return addr.range() !== "unicast";
}

export async function resolvePublic(host: string, lookup = dns.lookup): Promise<string> {
  if (ipaddr.isValid(host.replace(/^\[|\]$/g, ""))) {
    const ip = host.replace(/^\[|\]$/g, "");
    if (isForbiddenIp(ip)) throw new GuardError(`forbidden address ${ip}`);
    return ip;
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new GuardError(`no address for ${host}`);
  for (const a of addrs) if (isForbiddenIp(a.address)) throw new GuardError(`${host} resolves to forbidden address ${a.address}`);
  return addrs[0].address;
}

/** Per-request check used by the Playwright route handler. */
export function requestAllowed(raw: string, allowedOrigins: Set<string>): boolean {
  if (/^(data|blob|about):/i.test(raw)) return true;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return allowedOrigins.has(u.origin);
}

export class GuardError extends Error {}
