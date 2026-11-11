import { z } from "zod";
import { CATALOG_TYPES } from "../checks/catalog.ts";

export const ClarifySchema = z.object({
  questions: z.array(z.object({ term: z.string().min(1), question: z.string().min(5), options: z.array(z.string()).max(5).optional() })).max(6),
});
export type Clarify = z.infer<typeof ClarifySchema>;

/** Loose wire schema shown to the model; the strict ProposalSchema validates the result. */
export const proposalWireSchema = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "c1, c2, ..." },
          type: { type: "string", enum: [...CATALOG_TYPES] },
          // Every catalog param is listed (all optional here) so models that drop unlisted keys
          // still fill them; ProposalSchema then enforces exactly the params each type needs.
          params: {
            type: "object",
            description: "Exactly the params for this check type, as listed in the catalog.",
            properties: {
              width: { type: "integer", description: "viewport_render: viewport width in px, e.g. 375" },
              role: { type: "string", enum: ["button", "link", "heading", "textbox", "img", "navigation", "form", "checkbox", "combobox", "main", "banner", "contentinfo"], description: "element_present: ARIA role" },
              name: { type: "string", description: "element_present: accessible name" },
              text: { type: "string", description: "text_present: visible text to find" },
              fields: { type: "array", items: { type: "string" }, description: "form_submits: field names, e.g. name, email, message" },
              allowList: { type: "array", items: { type: "string" }, description: "no_console_errors: ignored error substrings (may be empty)" },
            },
          },
          description: { type: "string", description: "plain-language description for the client" },
        },
        required: ["id", "type", "params", "description"],
      },
    },
    manual: { type: "array", items: { type: "object", properties: { id: { type: "string", description: "m1, m2, ..." }, description: { type: "string" } }, required: ["id", "description"] } },
    advisory: { type: "array", items: { type: "string" } },
  },
  required: ["checks", "manual", "advisory"],
};

export const FixCoachSchema = z.object({
  explanation: z.string().min(5).max(1200),
  reproSteps: z.array(z.string().min(2)).min(1).max(10),
  likelyFix: z.string().min(5).max(1200),
});
export type FixCoach = z.infer<typeof FixCoachSchema>;

export const AgentFinishSchema = z.object({
  plan: z.array(z.object({ step: z.string(), locator: z.string().optional() })).max(30),
  observations: z.array(z.object({ text: z.string().max(500), evidenceRef: z.string().max(200) })).max(30),
});
