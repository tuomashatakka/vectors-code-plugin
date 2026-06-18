#!/usr/bin/env python3
"""
prompts — reasoning scaffolds & knowledge-boundary templates (C11).

The legal document's system prompt enforced layers — role, knowledge boundary
("base analysis ONLY on retrieved texts, never fabricate references"), citation
contract, structured output — and an IRAC / Chain-of-Logic decomposition. Those
are domain-independent scaffolds: any agent pairing a model with this retrieval
benefits from the same guardrails. This module ships them as parameterized
templates, exposed as MCP Prompts and a CLI command.

Stdlib only. Templates are plain strings with `{...}` slots filled by the helpers.
"""

from __future__ import annotations

GROUNDED_ANSWER = """\
You are answering a question using ONLY the retrieved context below. Follow these
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

Answer (grounded, cited):"""

DECOMPOSE = """\
Break the task into a verifiable chain before answering. Do not skip steps.

1. Restate the task and list the facts/inputs you actually have.
2. Decompose it into the minimal sub-questions that must each be true.
3. For each sub-question, note what evidence would settle it and retrieve it.
4. Evaluate each sub-question against the evidence (true / false / unknown).
5. Recompose the sub-answers into the final result, carrying any "unknown"
   forward as an explicit caveat rather than resolving it by assumption.

Task:
{task}

Work through the steps, then give the conclusion."""

CITATION_CONTRACT = """\
Citation contract for this response:

- Every factual claim must carry an inline citation to a retrieved source.
- A citation must point to a source that actually supports the claim; do not
  attach a source after the fact to a claim generated from memory.
- Quote exact wording when the precise text matters (definitions, figures, rules).
- If you cannot cite a claim, either remove it or flag it [UNVERIFIED].
- List all cited sources at the end."""


def grounded_answer(question: str, context: str = "") -> str:
    return GROUNDED_ANSWER.format(question=question.strip(),
                                  context=(context.strip() or "(none provided)"))


def decompose(task: str) -> str:
    return DECOMPOSE.format(task=task.strip())


def citation_contract() -> str:
    return CITATION_CONTRACT


TEMPLATES = {
    "grounded_answer": grounded_answer,
    "decompose": decompose,
    "citation_contract": citation_contract,
}


def render(name: str, **kwargs) -> str:
    fn = TEMPLATES.get(name)
    if not fn:
        raise KeyError(f"unknown prompt {name!r}; have {', '.join(TEMPLATES)}")
    return fn(**kwargs)
