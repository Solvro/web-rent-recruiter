# Market rates for freelance recruiting tasks (sanity check of our prices)

Research date: 2026-10-03. FX used throughout (approximate): 1 USD ≈ 3.65 PLN, 1 EUR ≈ 1.16 USD, 1 GBP ≈ 1.33 USD.
Our recruiter nets ~81% of the client price (10% platform + 10% operator fee).

## Podsumowanie (PL)

- **Sourcing za $5 jest za tani.** Rekruter dostaje netto ~$4. Przy realnych 10–20 min na zakwalifikowanego, zainteresowanego kandydata daje to **~$12–24/h**. To dolna granica nawet dla juniora w Polsce (freelance B2B 60–90 zł/h netto ≈ $16–25/h). Dla Europy Zachodniej (DE ~€91/h) i USA (~$60/h) jest nie do przyjęcia. Jeśli płacimy dopiero po potwierdzeniu zainteresowania, a 30–50% profili odpada, efektywna stawka spada jeszcze bardziej. Samo znalezienie profilu jest dziś prawie darmowe (narzędzia AI: ~$10 za ~300 dopasowanych profili). Płacić trzeba więc za potwierdzone zainteresowanie i dopasowanie, a nie za link.
- **Rozmowa screeningowa za $35 / 30 min** daje netto $28,35. Po doliczeniu notatek i umawiania (~45–60 min) wychodzi **~$28–38/h**. Dla CEE to atrakcyjna stawka. Dla Europy Zachodniej i USA jest poniżej rynku, bo kontraktowy rekruter w USA bierze średnio ~$60/h. Wyjątek to osoby traktujące to jako dorabianie. Rozmów technicznych prowadzonych przez inżynierów ta cena nie pokrywa: Karat płaci interviewerom $100 za 60+30 min i bierze od firm $200–450.
- **Test językowy za $15 / 15 min** daje netto ~$12, czyli **~$30–36/h** przy 20–25 min pracy. Lektor w PL zarabia 50–125 zł/h, a tutor na italki/Preply $15–45/h, więc dla CEE stawka jest OK, a globalnie na granicy. Po stronie klienta automatyczne testy kosztują $15–20 (Versant, Emmersion), a EF SET jest darmowy. Cena jest więc konkurencyjna, ale nie mamy dużego pola do podwyżki. Proponuję ~$18–25 za ocenę na żywo przez native speakera.
- **Reference check za $25** daje netto ~$20. Przy 35–50 min (rozmowa, notatki, ganianie referenta) wychodzi **~$24–35/h**. Dla CEE to OK, globalnie za mało. Ceny dla klientów są zbliżone: telefoniczny reference check w UK kosztuje £24,99, weryfikacja zatrudnienia w Checkr od $12,50. Ryzyko: referenci odpowiadają w ~50% przypadków, a my płacimy tylko za „completed”. Warto dodać małą opłatę za udokumentowane próby kontaktu.
- **Rekomendacje** (cena dla klienta brutto, CEE → global):
  - sourcing $8–12 → $15–25 za zaakceptowany profil, ze skalowaniem za seniority i rzadkość;
  - screening $30–40 → $45–60;
  - język $12–18 → $18–25;
  - referencja $20–25 → $30–40.
- **Model:** cena bazowa × mnożnik seniority/rzadkości × mnożnik rynku. Sourcing rozbity na małą bazę za akceptację, bonus za potwierdzone zainteresowanie i bonus za przejście screeningu klienta (opcjonalnie bonus za zatrudnienie).
- **Niepewności:** brak publicznych cenników per profil u agencji sourcingowych. Stawki „per profile” to zwykle wyceny indywidualne. Część liczb pochodzi z agregatorów i blogów, a nie z oficjalnych cenników (oznaczone ⚠).

---

## 1. Benchmarks

### 1a. Freelance recruiter / sourcer hourly rates (what the supply side expects)

