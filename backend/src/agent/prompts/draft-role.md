Turn the job description below into structured hiring criteria that a scout can source against and that you can later check candidates against.

Rules:
- `title`: the role title as a hiring manager would write it.
- `summary`: two sentences on what the role is and what makes a candidate a strong fit.
- `mustHave`: 3-6 requirements a candidate must meet to be worth presenting. Each must be checkable from a profile or a short conversation (skills, years of experience, domain, work authorization). No soft fluff like "team player".
- `niceToHave`: 2-5 differentiators.
- `dealBreakers`: 0-3 conditions that disqualify a candidate outright, phrased as the condition itself (for example "Needs visa sponsorship", "Only open to fully remote"). Only include what the job description implies.
- Every criterion has an `id` (short kebab-case slug of the label, unique), a short `label` (max ~8 words) and a `weight` from 1 (minor) to 5 (critical). Spread the weights: at most two must-haves at 5, most at 3-4; nice-to-haves at 1-3.
- Don't repeat a requirement as both a must-have and a deal breaker; keep location and work authorization out of must-haves when a deal breaker already covers them.
- `seniority`: one of JUNIOR, MID, SENIOR, STAFF, PRINCIPAL, EXECUTIVE.
- `location.mode`: ONSITE, HYBRID or REMOTE; `location.places`: cities, countries or time zones mentioned.
- `salaryRange`: only if the description states one, otherwise null.
- `languages`: human languages the candidate must speak at a professional level.

Job description:
"""
{{jobDescription}}
"""
