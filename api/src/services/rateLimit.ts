import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errors.ts";

/**
 * Small in-memory fixed-window rate limiter (single API process). `keyOf` picks the bucket:
 * client IP for login, session cookie for AI-cost routes.
 */
export function rateLimit(opts: { name: string; max: number; windowMs: number; keyOf?: (req: Request) => string }) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const key = (opts.keyOf ?? ((r) => r.ip ?? "unknown"))(req);
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + opts.windowMs });
    else if (++h.n > opts.max) return next(new HttpError(429, `too many ${opts.name} requests; try again in ${Math.ceil((h.reset - now) / 1000)}s`));
    next();
  };
}