| Region | Rate | Source | Confidence |
|---|---|---|---|
| Poland, freelance recruiter, B2B | 60–80 PLN/h net (≈ $16–22/h); some ads 50–90 PLN/h | [RocketJobs: Flying Bisons](https://rocketjobs.pl/oferta-pracy/flying-bisons-freelance-recruiter-headhunter---design-tech-lodz-hr-recruitment), [RocketJobs: Intent](https://rocketjobs.pl/oferta-pracy/intent-tech-recruiter-freelance--warszawa-hr-recruitment-9e0cdcee) | Medium (real job ads, archived, undated) |
| Poland, recruiter B2B monthly | 9–16k PLN net/month; IT recruiters with a network up to 18k PLN plus 1–5k PLN per closed role | [pracuj.pl](https://www.pracuj.pl/praca/rekruter-freelancer-opole,oferta,1004942756), [freenance.io](https://freenance.io/zarobki/zarobki-w-hr-2026/) ⚠ | Medium |
| Poland, per-hire commission (blue-collar/volume) | 500–1,500 PLN per hired worker (≈ $140–410), often only after 14 days or 200 h of work | [pracuj.pl Niepołomice](https://www.pracuj.pl/praca/rekruter-rekruterka-freelancer-niepolomice,oferta,1004881038), [RocketJobs Eurokadra](https://rocketjobs.pl/oferta-pracy/eurokadra-s-a--rekruter-freelancer-krakow-hr-recruitment) | Medium |
| Poland, recruiting agencies (Clutch-style listings) | median ~$25/h; top firms $50–99/h | [GoodFirms Poland](https://www.goodfirms.co/business-services/recruiting/poland) ⚠ | Low–medium |
| Germany, freelance recruiter / talent sourcer | €720–760/day median, ≈ €91/h (≈ $105/h) | [FRATCH rate benchmark](https://fratch.io/en/role/recruiter/germany/rate-benchmark) | Medium (one platform's data) |
| UK, contract recruiter | £268/day umbrella (example ad) to £620/day median for "recruitment consultant" contracts (≈ £34–78/h) | [ITJobsWatch](https://www.itjobswatch.co.uk/contracts/uk/recruitment%20consultant.do), [ITJobsWatch ad](https://www.itjobswatch.co.uk/jv/eTeam-Workforce-Limited/Recruiter-Job-London-UK-51fmkj) | Low–medium (IT-skewed sample) |
| US, freelance/contract recruiter | avg ~$60/h, typical $30–85/h, top 10% ≥ $108/h | [contractrates.fyi](https://www.contractrates.fyi/Recruiter/hourly-rates), [BHSG ads $55–65/h](https://bhsg.com/jobs/job/a14281746dc-temp_1755631017-part-time-recruiter-55-hr-65-hr-dc-washington-district-of-columbia) | Medium |
| Upwork, recruiters (global) | $25–35 beginner, $35–50 intermediate, $50–75+ advanced; US-based $50–150 | [Upwork cost guide](https://www.upwork.com/hire/recruiting-assistants/cost/) | Medium (Upwork's own guide) |
| Outsourced sourcing services | $50–150/h, or $950–5,000 per role, or $3–10k/month retainer | [FullEnrich](https://fullenrich.com/content/candidate-sourcing-services) ⚠ | Low (vendor blog) |
| Language tutors (proxy for assessors) | italki community $3–15/h, pro $20–45/h; Preply $15–25/h typical. PL lektor 50–125 PLN/h (≈ $14–34) | [learnenglish.life italki](https://learnenglish.life/guides/how-much-does-italki-cost/), [Preply guide](https://learnenglish.life/guides/preply-cost-2026/), [Jooble PL](https://pl.jooble.org/praca-lektora-pl) ⚠ | Medium |

### 1b. Comparable productized services (what companies pay)

| Task | Service | Client price | Notes / source |
|---|---|---|---|
| Sourcing | Superstar Sourcing | $10 per search (~300 AI-matched profiles) + ~$1 per contact reveal | Raw profile discovery is commoditized. [superstarsourcing.com](https://superstarsourcing.com/cheap-sourcing-tool) |
| Sourcing | Fetcher | $379–849/month, capped at 500–2,000 candidates/yr (≈ $5–20 per sourced candidate) | [pin.com/blog/fetcher-pricing](https://pin.com/blog/fetcher-pricing/) ⚠ competitor blog |
| Sourcing | Pin / hireEZ | Pin from $100/mo; hireEZ $169–250+/user/mo | [Juicebox on hireEZ](https://www.juicebox.ai/blog/hireez-pricing) ⚠ |
| Sourcing | Inbound cost per application, Polish IT | ~122 PLN (≈ $33) per application (2022 data) | [RocketJobs/Traffit](https://rocketjobs.pl/blog/jak-skutecznie-rekrutowac-pracownikow-rocketjobs-justjoinit) |
| Sourcing | RPO / cost per hire | RPO $3–8k per hire; SHRM 2025 avg cost-per-hire $5,475 | [pin.com](https://ghost.pin.com/candidate-sourcing-companies/) ⚠ citing SHRM |
| Sourcing (PL) | "Selection and verification of candidates" | 4,800–7,500 PLN per position | [cenauslug.pl 2026](https://cenauslug.pl/przewodnik/rekrutacja-hr-i-employer-branding) ⚠ aggregator |
| Screening (tech) | Karat | $200–450 per interview (volume $250–350); pays Interview Engineers **$100 per 60-min interview + ≤30 min report** (≈ $67/h) | [HireInSouth](https://www.hireinsouth.com/post/karat-pricing) ⚠, [Karat job post](https://jobspresso.co/job/karat-io-anywhere-developer-interview-engineer/) |
| Screening (tech) | interviewing.io | $115–339 per expert session (candidate-paid); interviewers paid ~$50–200 | [Lodely](https://www.lodely.com/blog/interviewing-io-pricing), [Blind](https://www.teamblind.com/post/how-much-do-mock-interview-websites-pay-interviewers-ldtv5c30) ⚠ |
| Screening (tech) | BarRaiser | per-interview, not public | [barraiser.com](https://www.barraiser.com/interview-outsourcing/interview-as-a-service) |
| Screening (non-tech) | AI phone screeners (Talkpush, Hyring, VideoSDK, Recruit AI) | $1–5 per completed screen; one vendor estimates manual screens cost $18–24 | [Talkpush](https://blog.talkpush.com/the-1-interview-talkpush-launches-new-service-for-small-businesses), [Hyring](https://hyring.com/help-desk/ai-phone-screener/do-you-offer-volume-discounts-for-agencies-or-bulk-users-for-the-ai-phone-screener) ⚠. A human screen has to beat this on judgment. |
| Language | Versant (Pearson) | from ~$15 / £11 per test (automated) | [Versant store](https://gbp-versantstore.pearson.com/p/VERSPT-ESLT) |
| Language | Emmersion TrueNorth | ~$15–20 per test (automated speaking) | [Idaho Business Review](https://idahobusinessreview.com/?p=194796) ⚠ |
| Language | Tracktest | €17 core + €15 speaking & writing (human-rated, 48h); volume discounts 20+ | [tracktest.eu](https://tracktest.eu/english-test-price/) |
| Language | Pipplet (ETS) | from €30/test, human raters. **Discontinued Dec 20, 2025** | [GetApp](https://www.getapp.co.uk/software/2046087/pipplet), [Tracktest note](https://tracktest.eu/pipplet-shuts-down-why-schools-companies-should-consider-tracktest-as-the-ideal-alternative/) |
| Language | EF SET | free for companies (mainly reading/listening; check whether speaking is covered) | [ef.edu corporate](https://www.ef.edu/corporatelp/efset) |
| Language (PL) | Language audit per employee | 250–290 PLN (≈ $70–80) | [cenauslug.pl](https://cenauslug.pl/przewodnik/rekrutacja-hr-i-employer-branding) ⚠ |
| Reference | TCWGlobal (UK) | **£24.99 phone reference check** (≈ $33); £4.99 digital; £14.99 employment verification | [tcwglobal.com](https://www.tcwglobal.com/prescreening/menu/uk) |
| Reference | Checkr / Sterling | employment verification from $12.50 | [costbench](https://costbench.com/software/background-checks/checkr/alternatives/) ⚠ |
| Reference | Checkmate | from $17 per check (automated) | [SaaSworthy](https://www.saasworthy.com/product/checkmate-tech/pricing) |
| Reference | RefNow (UK) | £9.99 per candidate (up to 5 digital refs) | [GetApp](https://www.getapp.co.uk/software/128583/refnow) |
| Reference | Crosschq / Checkster / SkillSurvey / Xref | subscription, custom (Crosschq from ~$399/mo; Xref from $840/yr) | [SaaSworthy Crosschq](https://www.saasworthy.com/product/crosschq/pricing), [G2](https://www.g2.com/compare/hipeople-vs-xref-xref) |

### 1c. Typical time per task

| Task | Time | Source |
|---|---|---|
| Sourcing: qualified, interested passive candidate | 10–20 min each (brief). Outreach reply rates ~15–25% (avg 19.6%); 40–60% of sourced candidates pass first screen | [Ashby Talent Trends](https://www.ashbyhq.com/talent-trends-report/reports/candidate-sourcing), [SourceCon](https://www.sourcecon.com/4-key-metrics-most-sourcers-dont-track-but-should/), [SocialTalent](https://www.socialtalent.com/?p=93110) ⚠ |
| Screening call | 30 min call + 10–15 min notes + scheduling and no-shows ≈ 45–60 min | Karat budgets 60 + 30 min report for a technical interview ([Karat post](https://jobspresso.co/job/karat-io-anywhere-developer-interview-engineer/)) |
| Language check | 15 min call + ~5–10 min scoring/write-up ≈ 20–25 min | our estimate |
| Reference check | 10–20 min per call. 45–90 min of recruiter time per candidate. Only ~50% of references reached; 3–7 days elapsed | [HiPeople](https://hipeople.io/blog/how-long-does-a-reference-check-take), [SHRM](https://shrm.org/topics-tools/news/talent-acquisition/automation-can-help-ease-pain-reference-checking) |

## 2. Our prices: implied hourly rate and acceptability

Net = 81% of price. "OK" means a competent freelancer in that region would plausibly take the work steadily. "Side gig" means only juniors or people filling idle time would.

| Task | Our price → net | Assumed time per paid unit | Implied net $/h | PL/CEE (needs ≈ $16–30/h) | W. Europe (≈ $45–105/h) | US (≈ $30–85/h, avg $60) |
|---|---|---|---|---|---|---|
| Sourcing | $5 → $4.05 | 10–20 min; ×1.4–2 if 30–50% of submissions are rejected | **$6–24/h** | Borderline at best, junior only. **No** if unpaid rejections are common | **No** | **No** |
| Screening call (30 min) | $35 → $28.35 | 45–60 min | **$28–38/h** | **OK, attractive** | Side gig / no | Side gig (below the $60 avg) |
| Language check (15 min) | $15 → $12.15 | 20–25 min | **$29–36/h** | **OK** (above lektor rates) | Marginal (native tutors earn $20–45/h) | Marginal |
| Reference check | $25 → $20.25 | 35–50 min incl. chasing (more if references don't answer) | **$24–35/h** | **OK** | Side gig / no | Side gig / no |

Client-side check: screening, language and reference prices sit at or below the market for productized services (Karat $200+, Tracktest €32 with speaking, TCWGlobal £24.99 per phone reference). Clients have room to pay more for those three. Sourcing is the only price that is clearly wrong, and it is wrong for the supply side.

## 3. Recommendations

### Price ranges (client price; recruiter nets ~81%)

| Task | (1) CEE supply: min / target | (2) Global supply: min / target | Notes |
|---|---|---|---|
| Sourcing (accepted profile + fit note, standard mid-level role) | **$8 / $12** | **$15 / $25** | Senior or rare: ×1.5–2.5 (e.g. $20–30 CEE, $40–60 global). Even $25 is cheap next to $33 per inbound IT application in PL, or $3–8k RPO cost per hire. |
| Screening call (30 min, scripted) | **$30 / $40** | **$45 / $60** | Technical screen run by an engineer: $100–150 (Karat pays $100 and charges $200–450). Must clearly beat $1–5 AI screens on judgment and notes. |
| Language check (15 min, CEFR) | **$12 / $15–18** | **$18 / $25** | Clients' anchor is $15–30 per automated or semi-automated test. Charge extra for rarer languages (DE/FR/Nordic) and native assessors. |
| Reference check (per completed reference) | **$20 / $25** | **$30 / $40** | Consider pricing per candidate (2 references): $45–55 CEE, $70–90 global. Add a ~$5 attempt fee after 3 documented failed contact attempts. |

### Is $5 sourcing too low?

Yes. At 10–20 min per qualified, interested candidate, $4.05 net works out to $12–24/h before rejections, and $6–17/h once 30–50% of submissions are rejected. Junior Polish freelancers ask 60–80 PLN/h (≈ $16–22). Experienced tech sourcers in DE ask ~€91/h, and US contract recruiters ask ~$60/h. At $5 we will mostly attract low-effort profile dumping, which AI tools already do for ~$0.03 per profile ($10 per 300). The human value is the fit judgment plus confirmed interest, so that is what the price should pay for.

### Pricing model suggestion

1. **Price = base × seniority/rarity × market.**
   - Seniority/rarity multiplier: junior 1.0, mid 1.3, senior 1.7, niche/exec 2.5.
   - Market multiplier is set by the candidate market and language rather than the recruiter's location: CEE 1.0, W. Europe 1.6–1.8, US 1.8–2.2. Recruiters in cheaper regions then earn a premium for covering expensive markets, which is a recruitment lever for supply.
2. **Split sourcing into milestones** (example, CEE mid-level):
   - $4 when the client accepts the profile;
   - +$8 when the candidate confirms interest;
   - +$15–25 when the candidate passes the client's first screen;
   - optional placement bonus of $250–1,000 (still far below 15–25% agency contingency fees ⚠ general market knowledge, not sourced here).

   Total for a good candidate: ~$12 at interest, more if they progress. This keeps the cost of junk low for clients and rewards quality.
3. **Quality guards:**
   - per-recruiter acceptance-rate floor (e.g. ≥60%) to stay on a role;
   - claw back or withhold bonuses for duplicates and candidates who were not actually interested;
   - cap unpaid rejected work by requiring client feedback within N days, with auto-accept otherwise.
4. **Unit and fee hygiene:**
   - Keep screening, language and reference checks as flat per-task prices, varied by language and seniority.
   - Pay reference checks per candidate rather than per reference, so recruiters aren't punished when a reference doesn't answer.
   - Check the 19% combined take: Upwork-style platforms take ~10–15% from freelancers, italki 21%, Preply 18–33%. Ours is in range but at the high end for professional services.

## Caveats

- No sourcing agency publishes a per-profile price. "Per profile" deals are quoted per engagement, so the per-unit numbers for Fetcher and similar tools are derived (subscription ÷ cap).
- Items marked ⚠ come from vendor blogs, competitors or aggregators, not official price lists.
- Polish freelance-recruiter rates come from a handful of job ads (archived, undated). Senior tech-sourcer B2B rates in PL (plausibly 100–150 PLN/h) are not verified.
- UK day rates from ITJobsWatch are IT-skewed. The DE figures come from a single platform (FRATCH).
- Time-per-task figures for sourcing and the language check are estimates. Measure them on the platform: median minutes per accepted unit, and acceptance rate per task type.
