# Legal position (one page)

> **Not legal advice.** This is our team's understanding, written to show we've thought about it. Before production, every point needs review by counsel in each market.

## EU AI Act

- **Classification.** Two uses fall into Annex III point 4 (employment), so they are **high-risk**:
  - evaluating and filtering candidates (4a);
  - allocating tasks to recruiters and evaluating their work (4b).
- **How we position it today:**
  - The agent supports decisions about candidates. It does not hire or reject people from jobs.
  - The company makes the hiring decisions: who gets invited to an interview and who is hired.
  - Profiles the agent filters out stay visible to the company, together with the reason.
  - Every agent decision is logged with its inputs and reasons, in the agent activity log and as on-chain events.
  - The score is computed by code from per-criterion verdicts with quoted evidence, so it can be explained and audited.
- **What is not covered yet:** the agent does accept and reject recruiters' *deliverables* automatically, which decides their pay. Today the mitigations are:
  - published acceptance rules;
  - a reason on every rejection;
  - an escalation path to the company;
  - the on-chain review window.
- **Before production:**
  - a risk-management system;
  - data-governance documentation for the scoring;
  - human oversight procedures;
  - transparency notices to candidates and recruiters;
  - accuracy and bias monitoring;
  - conformity assessment and registration.

## GDPR

- **Data minimisation.** On-chain we store only salted hashes (candidate and evidence hashes), amounts and counters. Names, profiles, notes and transcripts stay off-chain in our database, so they can be deleted on request. The per-role salt is off-chain, which makes the on-chain hashes hard to link to a person. Hashes are still pseudonymous data and are treated as such.
- **Lawful basis.** For sourcing, legitimate interest. The candidate then confirms through a one-click link before anything moves forward or gets paid. Consent and confirmation come from the candidate's link; the client no longer asserts consent. Screening calls are recorded only with the candidate's consent at the start of the call.
- **Processors:**
  - OpenRouter / Jev for scoring;
  - Recall.ai (EU Frankfurt region) for call recordings;
  - our hosting.

  Each needs a DPA and transfer safeguards where data leaves the EU.
- **Retention:** transcripts and notes are kept for the life of the role plus a short retention period. Recordings are not kept after transcription. This is to be fixed in a retention policy.
- **Endpoints that could leak whether someone is a candidate** (the duplicate check, shortlists) require an authenticated session and role ownership (done).

## Platform work

- **Platform Work Directive (EU).** Automated monitoring and decision-making over people who work through a platform requires transparency, human review of significant decisions and a way to contest them. Rejections carry reasons and can be escalated; recruiters can appeal rejections to the company (live).
- **DAC7.** A platform facilitating paid personal services must collect seller identity details and report their income annually. Operators (recruiter schools and agencies) can do KYC for the recruiters they vouch for. Unvouched recruiters will need KYC above the DAC7 thresholds.

## Money transmission and MiCA

- **The non-custodial argument:**
  - The budget is held by a program-owned vault, not by us.
  - The company signs the role, the deposit and the agent's spending caps (v3.2).
  - The company can revoke or replace the agent (`set_agent`, v3.2).
  - Payouts follow fixed on-chain rules (`math::split`).
  - Our relayer only pays network fees and cannot move funds.
- **Its limits:**
  - We operate the agent that decides payouts within those caps.
  - Today we also hold the upgrade authority.
  - Regulators may see that as control over client funds.
  - Mitigations: company-signed caps, a multisig upgrade authority (roadmap), and per-role agent keys (roadmap).
- **Stablecoins.** In the EU we would use a MiCA-compliant e-money token (for example USDC issued under an EU EMI licence). Card on-ramps go through licensed partners.

## Status

Program v3.3 and the backend items above are live on devnet. Appeals are live (an overturn pays the recruiter directly). Self-hosted agents (`scout-agent`) are live too. The rest is roadmap (`docs/jury-qa.md`).
