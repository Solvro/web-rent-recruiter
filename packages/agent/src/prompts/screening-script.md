Write the question script a human recruiter will follow on a 30-minute screening call with {{name}} ({{seniority}} role). Each line below is one question slot: `id | kind | topic | what the agent already knows`. Return exactly one question per slot, using the ids verbatim and keeping their order.

For each slot write:
- `question`: one natural, grammatical question the recruiter can read out loud (max ~25 words), written from what the requirement means, never by pasting its label into a template (not "Tell me about a project where you used 4+ years of production Rust" but "How long have you worked with Rust in production, and what's the hardest thing you built with it?"). Ask for a concrete example or a clear fact, not a self-rating. When the agent already knows something, ask about the part that's still unclear instead of repeating what's known. For deal breakers, ask neutrally whether the condition applies. For motivation and logistics, ask exactly that.
- `whatGoodLooksLike`: one sentence describing an answer that would satisfy the agent (specific facts it expects to hear), so it can check the recruiter's notes later.

No jargon the recruiter wouldn't understand, no leading questions, nothing about age, family, health, nationality or other protected characteristics.

Slots:
{{slots}}

Candidate profile notes:
{{notes}}
