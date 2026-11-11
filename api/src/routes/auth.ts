import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rateLimit } from "../services/rateLimit.ts";
import { HttpError } from "../services/errors.ts";

export type Role = "client" | "freelancer" | "admin";
export const DEMO_USERS: Record<Role, { id: string; name: string }> = {
  client: { id: "u_client", name: "Dana (client)" },
  freelancer: { id: "u_freelancer", name: "Ravi (freelancer)" },
  admin: { id: "u_admin", name: "Demo admin" },
};

/** Server-side sessions. The role always comes from here, never from a request field. */
const sessions = new Map<string, { role: Role; exp: number }>();
const COOKIE = "pp_sid";

function sid(req: Request): string | undefined {
  const raw = req.headers.cookie ?? "";
  const v = raw.split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1];
  return v && /^[0-9a-f]{48}$/.test(v) ? v : undefined;
}
export function roleOf(req: Request): Role | null {
  const s = sid(req);
  const entry = s ? sessions.get(s) : undefined;
  if (!entry) return null;
  if (entry.exp < Date.now()) {
    sessions.delete(s!);
    return null;
  }
  return entry.role;
}
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const r = roleOf(req);
    if (!r) return next(new HttpError(401, "log in first"));
    if (roles.length && !roles.includes(r)) return next(new HttpError(403, `requires role ${roles.join(" or ")}`));
    (req as any).role = r;
    next();
  };
}

const SESSION_MAX_AGE_S = 12 * 3600;
const secureCookie = () => (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://");
/** Session cookie id, for per-session rate limits. */
export const sessionKey = (req: Request) => sid(req) ?? req.ip ?? "anon";

function sameSecret(a: unknown, b: string) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const authRouter = Router();
authRouter.post("/login", rateLimit({ name: "login", max: 20, windowMs: 60_000 }), (req, res) => {
  const role = req.body?.role as Role;
  if (!DEMO_USERS[role]) throw new HttpError(400, "unknown demo user");
  const code = process.env.DEMO_LOGIN_CODE;
  if (code && !sameSecret(req.body?.code, code)) throw new HttpError(401, "wrong demo access code");
  const id = randomBytes(24).toString("hex");
  const old = sid(req);
  if (old) sessions.delete(old); // switching role: drop the previous session
  sessions.set(id, { role, exp: Date.now() + SESSION_MAX_AGE_S * 1000 });
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}${secureCookie() ? "; Secure" : ""}`);
  res.json({ role, user: DEMO_USERS[role] });
});
authRouter.post("/logout", (req, res) => {
  const s = sid(req);
  if (s) sessions.delete(s);
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureCookie() ? "; Secure" : ""}`);
  res.json({ ok: true });
});
authRouter.get("/me", (req, res) => {
  const role = roleOf(req);
  res.json(role ? { role, user: DEMO_USERS[role] } : { role: null });
});
