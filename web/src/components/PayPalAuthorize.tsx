import { useState } from "react";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";
import { ErrorText } from "./ui.tsx";

/** Client authorizes the milestone payment. A real person approves in the PayPal sandbox popup. */
export default function PayPalAuthorize({ milestoneId, onDone }: { milestoneId: string; onDone: () => void }) {
  const { config } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const createOrder = async () => (await api<{ orderId: string }>("POST", `/api/milestones/${milestoneId}/paypal-order`)).orderId;
  const authorize = async (orderId: string) => {
    await api("POST", `/api/milestones/${milestoneId}/authorize`, { orderId });
    onDone();
  };
  if (!config) return null;
  if (config.fakePaypal) {
    return (
      <div>
        <button className="btn-primary w-full" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            const id = await createOrder();
            await api("POST", `/api/dev/fake-approve/${id}`);
            await authorize(id);
          } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>Approve in the local PayPal stand-in</button>
        <p className="mt-1 text-xs text-stone-500">FAKE_PAYPAL=1: set sandbox credentials in .env to use the real PayPal popup.</p>
        <ErrorText error={error} />
      </div>
    );
  }
  if (!config.paypalClientId) return <ErrorText error="PAYPAL_CLIENT_ID is not configured" />;
  return (
    <div>
      <PayPalScriptProvider options={{ clientId: config.paypalClientId, intent: "authorize", currency: "USD", dataCspNonce: cspNonce() }}>
        <PayPalButtons
          style={{ layout: "vertical", label: "pay" }}
          fundingSource="paypal"
          createOrder={createOrder}
          onApprove={async (data) => {
            try { await authorize(data.orderID); } catch (e) { setError((e as Error).message); }
          }}
          onError={(e) => setError(String((e as any)?.message ?? e))}
        />
      </PayPalScriptProvider>
      <ErrorText error={error} />
    </div>
  );
}

/** The server stamps each page with a CSP nonce; PayPal's SDK needs it for the scripts it injects. */
function cspNonce(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content || undefined;
}
