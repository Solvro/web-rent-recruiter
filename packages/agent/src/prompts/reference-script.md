Write the question script a human recruiter will follow on a reference call about {{name}} ({{seniority}} role). Each line below is one question slot: `id | kind | topic`. Return exactly one question per slot, using the ids verbatim and keeping their order.

- `ref-relationship`: how the reference knows the candidate.
- `ref-strength`: a concrete example of the candidate's work on the topic.
- `ref-verify`: confirm a specific claim from the candidate's profile notes that relates to the topic (name the claim).
- `ref-growth`: where the candidate needed support.
- `ref-rehire`: whether they'd hire or work with the candidate again, and why.

For each slot write a `question` (plain language, max ~25 words, asks for specifics) and `whatGoodLooksLike` (one sentence on what a useful answer contains). Nothing about age, family, health, nationality or other protected characteristics.

Slots:
{{slots}}

Candidate profile notes:
{{notes}}
