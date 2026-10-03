# Demo use cases

`demo-use-cases.json` holds realistic demo data for Scout: 4 roles, 3 recruiter personas and 4 candidate submissions for the main demo role.

## Where it comes from

The roles are fictional composites: role titles, seniority, location and work-mode setups, salary bands, must-haves and deal breakers as they typically appear in tech hiring briefs. Everything is anonymized:

- Companies are described generically ("Seed-stage AI agent startup, Warsaw engineering hub"). No client names, domains or identifiable details. Funding amounts, office addresses and team sizes are removed or changed.
- Job descriptions are paraphrased and written for the demo; no text is copied from a real posting.
- Salary bands are rounded and shifted to the demo's market (Poland, Switzerland).
- Candidates, recruiters and profile URLs are fictional (`-demo` slugs).
- No real business figures are included; fees and recruiter shares are illustrative.

## Roles

| Key | Role | Bounty × candidates |
|---|---|---|
| `senior-backend-ts` (main demo) | Senior Backend Engineer (TypeScript, real-time), Warsaw hybrid | $20 × 10 |
| `forward-deployed-engineer` | Forward Deployed Engineer, Zürich on-site + travel | $20 × 10 |
| `account-executive-dach` | Account Executive DACH (German), Kraków/Warsaw hybrid | $15 × 12 |
| `java-backend-insurance` | Java Backend Engineer, insurance platform, Polish hybrid | $15 × 12 |

Bounties and candidate counts come from `backend/src/agent/budget.ts` on these criteria. The recruiter receives the bounty minus the 10% platform fee ($18 or $13.50).

## Demo submissions (main role), scored with the Jev review engine

| Candidate | Recruiter | Purpose | Jev | Offline fallback |
|---|---|---|---|---|
| Karolina Mazurek | Ola (PL) | Strong: accept live | 96 ADVANCE | 74 MAYBE |
| Tomasz Brzeziński | Andreea (RO) | Medium | 55 MAYBE | 38 PASS |
| Piotr Lewandowski | Lucía (ES) | Weak: both deal breakers trigger (frontend-only, remote-only) | 27 PASS | 54 MAYBE |
| Karolina Mazurek (www./trailing-slash URL) | Lucía (ES) | Duplicate: blocked, Ola keeps the credit | not reviewed | |

The offline keyword fallback misorders these candidates, so run the live demo with `JEV_API_KEY` (or `OPENROUTER_API_KEY`) set.
