# Live demo script (under 3 minutes)

## Before the demo

1. `pnpm reset:demo`: fresh scout wallets (so reputation starts at 0), the company topped up to 1000 USDC.
2. `pnpm seed --reset` (backend DB), then `pnpm dev`. Open two browser windows:
   - **Window A, company:** `http://localhost:5173/?auth=demo`, account "Company", or Google login.
   - **Window B, scout:** a separate profile or incognito window, account "Scout". Keep "Scout 2" ready in the account menu.
3. Keep a job description in the clipboard: `backend/src/agent/fixtures/`.
4. Keep the backup recording ready (faucet and Wi-Fi outages happen).

## Script

| # | Who | Do | Say |
|---|---|---|---|
| 1 | Company | New role, paste the JD | "The agent turns a job description into weighted criteria and suggests a price per qualified candidate." |
| 2 | Company | Fund and publish 200 USDC, then click the Explorer link | "That budget is now in a vault owned by a program, not by us. Here's the transaction." |
| 3 | Scout | Task board, then submit two candidates (strong and weak notes) | "Scouts are independent recruiters anywhere. They see the bounty they'll actually receive." |
| 4 | Company | The pipeline shows a score of about 90 (ADVANCE) and about 30 (PASS), with quoted evidence | "Each criterion is judged separately, citing the scout's notes. The decision stays with a human." |
| 5 | Company | Accept the first candidate. The scout window shows a toast saying 18 USDC arrived and reputation 1/1 | "One click, paid instantly, 10% fee to the treasury, all in one transaction." |
| 5b | Company | Reject the second with "Doesn't match" | |
| 6 | Scout 2 | Submit the same candidate | "Blocked. The first scout keeps the credit, proven on-chain." |
| 7 | Scout | Submit a third candidate. Company does nothing. After 60 s, click "Claim payout" | "If the company goes silent, the scout still gets paid. Anyone can trigger it, so no one is in the middle." |
| 8 | Company | Top up by 100 USDC | "Start small and add budget as trust grows." |

## Expected questions

- **Where does the intermediary disappear?** In `programs/scout/src/instructions/accept_submission.rs` and `settle_expired.rs`, which share the transfer logic in `payout.rs`. Both move funds out of the PDA-owned vault.
- **What if someone disappears?** If the company goes silent, the submission is auto-accepted after the window. If the scout goes silent, nothing is owed. The company can close the role and get the unspent budget back.
- **Can you change anything after deployment?** The fee is snapshotted per role. The program is upgradeable by our key today; for production it moves to a multisig. See `docs/design-rationale.md`.
- **Why not a database?** No custodian, instant global payouts, portable reputation and provable first submission.
