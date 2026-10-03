# Competition and design research

Research date: 2026-10-03. Sources are listed at the end of each section.

## 1. Competition

| Product | Who pays | How and when recruiters are paid | Fee / take rate | Recruiter UX |
|---|---|---|---|---|
| **Paraform** (recruiter marketplace) | The company pays a contingency fee of about 20–25% of first-year salary, only on hire. | Through Stripe, in 3 instalments of 1/3 at 30, 60 and 90 days after the start date. If the candidate leaves, the remaining instalments are lost. "Premier" recruiters get paid at 30 days. | The recruiter keeps about 70% of the fee (agencies typically pay 50%). | Recruiters pick roles from a marketplace and submit candidates. The payout is a long, conditional schedule. |
| **Hunt Club** (expert network) | The company pays 20% of first-year OTE, or 25% for executives. | Referrers earn $4k–20k per placement and $100–300 per interview. | Contingency, at the high end of the market. | Referral-based: "refer someone from your network". There is a small paid unit, the interview. |
| **BountyJobs** (agency bounty marketplace) | The employer posts a bounty (a % of salary or a fixed fee). | BountyJobs invoices the employer on the start date and pays the agency afterwards. The bounty is refunded if the hire leaves within 60–90 days. | The agency gets 75% and BountyJobs keeps 25%. | Invoice-driven, with weeks to months to cash. |
| **Wellfound** (startup jobs) | The company pays $250–1,000+ per seat per month, or Autopilot at $500 per role per month plus a 10% placement fee. | Not a recruiter-payout marketplace. A $200 referral bonus is paid on hire. | Subscription plus a placement fee. | Simple one-at-a-time applicant review (Accept / Reject). |
| **Upwork / Toptal** (freelance marketplaces) | Upwork: the client pays a 5% marketplace fee plus up to $9.95. Toptal: $79 a month, a $500 deposit, and an undisclosed markup. | Upwork escrow with milestone releases. Toptal freelancers pay no fee. | Upwork charges the freelancer 0–15%. | Escrow-backed "Payment verified" badges are the trust signal. |
| **Mercor** (AI talent network) | Companies pay Mercor. | Referrers earn a fixed $160–800 per hire, shown on each job card. Earnings come through Stripe. | Not public. | **Closest to us:** each job card shows the referral reward next to the role, plus a dedicated Earnings tab. |
| **AI sourcing tools** (Juicebox/PeopleGPT, Gem, hireEZ) | The company pays for seats: Juicebox $99–179 per seat per month, Gem about $130 a month, hireEZ about $494 a month. | Nobody is paid per outcome; they are tools, not marketplaces. | SaaS. | They find profiles but don't contact people or run first calls, which is the gap scouts fill. |

### Positioning: speed of payout × cost to the company

```
                    cost to company ↑ (high, % of salary)
                         │
   Hunt Club, BountyJobs │ Paraform (instalments 30/60/90 d)
   (paid after start,    │
    weeks–months)        │
  slow payout ───────────┼──────────────────────── fast payout →
                         │
   AI sourcing SaaS      │            ★ Scout
   (no recruiter payout) │  (pay per qualified candidate,
   Upwork (milestones)   │   paid seconds after "Accept")
                         │
                    cost to company ↓ (low, small fixed bounties)
```

Scout is alone in the "low cost, instant payout" corner. Incumbents pay large fees late. Tools are cheap but leave the human work undone.

### 3 things Scout must do better

1. **Show the money first.** Paraform and Mercor show the reward, but payment comes much later. Our card should say what you earn and when ("$18 · paid when accepted"), and then actually deliver in seconds.
2. **Make trust visible without crypto words.** Upwork's "Payment verified" and BountyJobs' refund guarantee are their trust signals. Ours: "Budget secured", "Auto-paid if no answer in 72h", and "First to submit keeps the credit".
3. **Keep the unit small and the flow tiny.** Competitors are built around 20% placements and long pipelines. Scout's whole loop should fit in 3 clicks for recruiters (find role → submit → get paid) and 3 for companies (paste JD → publish → accept).

