import { z } from "zod";

/** The only five check types the brief workflow may emit. */
export const CATALOG_TYPES = ["viewport_render", "element_present", "text_present", "form_submits", "no_console_errors"] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/i);
const description = z.string().min(3).max(300);
const ARIA_ROLES = ["button", "link", "heading", "textbox", "img", "navigation", "form", "checkbox", "combobox", "main", "banner", "contentinfo"] as const;

export const CheckSchema = z.discriminatedUnion("type", [
  z.object({ id, description, type: z.literal("viewport_render"), params: z.object({ width: z.number().int().min(240).max(2560) }).strict() }).strict(),
  z.object({ id, description, type: z.literal("element_present"), params: z.object({ role: z.enum(ARIA_ROLES), name: z.string().min(1).max(100) }).strict() }).strict(),
  z.object({ id, description, type: z.literal("text_present"), params: z.object({ text: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ id, description, type: z.literal("form_submits"), params: z.object({ fields: z.array(z.string().regex(/^[a-z][a-z0-9_ -]{0,30}$/i)).min(1).max(8) }).strict() }).strict(),
  z.object({ id, description, type: z.literal("no_console_errors"), params: z.object({ allowList: z.array(z.string().max(200)).max(20) }).strict() }).strict(),
]);
export type Check = z.infer<typeof CheckSchema>;

export const ManualSchema = z.object({ id, description }).strict();
export type Manual = z.infer<typeof ManualSchema>;

export const ProposalSchema = z
  .object({
    checks: z.array(CheckSchema).min(1).max(12),
    manual: z.array(ManualSchema).max(6),
    advisory: z.array(z.string().min(1).max(200)).max(6),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = [...p.checks.map((c) => c.id), ...p.manual.map((m) => m.id)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "criterion ids must be unique" });
  });
export type Proposal = z.infer<typeof ProposalSchema>;

/** Fixed test data, so every run is reproducible. */
export const TEST_VALUES: Record<string, string> = {
  name: "Test User",
  email: "test@proofpay.dev",
  message: "Proof-Pay test message",
  phone: "+1 555 0100",
  subject: "Proof-Pay test subject",
  company: "Proof-Pay Test Co",
};
export const testValueFor = (field: string) => TEST_VALUES[field.toLowerCase()] ?? `Proof-Pay test ${field}`;

/** Deterministic fallback used when the brief workflow can't produce a valid proposal. */
export function templateProposal(brief: string): Proposal {
  const wantsForm = /form|contact|enquir|inquir|message/i.test(brief);
  const checks: Check[] = [
    { id: "c1", type: "viewport_render", params: { width: 375 }, description: "Fits a phone screen with no sideways scrolling" },
    { id: "c2", type: "viewport_render", params: { width: 1280 }, description: "Renders on a laptop screen with no sideways scrolling" },
  ];
  if (wantsForm) {
    checks.push(
      { id: "c3", type: "element_present", params: { role: "button", name: "Send" }, description: "Contact form has a Send button" },
      { id: "c4", type: "form_submits", params: { fields: ["name", "email", "message"] }, description: "Contact form sends name, email and message" },
    );
  }
  checks.push({ id: `c${checks.length + 1}`, type: "no_console_errors", params: { allowList: [] }, description: "No browser errors" });
  return {
    checks,
    manual: [{ id: "m1", description: "Uses the logo and brand colours the client supplied" }],
    advisory: ["Visual polish and brand fit"],
  };
}
