/**
 * Dev smoke test for the notetaker flow against the dev DB: picks a claimed screening gig and runs the recording
 * flow to "done". Run with RECALL_MOCK=1 (no real bot):
 *   RECALL_MOCK=1 RECALL_MOCK_STEP_MS=500 pnpm exec tsx --env-file=.env src/recall/smoke.ts
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { invite, status } from "./service.ts";

const [gig] = await db
	.select()
	.from(schema.gigs)
	.where(and(eq(schema.gigs.type, "SCREENING_CALL"), isNotNull(schema.gigs.claimantWallet)))
	.limit(1);
const claimant = gig?.claimantWallet;
if (!gig || !claimant) {
	console.log("No claimed screening gig in the DB. Take one in the app first.");
	process.exit(0);
}
console.log(`gig ${gig.id}`);
const first = await invite(claimant, { gigId: gig.id, meetingUrl: "https://meet.google.com/abc-defg-hij" });
console.log(first.status);
for (let i = 0; i < 20; i++) {
	await new Promise((r) => setTimeout(r, 700));
	const s = await status(claimant, gig.id);
	console.log(s?.status, s?.prefill ? `${s.prefill.answers.length} answers` : "");
	if (s?.status === "done" || s?.status === "failed") break;
}
process.exit(0);
