/**
 * In-memory stand-in for backend + chain. Lives for the browser session only.
 * Money moves only when /tx/submit runs the effect registered with the unsigned tx,
 * mirroring how the real flow only changes state once the transaction confirms.
 */
import type { AgentReview, Criteria, Me, RejectReason } from "@scout/shared";
import { DEFAULT_FEE_BPS, toBaseUnits } from "@scout/shared";
import { PERSONAS } from "../personas";
import { draftRole, reviewCandidate } from "./agent";

export type MockProfile = {
	wallet: string;
	kind: Me["kind"];
	displayName: string;
	avatarUrl: string | null;
	companyName: string | null;
	registered: boolean;
	balance: bigint;
	earned: bigint;
};

export type MockRole = {
	id: string;
	onchainRoleId: string;
	roleVault: string;
	title: string;
	summary: string;
	jobDescription: string;
	criteria: Criteria;
	companyWallet: string;
	companyName: string;
	status: "DRAFT" | "OPEN" | "CLOSED";
	bounty: bigint;
	feeBps: number;
	maxCandidates: number;
	reviewWindowSeconds: number;
	deposited: bigint;
	paid: bigint;
	balance: bigint;
	salt: string;
	createdAt: string;
};

export type MockSubmission = {
	id: string;
	roleId: string;
	candidateName: string;
	profileUrl: string;
	notes: string;
	candidateHash: string;
	onchainAddress: string | null;
	scoutWallet: string;
	status: "PENDING" | "ACCEPTED" | "REJECTED";
	rejectReason: RejectReason | null;
	submittedAt: string;
	reviewDeadline: string;
	settlementTx: string | null;
	review: AgentReview | null;
};

type Listener = (e: { type: string; roleId?: string; submissionId?: string; signature?: string }) => void;
const listeners = new Set<Listener>();
export const mockEvents = {
	subscribe(l: Listener) {
		listeners.add(l);
		return () => {
			listeners.delete(l);
		};
	},
	emit(e: Parameters<Listener>[0]) {
		for (const l of listeners) l(e);
	},
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function fakeBase58(length: number) {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (b) => B58[b % 58]).join("");
}
export const fakeSignature = () => fakeBase58(88);
export const fakeAddress = () => fakeBase58(44);

export function normalizeProfileUrl(url: string) {
	return url
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
}

