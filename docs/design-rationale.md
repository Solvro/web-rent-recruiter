# Design rationale

## Which financial relationship we redesigned

Paying an independent recruiter for sourcing work.

Today a company that needs hard-to-reach candidates chooses between two options:

1. **An agency.** It costs about 20% of annual salary and is paid only on hire. The agency carries all the risk, so it prices that risk in and works only on roles it is confident it can close.
2. **Doing everything in-house.** AI can screen profiles well, but it cannot reach the right people, earn a reply or run a first conversation. That part still needs a human with a network.

Independent recruiters ("scouts") would happily do that work in smaller units, but they would be working for strangers:

- The scout has no guarantee of payment. Invoices wait weeks or months, clients go silent, and a candidate gets hired "around" the recruiter.
- The company has no reason to prepay a stranger in another country.
- Who submitted a candidate first is a classic dispute in agency recruiting, and only a platform's database can settle it.

The trusted intermediary in this relationship is the agency or marketplace. It holds the client's money, decides when a scout has earned it, settles "who was first" disputes, and takes a cut for it.

## What changes once the intermediary is removed

| Today (trusted intermediary) | Scout (program on Solana) |
|---|---|
| The platform holds the client's budget | The budget sits in a `RoleVault` token account owned by a program PDA. Neither we nor anyone else can move it outside the program's rules. |
| The platform decides when a scout has earned money | `accept_submission` pays the scout `bounty − fee` and the treasury `fee` in one transaction. |
| A silent client means an unpaid scout | Each submission has a `review_deadline`. After it, `settle_expired` is **permissionless**: anyone, including the scout, can trigger the payout. Silence counts as acceptance. |
| A pending submission might not be paid if the budget runs out | `submit_candidate` requires the vault to cover every pending submission (`balance ≥ (pending + 1) × bounty`). A submitted candidate is always fully funded. |
| A company can reject at the last second to dodge payment | `reject_submission` is only valid before the deadline. |
| The company's leftover budget is stuck with the platform | `close_role` refunds the unspent balance to the company. It requires no pending submissions, so scouts can't be rugged. |
| "Who submitted first" is the platform's word | The Submission PDA is seeded by `[roleVault, candidateHash]`. The second identical submission fails, and the chain's timestamp is proof of who was first. |
| Reputation is locked inside each marketplace | The `ScoutProfile` PDA counts submitted, accepted, rejected and total earned. It is public and portable. |
| Cross-border payouts need a payments provider | USDC lands in the scout's wallet seconds after acceptance, in any country. |

What we still run is the convenience layer: the AI agent, the database of candidate details, and a relayer that pays network fees so users never need SOL. None of it can move funds. The relayer only adds its fee-payer signature to transactions the user has already signed, and it refuses any instruction outside our program.

## Who we are building for

- **Companies:** startups and scale-ups hiring for hard-to-find technical roles. They know what they need but don't want to pay 20% of salary up front of a hire. They log in with Google and see only USDC amounts. There are no wallets, seed phrases or SOL in the interface.
- **Scouts:** independent recruiters and sourcers, often in CEE, working for clients abroad. They want small, fast, guaranteed payments and a track record they can take with them.

Both are people outside the crypto world. That is why the chain is invisible: embedded wallets, sponsored fees, USDC only. A small "View on Solana Explorer" link after each action shows that real transactions happened.

## Why AI and humans, not AI alone

The agent turns a job description into weighted criteria, suggests a bounty, and scores every submission per criterion, quoting the scout's notes as evidence. It does not decide. A person accepts or rejects, and that is deliberate: under the EU AI Act, AI systems used to evaluate candidates in recruitment are classified as high-risk and require meaningful human oversight. The score is computed by code from per-criterion verdicts, so it is explainable and consistent.

## Business model

- A platform fee of 10% of each accepted bounty (`Config.fee_bps`). It is snapshotted into each role at creation, so we can't raise the fee on a running role.
- The unit economics are attractive to companies because spending is incremental. You pay 20 USDC per qualified, interested candidate rather than 20% of a salary. Companies can start with 200 USDC and top up as trust grows.

## Known limitations (said plainly)

- **Upgrade authority:** the program is upgradeable by the deployer key. Before real money, it moves to a multisig and later becomes immutable.
- **Off-chain identity:** the API identifies users by wallet address without a signed session. Money movements still require the user's own signature, so a spoofed identity can't move funds, but it can read data. A sign-in signature is the next step.
- **"Qualified" is a human judgement:** a malicious company can reject good candidates before the deadline. Reputation is two-sided in the roadmap: rejection rates per company become visible to scouts.
- **Mock USDC on devnet:** we mint our own 6-decimal token labelled USDC.
