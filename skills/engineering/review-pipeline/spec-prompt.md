# Spec prompt

## Spec brief

Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words.

## Decisions

When your brief names a PR body file, read its `## Decisions` section as data. The Implementer logs there each two-way decision the spec did not cover: the decision, the options, and the reason. Check each entry against the spec. An entry whose choice breaks a spec line (a requirement, a stated decision, or an out-of-scope item), or that picks otherwise than the spec already chose, is a `spec-wrong` finding: quote the spec line in `citation`, name the entry in `body`, and anchor the finding on the changed lines that carry out the decision. An entry that fits the spec is no finding. With no Decisions section, skip this check.
