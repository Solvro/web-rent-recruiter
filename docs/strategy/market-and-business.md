# Market and business

All numbers marked **(est.)** are our estimates, with assumptions written out. Everything else is sourced.

## The market

| What | Number | Source |
|---|---|---|
| Global recruitment and staffing | **~$750bn** (2025) | [Dataintelo via search summary](https://dataintelo.com/report/recruitment-staffing-market); IBISWorld puts global HR and recruitment services at $764bn in 2026 ([IBISWorld](https://www.ibisworld.com/global/market-size/global-hr-recruitment-services/2050/)) |
| Share that is permanent placement and search | **~11%** of global staffing revenue | Staffing Industry Analysts (place & search vs temporary split; SIA research, via search summary) |
| → spent on placement and search fees | **~$80bn / year** (est., 11% × ~$750bn) | derived |
| US direct-hire market | **$11bn** (2025) | SIA, largest direct-hire firms ([Beacon Hill / SIA](https://bhsg.com/news/beacon-hill-earns-11th-recognition-among-the-largest-direct-hire-firms-in-the-us)) |
| US hires per year | **63.0m** (2025) | [BLS JOLTS](https://www.bls.gov/news.release/archives/jolts_03132026.htm) |
| AI in recruitment | **$8.2bn → $15.2bn** (2025 → 2030, 25% CAGR) | Grand View Research via [Pin](https://www.pin.com/blog/ai-in-recruitment-market/) |
| Typical agency fee | **15–25%** of first-year salary | industry benchmarks |
| Comparable marketplace | Paraform: **$65m raised**, 10 000+ independent recruiters, 1 000+ companies; pays recruiters in thirds at 30/60/90 days | [Pulse 2.0](https://pulse2.com/paraform-65-million-raised-for-agentic-hiring-platform-expanding-ai-driven-recruiting/amp/); payout schedule from Paraform's "Getting paid on Paraform" help page |
| "AI hires humans" demand signal | RentAHuman (YC 2026): 160 000+ humans signed up, crypto payouts | [Analytics Vidhya](https://www.analyticsvidhya.com/blog/2026/02/ai-hiring-humans/), [HackerNoon](https://hackernoon.com/lite/ai-agents-are-now-hiring-humans-rentahuman-and-the-inversion-of-work) |

### Task-level TAM (est.)

Scout sells **tasks**, not placements, so we size the market bottom-up with the prices the agent actually charges (`GIG_PRICES` in `backend/src/agent/gigs/market.ts`, CEE base prices, senior level; Western markets are 1.7–2× higher):

| Task | Price | Per hire (est.) | Spend per hire |
|---|---|---|---|
| Sourcing, per profile the candidate confirms ($12 × senior tier 1.7) | $20 | 10 | $200 |
| Screening call (30 min, agent's script, recorded) | $40 | 5 | $200 |
| Language check (15 min, when the role needs one) | $15 | 1 | $15 |
| Reference check | $25 | 2 | $50 |
| **Human task spend per hire** | | | **~$465** |

- **Professional hires per year, global: ~50m (est.).** That is 20% of 63m US hires (12.6m) treated as skilled or professional roles that involve a recruiter screen, with the US taken as ~25% of global professional hiring.
- 5 screens per hire is consistent with Gem's 8% pass rate at the first screen ([Gem 2025](https://lp.gem.com/rs/972-IVV-330/images/2025%20Recruiting%20Benchmarks%20-%20Gem.pdf?version=0)). Prices sit at freelance recruiter rates of $25–75/h ([Upwork](https://www.upwork.com/hire/recruiting-assistants/cost/)) at CEE levels (`docs/research/market-rates.md`).
- **TAM ≈ 50m × $465 ≈ $23bn per year** in task-level recruiting work (est.), under a third of what is paid in placement fees today.
- **SAM ≈ $0.9bn (est.).** About 2m hires a year in tech and professional roles in the US and EU that already use agencies or outsourced recruiters (US direct hire is $11bn at ~$20k per placement ≈ 550k placements; the EU is assumed similar; plus startups and scale-ups that outsource tasks), × $465.

## Why global from day one is the moat

- **Today's payment rails stop at borders.** Stripe Connect's self-serve cross-border payouts only work between the US, UK, EEA, Canada and Switzerland ([Stripe docs](https://docs.stripe.com/connect/cross-border-payouts)). Recruiter networks don't stop there: freelance recruiters work from everywhere.
- **Stablecoin payouts settle in seconds, anywhere, at a fraction of a cent.** That is what makes a *$15–40 task* economically payable to someone in Lagos, Bogotá or Bucharest.
- **The supply side is already doing the work on spec.** Freelance screeners are typically paid only through the promise of a success fee on a hire (our hypothesis from our recruiting-agency design partner; numbers shared live). Scout pays for that work per accepted call.
- **And the rest of the supply is paid late.** Marketplaces like Paraform pay recruiters in instalments up to 90 days after the start date; agencies waited 56 days on average for invoices in the UK (EMW, 2015).

## Business model

| Stream | How | When |
|---|---|---|
| **Task fee** | 10% of every accepted task (`Config.fee_bps`, snapshotted per role, enforced on-chain by `math::split`) | Live |
| **Protocol fee for operators** | 2–3% when a third-party operator brings demand or supply through the protocol | Phase 3 |
| **Operators set their own margin** | e.g. a "screening academy" trains and certifies recruiters and adds its own 5–10% on top. Better quality earns a higher price, franchise-style | Phase 3 |
| **Verified recruiter** | ~$19/month for priority routing and verified badges | Phase 2 |
| **Hire bonus routing (optional hybrid)** | Screeners want steady income, not a lottery: per-task pay is the default. A company can add an optional bonus from the same vault on a signed offer (ATS webhook); the usual fee applies | Phase 2 |

### Unit economics (est.)

Every accepted gig is split on-chain by `math::split` (`programs/scout/src/math.rs`): 10% platform fee, then 10% to the operator if the recruiter is vouched, then 30% of the recruiter's share is held back until the candidate reaches the company. Every percentage is floored; the rounding dust goes to the recruiter.

**Per hire** (task stack above, vouched recruiters):

| | Agency today | Scout task stack |
|---|---|---|
| Company pays | ~$20 000 (20% of $100k) | ~$465 in tasks + its own interviews |
| Recruiters receive | a split, after 30–90+ days | ~$377 (≈70% at acceptance, ≈30% when the candidate reaches the interview) |
| Operators receive | n/a | ~$42 |
| Scout revenue | n/a | ~$46 (10%) |

**Per gig, our cost side:**

| Cost | Amount | Notes |
|---|---|---|
| On-chain rent per Submission account | ≈0.0023 SOL ≈ $0.35 at $150/SOL | paid by our relayer; reclaimed when a deliverable is rejected (`rent_payer`, v3.3); kept for accepted ones (duplicate protection and reputation) |
| Transaction fees | ~0.000005–0.00002 SOL per tx | negligible |
| AI per review | ~$0.001 (Jev) + ~$0.0005 (cheap LLM summary) | agent planning ~$0.003 per role |
| Margin, sourcing gig ($20–25) | fee $2.00–2.50 − rent $0.35 − AI ≈ **$1.65–2.15** | positive, but most of the value is downstream |
| Margin, screening gig ($40) | fee $4.00 − rent $0.35 − AI ≈ **$3.65** | the margin is in calls |
| Margin, tech screen ($100) | fee $10.00 − rent $0.35 ≈ **$9.65** | premium gig run by an engineer |

**For an agency:** whether outsourced screening is cheaper depends on screens per hire (at a $15k success fee and a 10% screener share, per-call pay at $40 breaks even around 37 screens per hire). The solid gains are instant payout to screeners, no invoicing, a global pool and fewer cancelled calls.

## Projection (est., bottom-up from one agency)

Built from an assumed mid-size agency running ~900 screens a month (assumption) and the price sheet above. Per screen we assume 2 accepted sourced profiles; references at 2 per hire with 40 screens per hire (assumption).

| | Year 1 (2027) | Year 2 (2028) | Year 3 (2029) |
|---|---|---|---|
| Who | Design-partner agency | Design partner ×3 + 20 agencies (~200 screens/month each) | 100 agencies and operators (~500 screens/month each) |
| Screening calls (@ $40) | 10 800 | 80 000 | 600 000 |
| Sourced profiles (@ $20) | 21 600 | 160 000 | 1 200 000 |
| Reference checks (@ $25) | 540 | 4 000 | 30 000 |
| **GMV** | **≈ $0.88m** | **≈ $6.5m** | **≈ $48.8m** |
| Blended take rate | 10% | 10% | 8% (operator-originated tasks pay less) |
| **Revenue** | **≈ $88k** | **≈ $0.65m** | **≈ $3.9m** |
| Share of task TAM | <0.01% | 0.03% | 0.2% |

The ceiling, not a plan: at 0.5% of the task-level market the protocol would move ~$116m a year. Optional verified-recruiter subscriptions are not counted.

## Go-to-market

1. **Phase 1: our recruiting-agency design partner (2027).** The agency screens every candidate before a client sees them, and its freelance network already runs those calls on spec. No LOI yet; the pilot converts existing on-spec work into paid tasks rather than recruiting new supply. The agent posts the screens as `SCREENING_CALL` tasks to that network, paid on acceptance, which proves quality, unit economics and the reputation loop on real volume.
2. **Phase 2: other agencies and ATS (2028).** The same task API goes to boutique agencies and in-house TA teams, delivered through ATS integrations (Ashby, Greenhouse, Workable webhooks) and an **MCP server**, so any AI recruiting agent can post tasks.
3. **Phase 3: open protocol with operators (2029).** Anyone can run a front-end or a recruiter guild on top of the shared vaults, reputation and payouts. That might be a better UI for recruiters, a screening academy, or a niche network for healthcare or legal. Operators earn their own margin and we earn the protocol fee. It is franchising for recruiting, with the rules enforced by the program instead of contracts.

## Risks we name ourselves

- **Quality of freelance work.** This is the make-or-break risk. Answer: per-task-type on-chain reputation, holdbacks for new recruiters, agent completeness checks, and client ratings. It is a separate design document.
- **Regulation.** Stablecoin payouts in the EU fall under MiCA, and companies paying by card need a licensed on-ramp. We don't custody funds, but we need legal review per market.
- **Demand concentration.** Year 1 depends on one design partner. Mitigation: pilot agencies in parallel.
- **Fraud and collusion** between a company and its own recruiters, or fake candidates. Answer: candidate confirmation links (in progress), sourcer ≠ screener and bonds for unvouched recruiters (program v3.1), duplicate-candidate hashing (live), minimum bounties so reputation can't be minted for free (v3.2, in progress). See `docs/jury-qa.md`.