export async function candidateHash(salt: string, profileUrl: string) {
	const data = new TextEncoder().encode(salt + normalizeProfileUrl(profileUrl));
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const inFuture = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export const db = {
	profiles: new Map<string, MockProfile>(),
	roles: new Map<string, MockRole>(),
	submissions: new Map<string, MockSubmission>(),
	pendingTxs: new Map<string, { summary: string; effect: (signature: string) => void }>(),
	nextRoleId: 1042,
	nextId: 1,
};

export const newId = (prefix: string) => `${prefix}_${(db.nextId++).toString(36)}${fakeBase58(6)}`;

const NORTHWIND_JD = `Senior Backend Engineer (Payments)
Northwind Robotics builds fleet software for warehouse robots used by 40+ logistics sites in Europe. We're hiring a Senior Backend Engineer to own the billing and payouts platform.

What you'll do
- Design and run Node.js and TypeScript services that bill customers per robot-hour
- Own our PostgreSQL ledger and the integrations with Stripe and bank transfers
- Work with product on usage-based pricing experiments

What we're looking for
- 5+ years building backend systems in TypeScript / Node.js
- Strong PostgreSQL and data modelling
- Payments, billing or fintech experience
- Event-driven or distributed systems at scale
- Nice to have: AWS, Kubernetes, mentoring engineers

Hybrid in Warsaw (2 days a week), English required, Polish is a plus.
Salary 28 000 - 36 000 PLN per month on B2B.`;

const DESIGNER_JD = `Founding Product Designer
Northwind Robotics is looking for its first product designer to own the operator console used on warehouse floors. Remote within the EU.
- 4+ years of product design for B2B SaaS, strong Figma and prototyping
- Ran user research and usability interviews with non-technical users
- Built or scaled a design system
- Early-stage startup experience
English required. 18 000 - 24 000 PLN per month.`;

const KESTREL_JD = `Staff Data Engineer
Kestrel Analytics turns retail transaction data into demand forecasts for 300 grocery chains.
- Spark, dbt and Airflow pipelines processing 2B rows a day
- Python and SQL, cloud warehouse on GCP
- Machine learning in production is a plus
- Mentoring and technical leadership of a team of 5
Remote, EU time zones, English. 150k - 190k EUR per year.`;

const DRIFTLINE_JD = `Solana Smart Contract Engineer
Driftline is building on-chain payroll for remote teams. Remote.
- Rust and Anchor programs on Solana in production
- TypeScript clients and testing culture
- Payments or fintech domain knowledge
- Security mindset
English. 120k - 160k USD per year.`;

function seedRole(input: {
	jd: string;
	companyWallet: string;
	companyName: string;
	deposited: number;
	paid: number;
	reviewWindowSeconds: number;
	createdAgo: number;
	bounty?: number;
}) {
	const draft = draftRole(input.jd);
	const id = newId("role");
	const role: MockRole = {
		id,
		onchainRoleId: String(db.nextRoleId++),
		roleVault: fakeAddress(),
		title: draft.title,
		summary: draft.summary,
		jobDescription: input.jd,
		criteria: draft.criteria,
		companyWallet: input.companyWallet,
		companyName: input.companyName,
		status: "OPEN",
		bounty: input.bounty ? toBaseUnits(input.bounty) : BigInt(draft.suggestedBounty),
		feeBps: DEFAULT_FEE_BPS,
		maxCandidates: draft.suggestedMaxCandidates,
		reviewWindowSeconds: input.reviewWindowSeconds,
		deposited: toBaseUnits(input.deposited),
		paid: toBaseUnits(input.paid),
		balance: toBaseUnits(input.deposited - input.paid),
		salt: fakeBase58(16),
		createdAt: ago(input.createdAgo),
	};
	db.roles.set(id, role);
	return role;
}

async function seedSubmission(
	role: MockRole,
	scoutWallet: string,
	c: { name: string; url: string; notes: string },
	status: MockSubmission["status"],
	submittedAgo: number,
	extra: Partial<MockSubmission> = {},
) {
	const id = newId("sub");
	const sub: MockSubmission = {
		id,
		roleId: role.id,
		candidateName: c.name,
		profileUrl: c.url,
		notes: c.notes,
		candidateHash: await candidateHash(role.salt, c.url),
		onchainAddress: fakeAddress(),
		scoutWallet,
		status,
		rejectReason: null,
		submittedAt: ago(submittedAgo),
		reviewDeadline: new Date(
			Date.now() - submittedAgo * 1000 + role.reviewWindowSeconds * 1000,
		).toISOString(),
		settlementTx: status === "PENDING" ? null : fakeSignature(),
		review: reviewCandidate(role.criteria, { name: c.name, profileUrl: c.url, notes: c.notes }),
		...extra,
	};
	db.submissions.set(id, sub);
	return sub;
}

function profile(wallet: string, p: Omit<MockProfile, "wallet">) {
	db.profiles.set(wallet, { wallet, ...p });
}

const STORAGE_KEY = "scout.mock-db.v1";

/** Survives page reloads and Vite HMR; reset from the account menu. */
export function persist() {
	try {
		sessionStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(
				{
					profiles: [...db.profiles.entries()],
					roles: [...db.roles.entries()],
					submissions: [...db.submissions.entries()],
					nextRoleId: db.nextRoleId,
					nextId: db.nextId,
				},
				(_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v),
			),
		);
	} catch {
		// storage unavailable: state just won't survive a reload
	}
}

function restore() {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return false;
		const data = JSON.parse(raw, (_k, v) =>
			v && typeof v === "object" && "$big" in v ? BigInt((v as { $big: string }).$big) : v,
		);
		db.profiles = new Map(data.profiles);
		db.roles = new Map(data.roles);
		db.submissions = new Map(data.submissions);
		db.nextRoleId = data.nextRoleId;
		db.nextId = data.nextId;
		return true;
	} catch {
		return false;
	}
}

export function resetMockData() {
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// ignore
	}
}

let seeded: Promise<void> | null = null;
export function ensureSeeded() {
	seeded ??= restore() ? Promise.resolve() : seed().then(persist);
	return seeded;
}

