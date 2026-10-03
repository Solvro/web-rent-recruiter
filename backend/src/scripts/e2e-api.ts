/**
 * End-to-end check of the REST API + relayer against a running backend and a deployed program.
 *   API=http://localhost:8788 pnpm --filter @scout/backend exec tsx src/scripts/e2e-api.ts
 * Needs the demo wallets (~/.config/solana/superrecruiter/{client,recruiter}.json) funded with mock USDC.
 * Walks the demo script: draft → fund → submit ×3 → duplicate blocked → accept → reject → auto-settle → top-up.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEMO_REVIEW_WINDOW_SECONDS, fromBaseUnits, toBaseUnits, WALLET_HEADER } from "@scout/shared";
import {
	createKeyPairSignerFromBytes,
	generateKeyPairSigner,
	getBase64EncodedWireTransaction,
	getTransactionDecoder,
	type KeyPairSigner,
	partiallySignTransaction,
} from "@solana/kit";

const API = `${process.env.API ?? "http://localhost:8788"}/api`;
const reviewWindow = Number(process.env.REVIEW_WINDOW ?? 40) || DEMO_REVIEW_WINDOW_SECONDS;
const load = async (p: string) =>
	createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(resolve(homedir(), p), "utf8"))));

async function call<T>(
	signer: KeyPairSigner | null,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(signer ? { [WALLET_HEADER]: signer.address } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json();
	if (!res.ok)
		throw Object.assign(new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`), {
			status: res.status,
			json,
		});
	return json as T;
}

async function signAndSubmit(signer: KeyPairSigner, unsigned: { transaction: string; summary: string }) {
	const tx = getTransactionDecoder().decode(Buffer.from(unsigned.transaction, "base64"));
	const signed = await partiallySignTransaction([signer.keyPair], tx);
	const r = await call<{ signature: string; explorerUrl: string }>(null, "POST", "/tx/submit", {
		signedTx: getBase64EncodedWireTransaction(signed),
	});
	console.log(`  ✓ ${unsigned.summary}\n    ${r.explorerUrl}`);
	return r;
}

const company = await load(".config/solana/superrecruiter/client.json");
const scout = await load(".config/solana/superrecruiter/recruiter.json");
const scout2 = await generateKeyPairSigner(); // has no SOL at all: the relayer pays everything

await call(null, "GET", "/tasks");
await call(company, "PUT", "/me", { kind: "company", displayName: "Hanna Lis", companyName: "Kestrel Labs" });
await call(scout, "PUT", "/me", { kind: "scout", displayName: "Marta Kowalczyk" });
await call(scout2, "PUT", "/me", { kind: "scout", displayName: "Daniel Okafor" });
const me = await call<{ usdcBalance: string }>(company, "GET", "/me");
console.log(`company USDC: ${fromBaseUnits(me.usdcBalance)}`);

const jd =
	"Kestrel Labs builds flight-planning software for drone fleets. We're hiring a Senior TypeScript Engineer to own our real-time map editor (React, WebGL) and the Node.js services behind it. 5+ years with TypeScript, production React performance work, and experience with geospatial data. Nice to have: Mapbox GL or deck.gl, Rust/WASM. Remote in the EU, 120k–150k EUR.";
console.log("drafting role with the agent…");
const draft = await call<{
	title: string;
	summary: string;
	criteria: unknown;
	suggestedBounty: string;
	suggestedMaxCandidates: number;
}>(company, "POST", "/roles/draft", { jobDescription: jd });
console.log(
	`  ${draft.title}: ${fromBaseUnits(draft.suggestedBounty)} USDC × ${draft.suggestedMaxCandidates}`,
);

const bounty = toBaseUnits(20);
const created = await call<{ roleId: string; unsignedTx: { transaction: string; summary: string } }>(
	company,
	"POST",
	"/roles",
	{
		title: draft.title,
		summary: draft.summary,
		jobDescription: jd,
		criteria: draft.criteria,
		bounty: bounty.toString(),
		maxCandidates: 10,
		reviewWindowSeconds: reviewWindow,
		deposit: toBaseUnits(100).toString(),
	},
);
await signAndSubmit(company, created.unsignedTx);
const roleId = created.roleId;
type Role = {
	status: string;
	budget: Record<string, string>;
	submissions: { id: string; candidateName: string; status: string; review: unknown }[];
};
let role = await call<Role>(company, "GET", `/roles/${roleId}`);
console.log(`role ${role.status}, budget`, role.budget);

const submit = async (who: KeyPairSigner, name: string, profileUrl: string) => {
	const r = await call<{ submissionId: string; unsignedTx: { transaction: string; summary: string } }>(
		who,
		"POST",
		`/roles/${roleId}/submissions`,
		{
			name,
			profileUrl,
			notes: `${name}: 6 years TypeScript, built a WebGL map editor, open to remote.`,
			consent: true,
		},
	);
	await signAndSubmit(who, r.unsignedTx);
	return r.submissionId;
};
const a = await submit(scout, "Iga Mazur", "https://www.linkedin.com/in/iga-mazur/");
const b = await submit(scout, "Karol Dudek", "https://linkedin.com/in/karol-dudek");
const c = await submit(scout2, "Ewa Sowa", "https://linkedin.com/in/ewa-sowa");

try {
	await call(scout2, "POST", `/roles/${roleId}/submissions`, {
		name: "Iga Mazur",
		profileUrl: "http://LinkedIn.com/in/Iga-Mazur?utm=x",
		notes: "same person",
		consent: true,
	});
	throw new Error("duplicate was not blocked");
} catch (err) {
	if ((err as { status?: number }).status !== 409) throw err;
	console.log("  ✓ duplicate candidate blocked (409), first scout keeps the credit");
}

const review = await call<{ score: number; recommendation: string }>(
	null,
	"POST",
	`/submissions/${a}/review`,
);
console.log(`  agent review: ${review.score} ${review.recommendation}`);

const accept = await call<{ unsignedTx: { transaction: string; summary: string } }>(
	company,
	"POST",
	`/submissions/${a}/decision`,
	{ decision: "accept" },
);
await signAndSubmit(company, accept.unsignedTx);
const reject = await call<{ unsignedTx: { transaction: string; summary: string } }>(
	company,
	"POST",
	`/submissions/${c}/decision`,
	{ decision: "reject", reasonCode: "NOT_MATCHING" },
);
await signAndSubmit(company, reject.unsignedTx);

console.log(`waiting ${reviewWindow + 2}s for the review window…`);
await new Promise((r) => setTimeout(r, (reviewWindow + 2) * 1000));
const settled = await call<{ explorerUrl: string }>(null, "POST", `/submissions/${b}/settle`);
console.log(`  ✓ auto-accepted after silence\n    ${settled.explorerUrl}`);

const topUp = await call<{ unsignedTx: { transaction: string; summary: string } }>(
	company,
	"POST",
	`/roles/${roleId}/top-up`,
	{ amount: toBaseUnits(20).toString() },
);
await signAndSubmit(company, topUp.unsignedTx);

role = await call<Role>(company, "GET", `/roles/${roleId}`);
console.log("final budget", role.budget);
console.log(
	"submissions",
	role.submissions.map((s) => `${s.candidateName}:${s.status}${s.review ? "+review" : ""}`),
);
const profile = await call<{ reputation: unknown; profileAddress: string | null }>(
	null,
	"GET",
	`/scouts/${scout.address}`,
);
console.log("scout reputation (on-chain)", profile.reputation, profile.profileAddress);

const mine = await call<{ roleTitle: string }[]>(scout, "GET", "/submissions/mine");
if (!mine.every((s) => typeof s.roleTitle === "string" && s.roleTitle.length > 0))
	throw new Error("roleTitle missing");
console.log(`  ✓ /submissions/mine carries roleTitle (${mine[0]?.roleTitle})`);

// Summary must reflect the final state (2 accepted, 1 rejected, 0 pending, budget after top-up): it is null while
// stale and reappears once the agent has recomputed it.
let summary: string | null = null;
for (let i = 0; i < 30 && !summary; i++) {
	summary = (await call<{ pipelineSummary: string | null }>(company, "GET", `/roles/${roleId}`))
		.pipelineSummary;
	if (!summary) await new Promise((r) => setTimeout(r, 2000));
}
console.log(`  ✓ fresh pipeline summary: ${summary}`);
