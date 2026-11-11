export type Role = "client" | "freelancer" | "admin";

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export type Check = { id: string; type: string; params: any; description: string };
export type Agreement = {
  milestone_id: string; version: number; hash: string | null; locked_at: string | null;
  client_approved_at: string | null; freelancer_approved_at: string | null;
  body: { checks: Check[]; manual: { id: string; description: string }[]; advisory: string[]; amount: { value: string; currency: string }; payee: { email: string }; deadlineAt: string; reviewRule: any };
};
export type Result = { id: string; checkId: string; status: "passed" | "failed" | "error"; expected: any; measured: any; evidence: { kind: string; ref: string }[]; explanation: any; agent: any; trace: any[] };
export type Run = { id: string; url: string; status: string; started_at: string; finished_at: string | null; error: string | null; results: Result[] };
export type Op = { id: string; type: string; idempotency_key: string; status: string; requested_at: string; responded_at: string | null; paypal_ref: string | null; error: string | null };
export type Ev = { id: number; at: string; actor: string; type: string; data: any };
export type Detail = {
  milestone: { id: string; title: string; state: string; amount_cents: number; currency: string; deadline_at: string; inbox_token: string };
  project: { id: string; title: string; brief: string; freelancer_email: string };
  agreement: Agreement | null;
  authorizations: { id: string; order_id: string; status: string; expires_at: string; replaced_by: string | null }[];
  operations: Op[];
  runs: Run[];
  events: Ev[];
  inboxUrl: string;
};
export type Config = { paypalClientId: string; fakePaypal: boolean; llm: string | null; demoSites: string[]; publicBaseUrl: string };

export const money = (cents: number, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);
export const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
