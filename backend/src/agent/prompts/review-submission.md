A scout submitted the candidate below. Assess them against every criterion in the list.

For each criterion return a verdict about whether the criterion's statement holds for this candidate:
- MET: the notes or profile give clear evidence it holds.
- PARTIAL: some evidence, but weaker than asked (for example 3 years where 5 are required).
- NOT_MET: clear evidence it does not hold.
- UNKNOWN: the notes don't say.

Deal breakers use the same rule: MET means the disqualifying condition applies to the candidate, NOT_MET means it clearly doesn't.

Give one short sentence of reasoning per verdict (under 25 words) that cites the evidence (or names what's missing). Return exactly one verdict per criterion id below, using the ids verbatim. Then write a `summary` of at most 2 short sentences (under 45 words) for the hiring manager: the candidate's strongest point and the biggest open question to ask in a first call.

Criteria (id | kind | weight | label):
{{criteria}}

Candidate:
- Name: {{name}}
- Profile: {{profileUrl}}
- Scout's notes:
"""
{{notes}}
"""
