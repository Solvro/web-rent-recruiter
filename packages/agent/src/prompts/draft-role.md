Turn the job description below into structured hiring criteria that a recruiter can source against and that you can later check candidates against. Everything must come from THIS posting; never add requirements, skills or a company it doesn't mention.

Rules:
- `title`: the role title only, as the posting states it (not the company, not the location). "Insider One - Customer Success Manager (Warsaw, Poland)" → "Customer Success Manager".
- `company`: the hiring company's name as the posting states it, or null if it doesn't say.
- `summary`: two sentences on what the role is and what makes a candidate a strong fit.
- `mustHave`: the requirements from the posting's requirements section ("Requirements", "What you'll bring", "What we're looking for", "You have", …). Never build must-haves from the duties ("What you'll do", "Responsibilities"). Keep every explicitly listed requirement bullet: hard, checkable ones (skills, years, domain, tools, work authorization) as must-haves; soft ones (communication, motivation, attitude) as nice-to-haves with a short checkable label (e.g. "Clear written and spoken communication"). Language requirements go to `languages`, not to criteria. Use at most 7 must-haves; the rest become nice-to-haves.
- `niceToHave`: the posting's "nice to have / preferred / bonus" items, plus the soft or extra requirements above.
- `dealBreakers`: 0-3 conditions that disqualify a candidate outright, phrased as the condition itself (for example "Needs visa sponsorship", "Only open to fully remote"). Only what the posting states or clearly implies.
- Every criterion has an `id` (short kebab-case slug of the label, unique), a short `label` (max ~10 words, in the posting's own terms) and a `weight` from 1 (minor) to 5 (critical). At most two must-haves at 5, most at 3-4; nice-to-haves at 1-3.
- Don't repeat a requirement as both a must-have and a deal breaker; keep location and work authorization out of must-haves when a deal breaker already covers them.
- `seniority`: one of JUNIOR, MID, SENIOR, STAFF, PRINCIPAL, EXECUTIVE. Judge it from the title and the required years, as whole words ("international" is not "intern"; "lead design reviews" in the duties doesn't make the role a lead).
- `location.mode`: ONSITE, HYBRID or REMOTE; `location.places`: cities, countries or time zones mentioned.
- `salaryRange`: only if the description states one, otherwise null.
- `languages`: every human language the posting requires at a working level, with a CEFR level when it says how well: "Fluent Polish and English" → ["Polish (C1)", "English"]. Put the non-English language first. Languages that are only "an advantage" are left out. If the posting names none, ["English"].

Job description:
{{jobDescription}}
