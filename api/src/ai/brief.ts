import { runAI } from "./engine.ts";
import { ClarifySchema, proposalWireSchema, type Clarify } from "./schemas.ts";
import { ProposalSchema, templateProposal, type Proposal } from "../checks/catalog.ts";

const VAGUE: Record<string, { question: string; options: string[] }> = {
  "mobile-friendly": { question: "Which phone width must the page fit without sideways scrolling?", options: ["375px (iPhone)", "360px (Android)", "320px (small phones)"] },
  mobile: { question: "Which phone width must the page fit without sideways scrolling?", options: ["375px (iPhone)", "360px (Android)", "320px (small phones)"] },
  responsive: { question: "Which screen widths must render without sideways scrolling?", options: ["375px and 1280px", "360px, 768px and 1280px"] },
  fast: { question: "What does 'fast' mean for this page? (Load-time measurement isn't in this build's catalog; it can be an advisory note or a manual criterion.)", options: ["Advisory note only", "Manual criterion the client checks", "Drop it"] },
  working: { question: "What exactly must work? Which fields must the contact form deliver?", options: ["name, email, message", "name, email, phone, message"] },
  "contact form": { question: "Which fields must the contact form deliver, and what is the submit button called?", options: ["name, email, message / Send", "name, email, message / Submit"] },
  modern: { question: "'Modern' can't be tested automatically. Should it be a manual criterion or advisory?", options: ["Manual criterion", "Advisory note"] },
  clean: { question: "'Clean' can't be tested automatically. Should it be a manual criterion or advisory?", options: ["Manual criterion", "Advisory note"] },
  "no errors": { question: "Should any browser console messages be allowed (e.g. third-party analytics)?", options: ["None allowed", "Allow analytics warnings"] },
};

/** Deterministic fallback for step 1: flag known vague words. */
export function templateQuestions(brief: string): Clarify {
  const seen = new Set<string>();
  const questions = Object.entries(VAGUE)
    .filter(([term]) => brief.toLowerCase().includes(term))
    .filter(([, q]) => (seen.has(q.question) ? false : (seen.add(q.question), true)))
    .map(([term, q]) => ({ term, ...q }));
  return { questions };
}

const CATALOG_DOC = `Check catalog (the ONLY allowed automated check types):
- viewport_render  params {width:int}            pass: page loads at that width with no horizontal scroll
- element_present  params {role, name}           pass: an element with that ARIA role and accessible name is visible (role one of button, link, heading, textbox, img, navigation, form, checkbox, combobox, main, banner, contentinfo)
- text_present     params {text}                 pass: visible text contains it
- form_submits     params {fields:string[]}      pass: the form is filled and submitted and the Proof-Pay inbox receives every listed field within 10s (field names like name, email, message, phone, subject)
- no_console_errors params {allowList:string[]}  pass: no console.error or page error (substrings in allowList are ignored)`;

export async function clarify(milestoneId: string, brief: string) {
  return runAI({
    milestoneId,
    task: "brief.clarify",
    schema: ClarifySchema,
    system:
      "You help a client turn a freelance website brief into measurable acceptance criteria. Find every vague or unmeasurable word or phrase (e.g. 'fast', 'mobile-friendly', 'working form', 'modern') and ask one short question per term that forces a measurable answer. Offer 2-4 concrete options where possible. Ask at most 6 questions. Do not ask about things that are already measurable.\n\n" + CATALOG_DOC,
    prompt: `Client brief:\n"""${brief}"""`,
    fallback: () => templateQuestions(brief),
  });
}

export async function propose(milestoneId: string, brief: string, answers: Record<string, string>) {
  return runAI<Proposal>({
    milestoneId,
    task: "brief.propose",
    schema: ProposalSchema,
    jsonSchema: proposalWireSchema,
    system:
      "Turn the client's brief and answers into a proposal both parties will sign. Automated checks must use ONLY the catalog types below with exactly the listed params. Anything that cannot be tested with the catalog becomes a manual criterion (if the client wants the right to reject on it) or an advisory note (informational, never blocks payment). Keep manual criteria few and concrete; they are the only grounds a client can reject on. Write descriptions in plain language for a non-technical client. Ids: checks c1..cN, manual m1..mN.\n\n" +
      CATALOG_DOC,
    prompt: `Brief:\n"""${brief}"""\n\nClient's answers to the clarifying questions:\n${Object.entries(answers).map(([t, a]) => `- ${t}: ${a}`).join("\n") || "(none)"}`,
    fallback: () => templateProposal(brief),
  });
}