Sources: [Paraform pricing](https://www.herohunt.ai/blog/paraform-pricing-alternatives-2026/), [Paraform vs agencies](https://www.paraform.com/insights/paraform-vs-recruiting-agencies), [Getting paid on Paraform](https://www.paraform.com/blog/payments), [Hunt Club alternatives](https://www.recruitingfromscratch.com/blog/hunt-club-alternatives), [Hunt Club funding / model](https://www.vcaonline.com/news/2021101812/hunt-club-raises-10m-to-help-high-growth-companies-hire-faster-with-candidate-referrals-and-talent-networks), [BountyJobs model (ERE)](https://ere.net/articles/bountyjobs-legal-practical-but-is-it-right-for-you), [Chain Store Age on BountyJobs](https://chainstoreage.com/news/bounty-call), [Wellfound pricing](https://www.hireinsouth.com/post/wellfound-pricing), [Upwork vs Toptal fees (Wise)](https://wise.com/us/blog/upwork-vs-toptal-comparison), [Juicebox pricing](https://fabrichq.ai/blogs/juicebox-ai-pricing), [hireEZ pricing](https://www.juicebox.ai/blog/hireez-pricing), [AI recruiting tools 2026](https://dupple.com/learn/best-ai-tools-for-recruiters).

## 2. Design patterns (Mobbin)

### Task board cards
- **Mercor, Explore opportunities** ([screen](https://mobbin.com/screens/67ac792b-1c55-4d5a-805e-b32faa3be760)). A 3-column grid of small cards. Each card shows the **title** and the **pay**, with the **referral reward ($200)** in the bottom-right corner, and nothing else. **Copy:** card = role title + "You earn $18" in the corner. Add a "Closing soon" chip only when it's true.
- **Braintrust, Open jobs** ([screen](https://mobbin.com/screens/19796e04-6c95-4931-84af-753b3cd8e20b)). A list row with the title on the left and the **price right-aligned with one black "View job" button** under it. Details sit behind "Expand details". **Copy:** right-aligned money plus a single CTA, with criteria behind an expander.
- Avoid **Upwork** ([screen](https://mobbin.com/screens/2ce19bba-0cb5-46e4-bffc-c329417fb8f8)): its dense description blocks are exactly the overload we want to cut.

### Submit candidate
- **Workable Referrals, "Find the profile online"** ([screen](https://mobbin.com/screens/1f32d162-6afa-4e73-8e3f-e570fbf6c22a)). **One input (profile link) plus one button**, then the rest. **Copy:** step 1 is "Paste their LinkedIn", from which we prefill the name. Step 2 is a note plus the consent checkbox.
- **Mercor, "Vouch for candidate"** ([screen](https://mobbin.com/screens/c383b749-5bce-46a0-9581-ab22de48f9ad)). Instead of a free-text field, a few **selectable cards** ("Worked together", "Found via LinkedIn"). **Copy:** "How do you know them?" as 3 pills, then an optional note.

### Earnings and payout received
- **Airbnb, Earnings** ([screen](https://mobbin.com/screens/421a3a60-62be-4e06-bc73-1eca4bc31c16)). A huge sentence: **"You've made $0.00 this month"**. **Copy:** a headline "You've earned $54" with the list below it.
- **Linktree, Earnings empty** ([screen](https://mobbin.com/screens/7b5fbb3a-cdd9-4e73-86c7-e7f7c5987da4)). Balance at the top, a friendly illustration, **one CTA**. **Copy:** "Let's get your first payout" plus a "Browse roles" button.
- **Airtasker, Payments history** ([screen](https://mobbin.com/screens/ead0bfce-20a9-4ca5-b5fb-afccf893799b)). A **net-earned number top-right** and an empty state with one link.
- **Wise, transfer done** ([screen](https://mobbin.com/screens/d03d7181-826c-4fc1-9910-88ce41e93010)) and **Chime, payment complete** ([screen](https://mobbin.com/screens/776c1872-943d-4fc0-adc3-2ee49383372d)). A full-screen moment with a **giant amount**, a one-line "was sent to …" and a single "Got it". **Copy:** for the payout toast, show a celebratory full-width sheet: "+$18 · Payment sent" / "Got it", with a quiet "Receipt" link.
- **Starling, Paid** ([screen](https://mobbin.com/screens/3c46b304-4259-4c8f-89cd-c2a54b3f1ebf)). A "Paid ✓" status chip plus 4 rows (Amount, Reference, When). **Copy:** the receipt detail view.

### Company review queue
- **Wellfound, applicant review** ([screen](https://mobbin.com/screens/0f7d959d-1ec6-4ea4-8902-5b366a3603bc)). **One candidate at a time ("1 of 28")** with a match badge ("PARTIAL MATCH"), a big black **Accept** and a soft red **Reject**, plus "20 days left to respond". **Copy:** a focus mode with name, score badge and one reason, the Accept/Reject pair, and the countdown as a small orange text line.
- **Juicebox, Review profiles** ([screen](https://mobbin.com/screens/46463a7f-6678-462d-a279-8763ba445694)). Approve/Reject on the right; the middle shows **"Why we matched" with ✓ Good Match per criterion**. **Copy:** criterion verdicts as a collapsed "Why this score" list of ✓/✗ lines.
- **Care.com, applicants** ([screen](https://mobbin.com/screens/3ef8a440-bf90-45f3-80f5-3c57c368988d)). A row with **price right-aligned plus a primary "Interested" and a text "Not interested"**. **Copy:** a list-mode fallback that shows the decision in-row.

### Create job (paste → AI → publish)
- **Contra, "Use AI to generate a job post in seconds"** ([screen](https://mobbin.com/screens/b5577eb0-afcf-4371-8988-85a917b775be)). A modal with **one textarea and one "Next"**, and "Step 1 of 2". **Copy:** step 1 = paste JD → "Next". Step 2 = price per candidate (big, editable), criteria chips and **Publish**.
- **Braintrust, AI job overview** ([screen](https://mobbin.com/screens/6f4424f2-6f79-4522-9785-c8c6aaac3dcf)). A friendly prompt line above the textarea and a single "Generate with AI" button.

### Onboarding / login
- **Plain, Sign up** ([screen](https://mobbin.com/screens/0e128434-2815-4d3b-b2ac-a40509fb572b)). A logo, "Sign up" and **one "Continue with Google" button**. **Copy:** that's the whole screen. Then one question, "I'm hiring / I'm a recruiter", as two big tiles.
- **Mintlify** ([screen](https://mobbin.com/screens/72bb135d-3d0f-4906-b7b8-f00300671aad)) adds an email fallback under Google, which matches our Privy setup.

## 3. Top 10 concrete changes for Scout's UI (by impact)

1. **Payout moment like Wise/Chime.** When a submission is accepted, the recruiter sees a full-width sheet: giant "+$18", "Payment sent", one "Got it" button and a tiny "Receipt" link. This is the product's emotional peak, so make it unmissable.
2. **Recruiter task card = 2 things.** Role title on the left, "You earn $18" right-aligned in bold, one "Submit candidate" button. Company, location and criteria move behind "Details". Pattern: Mercor/Braintrust.
3. **Company review in focus mode.** One candidate at a time ("1 of 3"): name, score badge (e.g. "92 · Strong match"), one-line reason, then a big **Accept · pays $18** and a soft **Reject**. The countdown "Auto-accepts in 2d" is small orange text. Per-criterion ✓/✗ goes behind "Why this score". Pattern: Wellfound/Juicebox.
4. **Two-step create role.** Step 1: paste the job description → "Next". Step 2: price per candidate (big, editable), a budget stepper ("10 candidates · $200") and **Publish**. Criteria show as at most 5 chips; the rationale is behind "Why this price?". Pattern: Contra.
5. **Submit form, link first.** One input "Paste their LinkedIn" (prefills the name), then 3 pills "How do you know them?", an optional note and the consent checkbox. One "Submit" button. Pattern: Workable/Mercor.
6. **Earnings headline.** "You've earned $54" as the H1 of My candidates, then a list of rows: name, role, status chip (Paid ✓ / In review / Not selected), amount right-aligned. Pattern: Airbnb/Airtasker.
7. **Empty states with one CTA.** No submissions: "Let's get your first payout" plus "Browse roles". No candidates for a company: "Recruiters are on it. You'll get an email when the first one arrives." Pattern: Linktree.
8. **Login = one button.** "Continue with Google" (email as a text fallback), then a role picker with two big tiles. No wallet language, ever. Pattern: Plain/Mintlify.
9. **Trust chips instead of explanations.** On the company budget card: "Budget secured" ✓. On the recruiter card: "Paid on accept" and "Auto-paid if no answer in 72h". Short chips replace every explanatory paragraph.
10. **Company role header = 2 numbers.** "$140 left" (big) and "3 to review" (big, clickable to start focus mode). Top up is a secondary button, and everything else (deposited, paid, accepted x/y) moves into a "Budget details" popover.