async function seed() {
	const company = PERSONAS.company.mockAddress;
	const marta = PERSONAS.scout.mockAddress;
	const jonas = PERSONAS.scout2.mockAddress;
	const kestrel = fakeAddress();
	const driftline = fakeAddress();
	const piotr = fakeAddress();

	profile(company, {
		kind: "company",
		displayName: PERSONAS.company.displayName,
		avatarUrl: null,
		companyName: PERSONAS.company.companyName ?? null,
		registered: false,
		balance: toBaseUnits(1000),
		earned: 0n,
	});
	profile(marta, {
		kind: "scout",
		displayName: PERSONAS.scout.displayName,
		avatarUrl: null,
		companyName: null,
		registered: true,
		balance: toBaseUnits(45),
		earned: toBaseUnits(45),
	});
	profile(jonas, {
		kind: "scout",
		displayName: PERSONAS.scout2.displayName,
		avatarUrl: null,
		companyName: null,
		registered: false,
		balance: 0n,
		earned: 0n,
	});
	profile(piotr, {
		kind: "scout",
		displayName: "Piotr Adamski",
		avatarUrl: null,
		companyName: null,
		registered: true,
		balance: toBaseUnits(18),
		earned: toBaseUnits(18),
	});
	for (const [wallet, name] of [
		[kestrel, "Kestrel Analytics"],
		[driftline, "Driftline"],
	] as const) {
		profile(wallet, {
			kind: "company",
			displayName: name,
			avatarUrl: null,
			companyName: name,
			registered: false,
			balance: toBaseUnits(500),
			earned: 0n,
		});
	}

	const backend = seedRole({
		jd: NORTHWIND_JD,
		companyWallet: company,
		companyName: "Northwind Robotics",
		deposited: 200,
		paid: 40,
		reviewWindowSeconds: 72 * 3600,
		createdAgo: 6 * 86400,
	});
	seedRole({
		jd: DESIGNER_JD,
		companyWallet: company,
		companyName: "Northwind Robotics",
		deposited: 150,
		paid: 0,
		reviewWindowSeconds: 72 * 3600,
		createdAgo: 2 * 86400,
	});
	const data = seedRole({
		jd: KESTREL_JD,
		companyWallet: kestrel,
		companyName: "Kestrel Analytics",
		bounty: 30,
		deposited: 240,
		paid: 30,
		reviewWindowSeconds: 48 * 3600,
		createdAgo: 4 * 86400,
	});
	seedRole({
		jd: DRIFTLINE_JD,
		companyWallet: driftline,
		companyName: "Driftline",
		deposited: 250,
		paid: 0,
		reviewWindowSeconds: 48 * 3600,
		createdAgo: 86400,
	});

	await seedSubmission(
		backend,
		marta,
		{
			name: "Tomasz Wójcik",
			url: "https://www.linkedin.com/in/tomasz-wojcik-backend",
			notes:
				"7 years of TypeScript and Node.js, built the ledger service at a Warsaw payments startup (PostgreSQL, Kafka, event-driven). Open to hybrid in Warsaw, speaks Polish and English. Interested, available in 1 month.",
		},
		"ACCEPTED",
		5 * 86400,
	);
	await seedSubmission(
		backend,
		piotr,
		{
			name: "Aleksandra Nowak",
			url: "https://www.linkedin.com/in/aleksandra-nowak-dev",
			notes:
				"Senior Node.js engineer with TypeScript, PostgreSQL and AWS. Worked on billing at a SaaS company, mentoring two juniors. Based in Warsaw, open to hybrid.",
		},
		"ACCEPTED",
		4 * 86400,
	);
	await seedSubmission(
		backend,
		jonas,
		{
			name: "Kamil Dąbrowski",
			url: "https://github.com/kdabrowski",
			notes:
				"Python and Go developer, mostly data tooling. Would need to relocate from Gdańsk and is not open to hybrid.",
		},
		"PENDING",
		3 * 3600,
	);
	await seedSubmission(
		data,
		marta,
		{
			name: "Ewa Kaczmarek",
			url: "https://www.linkedin.com/in/ewa-kaczmarek-data",
			notes:
				"Leads a data platform team of 4: Spark, dbt and Airflow on GCP, Python and SQL daily. Deployed demand forecasting models. Remote from Kraków, fluent English.",
		},
		"ACCEPTED",
		2 * 86400,
	);
}

export function registerTx(summary: string, effect: (signature: string) => void) {
	const id = `mock-tx:${newId("tx")}`;
	db.pendingTxs.set(id, { summary, effect });
	return { transaction: btoa(id), summary };
}

export function runTx(transaction: string) {
	let id: string;
	try {
		id = atob(transaction);
	} catch {
		return null;
	}
	const tx = db.pendingTxs.get(id);
	if (!tx) return null;
	db.pendingTxs.delete(id);
	const signature = fakeSignature();
	tx.effect(signature);
	return signature;
}

export function pendingCount(roleId: string) {
	let n = 0;
	for (const s of db.submissions.values()) if (s.roleId === roleId && s.status === "PENDING") n++;
	return n;
}

export function acceptedCount(roleId: string) {
	let n = 0;
	for (const s of db.submissions.values()) if (s.roleId === roleId && s.status === "ACCEPTED") n++;
	return n;
}

/** Same payout as accept_submission / settle_expired on-chain. */
export function payout(sub: MockSubmission, signature: string) {
	const role = db.roles.get(sub.roleId);
	if (!role) return;
	const fee = (role.bounty * BigInt(role.feeBps)) / 10_000n;
	const net = role.bounty - fee;
	role.balance -= role.bounty;
	role.paid += role.bounty;
	sub.status = "ACCEPTED";
	sub.settlementTx = signature;
	const scout = db.profiles.get(sub.scoutWallet);
	if (scout) {
		scout.balance += net;
		scout.earned += net;
	}
	mockEvents.emit({ type: "SubmissionAccepted", roleId: role.id, submissionId: sub.id, signature });
}

export { inFuture };
