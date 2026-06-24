/**
 * prompts — reasoning scaffolds & knowledge-boundary templates (C11).
 *
 * Domain-independent guardrails: knowledge boundary ("answer ONLY from retrieved
 * texts"), citation contract, and an IRAC / Chain-of-Logic decomposition. Shipped
 * as parameterized templates with `{...}` slots filled by the helpers. Stdlib only.
 */

export const GROUNDED_ANSWER = `You are answering a question using ONLY the retrieved context below. Follow these
rules strictly:

1. Base every claim on the retrieved context. Do not use outside knowledge.
2. If the context does not contain the answer, say so plainly — do not guess.
3. Cite the source of each claim inline as [source] using the result's source/url.
4. Distinguish (a) direct quotes from a source, (b) paraphrase of a source, and
   (c) your own reasoning over the sources.
5. Mark any statement you cannot ground in the context as [UNVERIFIED].

Question:
{question}

Retrieved context:
{context}

Answer (grounded, cited):`

export const DECOMPOSE = `Break the task into a verifiable chain before answering. Do not skip steps.

1. Restate the task and list the facts/inputs you actually have.
2. Decompose it into the minimal sub-questions that must each be true.
3. For each sub-question, note what evidence would settle it and retrieve it.
4. Evaluate each sub-question against the evidence (true / false / unknown).
5. Recompose the sub-answers into the final result, carrying any "unknown"
   forward as an explicit caveat rather than resolving it by assumption.

Task:
{task}

Work through the steps, then give the conclusion.`

export const CITATION_CONTRACT = `Citation contract for this response:

- Every factual claim must carry an inline citation to a retrieved source.
- A citation must point to a source that actually supports the claim; do not
  attach a source after the fact to a claim generated from memory.
- Quote exact wording when the precise text matters (definitions, figures, rules).
- If you cannot cite a claim, either remove it or flag it [UNVERIFIED].
- List all cited sources at the end.`

/** Fill `{name}` slots in `tmpl` from `vars` (unreferenced slots stay literal). */
function fill (tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in vars ? vars[key] : m,
  )
}

export function groundedAnswer (question: string, context = ''): string {
  return fill(GROUNDED_ANSWER, {
    question: question.trim(),
    context:  context.trim() || '(none provided)',
  })
}

export function decompose (task: string): string {
  return fill(DECOMPOSE, { task: task.trim() })
}

export function citationContract (): string {
  return CITATION_CONTRACT
}

const TEMPLATES: Record<string, (vars: Record<string, string>) => string> = {
  grounded_answer:   v => groundedAnswer(v.question ?? '', v.context ?? ''),
  decompose:         v => decompose(v.task ?? ''),
  citation_contract: () => citationContract(),
}

/** Return the named scaffold with optional `{slot}` substitution. */
export function getPrompt (name: string, vars: Record<string, string> = {}): string {
  const fn = TEMPLATES[name]
  if (!fn)
    throw new Error(
      `unknown prompt '${name}'; have ${Object.keys(TEMPLATES).join(', ')}`,
    )
  return fn(vars)
}
