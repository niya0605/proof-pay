/** Thin PayPal REST client. Only paymentService imports this module. */
export class PayPalError extends Error {
  constructor(
    public kind: "timeout" | "network" | "http",
    public status: number | null,
    public body: any,
    message: string,
  ) {
    super(message);
  }
  /** Definitive answer from PayPal (4xx) vs. outcome unknown (timeout, network, 5xx). */
  get definitive() {
    return this.kind === "http" && this.status !== null && this.status >= 400 && this.status < 500;
  }
  get issue(): string | undefined {
    return this.body?.details?.[0]?.issue ?? this.body?.name;
  }
}

const base = () => process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com";
const timeoutMs = () => Number(process.env.PAYPAL_TIMEOUT_MS ?? 20000);
let token: { value: string; exp: number; base: string } | null = null;

export async function getToken(): Promise<string> {
  if (token && token.base === base() && Date.now() < token.exp - 60_000) return token.value;
  const id = process.env.PAYPAL_CLIENT_ID ?? "";
  const secret = process.env.PAYPAL_CLIENT_SECRET ?? "";
  const res = await raw("POST", "/v1/oauth2/token", {
    body: "grant_type=client_credentials",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  token = { value: res.access_token, exp: Date.now() + res.expires_in * 1000, base: base() };
  return token.value;
}
export const resetTokenCache = () => (token = null);

async function raw(method: string, path: string, init: { body?: string; headers: Record<string, string> }) {
  let res: Response;
  try {
    res = await fetch(base() + path, { method, body: init.body, headers: init.headers, signal: AbortSignal.timeout(timeoutMs()) });
  } catch (e: any) {
    const kind = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network";
    throw new PayPalError(kind, null, null, `${method} ${path}: ${kind} (${e?.message})`);
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw new PayPalError("http", res.status, body, `${method} ${path}: HTTP ${res.status} ${body?.name ?? ""} ${body?.details?.[0]?.issue ?? ""}`.trim());
  return body;
}
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
};

async function call(method: string, path: string, opts: { body?: unknown; requestId?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await getToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  return raw(method, path, { body: opts.body === undefined ? undefined : JSON.stringify(opts.body), headers });
}

export type OrderInput = { value: string; currency: string; customId: string; invoiceId: string; payeeEmail?: string; description: string };

export function createOrder(o: OrderInput, requestId: string) {
  return call("POST", "/v2/checkout/orders", {
    requestId,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: o.invoiceId,
          description: o.description.slice(0, 127),
          custom_id: o.customId,
          invoice_id: o.invoiceId,
          amount: { currency_code: o.currency, value: o.value },
          ...(o.payeeEmail ? { payee: { email_address: o.payeeEmail } } : {}),
        },
      ],
      // Demo convenience: pre-fill the sandbox buyer's email on PayPal's login screen.
      ...(process.env.PAYPAL_PREFILL_BUYER_EMAIL ? { payer: { email_address: process.env.PAYPAL_PREFILL_BUYER_EMAIL } } : {}),
    },
  });
}
export const getOrder = (orderId: string) => call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
export const authorizeOrder = (orderId: string, requestId: string) =>
  call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, { requestId, body: {} });
export const captureAuthorization = (authId: string, invoiceId: string, requestId: string) =>
  call("POST", `/v2/payments/authorizations/${encodeURIComponent(authId)}/capture`, { requestId, body: { final_capture: true, invoice_id: invoiceId } });
export const voidAuthorization = (authId: string, requestId: string) =>
  call("POST", `/v2/payments/authorizations/${encodeURIComponent(authId)}/void`, { requestId });
export const reauthorizeAuthorization = (authId: string, amount: { value: string; currency: string }, requestId: string) =>
  call("POST", `/v2/payments/authorizations/${encodeURIComponent(authId)}/reauthorize`, {
    requestId,
    body: { amount: { value: amount.value, currency_code: amount.currency } },
  });
