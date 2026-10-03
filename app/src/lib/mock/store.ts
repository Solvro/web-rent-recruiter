/**
 * In-memory stand-in for backend + chain. Lives for the browser session only.
 * Money moves only when /tx/submit runs the effect registered with the unsigned tx,
 * mirroring how the real flow only changes state once the transaction confirms.
 */
import type { AgentReview, Criteria, Me, RejectReason } from "@scout/shared";
import { DEFAULT_FEE_BPS, toBaseUnits } from "@scout/shared";
import { splitBounty } from "../payout";
import { PERSONAS } from "../personas";
import { reviewCandidate } from "./agent";
import demo from "./demo-data.json";

export type MockProfile = {
	wallet: string;
	kind: Me["kind"];
	displayName: string;
	avatarUrl: string | null;
	companyName: string | null;
	registered: boolean;
	balance: bigint;
	earned: bigint;
	/** Organisation that vouched for this recruiter; takes feeBps of each payout. */
	operator: { name: string; feeBps: number } | null;
	advanced: number;
	flagged: number;
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
	taskType: "SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK";
	holdbackBps: number;
	holdbackWindowSeconds: number;
	heldBack: bigint;
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
	screeningNotes?: string;
	outcome: "NONE" | "ADVANCED" | "FABRICATED";
	laterStatus: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	laterReleasesAt: string | null;
	/** Actual split, fixed at accept time. */
	split: { now: bigint; later: bigint; operatorFee: bigint; platformFee: bigint } | null;
};

type Listener = (e: {
	type: string;
	roleId?: string;
	submissionId?: string;
	signature?: string;
	scout?: string;
	payout?: string;
}) => void;
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

/** Fixed id so the gig store can attribute simulated work to her. */
export const ANDREEA = "5Qx1oZq3Z8C3ZkVh9tYb6sLwPpN2mX4rT7uKcD1eFgHa";

export const db = {
	profiles: new Map<string, MockProfile>(),
	roles: new Map<string, MockRole>(),
	submissions: new Map<string, MockSubmission>(),
	pendingTxs: new Map<string, { summary: string; effect: (signature: string) => void }>(),
	nextRoleId: 1042,
	nextId: 1,
};

export const newId = (prefix: string) => `${prefix}_${(db.nextId++).toString(36)}${fakeBase58(6)}`;

type DemoRole = (typeof demo.roles)[number];
type DemoCandidate = { name: string; profileUrl: string; notes: string };

/** Job description for the live "create role" step: the demo role from docs/research/demo-use-cases.json. */
export const DEMO_JOB_DESCRIPTION = demo.roles.find((r) => r.demo)?.jobDescription ?? "";

/** Same company labels as backend/src/scripts/seed.ts. */
const SHORT_COMPANY: Record<string, string> = {
	"forward-deployed-engineer": "Pre-seed robotics startup · Zürich",
	"account-executive-dach": "Growth-stage B2B SaaS · Kraków",
	"java-backend-insurance": "Enterprise insurtech vendor · Poland",
};

/** Scores measured with the real agent for the scripted candidates, so the mock tells the same story. */
const MEASURED = new Map(
	demo.demoSubmissions
		.filter((s) => s.measuredScore?.jev)
		.map((s) => {
			const [score, rec] = (s.measuredScore?.jev ?? "").split(" ");
			return [normalizeProfileUrl(s.candidate.profileUrl), { score: Number(score), rec }] as const;
		}),
);

export function reviewFor(criteria: Criteria, c: DemoCandidate): AgentReview {
	const review = reviewCandidate(criteria, { name: c.name, profileUrl: c.profileUrl, notes: c.notes });
	const measured = MEASURED.get(normalizeProfileUrl(c.profileUrl));
	if (!measured) return review;
	const recommendation = measured.rec as AgentReview["recommendation"];
	const summary =
		recommendation === "ADVANCE"
			? `${c.name} matches every must-have: production Rust, Anchor programs on mainnet, DeFi and fuzzing.`
			: recommendation === "MAYBE"
				? `${c.name} writes strong production Rust, but hasn't shipped a Solana program yet.`
				: `${c.name} builds dApp frontends, has no Rust, and only wants fully remote work.`;
	// Keep the per-criterion lines consistent with the measured verdict.
	const must = new Set(criteria.mustHave.map((x) => x.id));
	const deal = new Set(criteria.dealBreakers.map((x) => x.id));
	const verdicts = review.verdicts.map((v) => {
		if (recommendation === "ADVANCE" && must.has(v.criterionId))
			return { ...v, verdict: "MET" as const, reasoning: "Clear evidence in the recruiter's note." };
		if (recommendation === "ADVANCE" && deal.has(v.criterionId)) return { ...v, verdict: "NOT_MET" as const };
		if (recommendation === "PASS" && deal.has(v.criterionId))
			return { ...v, verdict: "MET" as const, reasoning: "The note says this applies." };
		return v;
	});
	return { ...review, verdicts, score: measured.score, recommendation, summary };
}

function seedRole(input: {
	role: DemoRole;
	companyWallet: string;
	companyName: string;
	deposited: number;
	paid: number;
	reviewWindowSeconds: number;
	createdAgo: number;
}) {
	const r = input.role;
	const id = newId("role");
	const role: MockRole = {
		id,
		onchainRoleId: String(db.nextRoleId++),
		roleVault: fakeAddress(),
		title: r.title,
		summary: `${r.locationLabel}. ${r.salaryLabel}.`,
		jobDescription: r.jobDescription,
		criteria: r.criteria as Criteria,
		companyWallet: input.companyWallet,
		companyName: input.companyName,
		status: "OPEN",
		bounty: toBaseUnits(r.bountyUsd),
		feeBps: DEFAULT_FEE_BPS,
		maxCandidates: r.maxCandidates,
		reviewWindowSeconds: input.reviewWindowSeconds,
		taskType: "SOURCING",
		holdbackBps: HOLDBACK_BPS,
		holdbackWindowSeconds: HOLDBACK_WINDOW_SECONDS,
		heldBack: 0n,
		deposited: toBaseUnits(input.deposited),
		paid: toBaseUnits(input.paid),
		balance: toBaseUnits(input.deposited - input.paid),
		salt: fakeBase58(16),
		createdAt: ago(input.createdAgo),
	};
	db.roles.set(id, role);
	return role;
}

function profile(wallet: string, p: Omit<MockProfile, "wallet">) {
	db.profiles.set(wallet, { wallet, ...p });
}

const STORAGE_KEY = "scout.mock-db.v5";

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
		sessionStorage.removeItem("scout.mock-gigs.v3");
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
	const ola = PERSONAS.scout.mockAddress;
	const lucia = PERSONAS.scout2.mockAddress;
	const andreea = ANDREEA;
	const robotics = fakeAddress();
	const saas = fakeAddress();
	const insurtech = fakeAddress();
	const person = (name: string, kind: MockProfile["kind"], extra: Partial<MockProfile> = {}) => ({
		kind,
		displayName: name,
		avatarUrl: null,
		companyName: kind === "company" ? name : null,
		registered: kind === "scout",
		balance: 0n,
		earned: 0n,
		operator: null,
		advanced: 0,
		flagged: 0,
		...extra,
	});

	profile(
		company,
		person(PERSONAS.company.displayName, "company", {
			companyName: PERSONAS.company.companyName ?? null,
			balance: toBaseUnits(1000),
		}),
	);
	profile(
		ola,
		person(PERSONAS.scout.displayName, "scout", {
			operator: { name: "Kraków Recruiting Academy", feeBps: 1000 },
		}),
	);
	profile(lucia, person(PERSONAS.scout2.displayName, "scout", { registered: false }));
	profile(andreea, person(demo.recruiters[2]?.displayName ?? "Andreea Popescu", "scout"));
	for (const [wallet, key] of [
		[robotics, "forward-deployed-engineer"],
		[saas, "account-executive-dach"],
		[insurtech, "java-backend-insurance"],
	] as const)
		profile(wallet, person(SHORT_COMPANY[key], "company", { balance: toBaseUnits(500) }));

	const roles = demo.roles.filter((r) => !r.demo);
	// The demo company starts with no roles: it creates the main one live.
	const owners: Record<string, string> = {
		"forward-deployed-engineer": robotics,
		"account-executive-dach": saas,
		"java-backend-insurance": insurtech,
	};
	const seeded = new Map<string, MockRole>();
	for (const [i, r] of roles.entries()) {
		seeded.set(
			r.key,
			seedRole({
				role: r,
				companyWallet: owners[r.key] ?? saas,
				companyName: SHORT_COMPANY[r.key] ?? r.company,
				deposited: r.bountyUsd * r.maxCandidates,
				// Paid amounts come from the seeded submissions below, through the same payout path.
				paid: 0,
				reviewWindowSeconds: 72 * 3600,
				createdAgo: (i + 2) * 86400,
			}),
		);
	}

	// Earnings history lives in the gig store (mock/gigs.ts), seeded on first use.
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
export const HOLDBACK_BPS = 3000;
export const HOLDBACK_WINDOW_SECONDS = 120;

export function splitFor(sub: MockSubmission) {
	const role = db.roles.get(sub.roleId);
	const scout = db.profiles.get(sub.scoutWallet);
	if (!role) return null;
	return splitBounty(role.bounty, role.feeBps, role.holdbackBps, scout?.operator?.feeBps ?? 0);
}

/** accept_submission / settle_expired: pays "now", keeps "later" in the vault until the outcome or the window. */
export function payout(sub: MockSubmission, signature: string, at = Date.now()) {
	const role = db.roles.get(sub.roleId);
	const split = splitFor(sub);
	if (!role || !split) return;
	const paidNow = role.bounty - split.later;
	role.balance -= paidNow;
	role.paid += paidNow;
	role.heldBack += split.later;
	sub.status = "ACCEPTED";
	sub.settlementTx = signature;
	sub.split = split;
	sub.laterStatus = split.later > 0n ? "HELD" : "NONE";
	sub.laterReleasesAt = new Date(at + role.holdbackWindowSeconds * 1000).toISOString();
	const scout = db.profiles.get(sub.scoutWallet);
	if (scout) {
		scout.balance += split.now;
		scout.earned += split.now;
	}
	mockEvents.emit({
		type: "submission.accepted",
		roleId: role.id,
		submissionId: sub.id,
		signature,
		scout: sub.scoutWallet,
		payout: split.now.toString(),
	});
}

/** attest_outcome(advanced) or release_holdback: the held part goes to the recruiter. */
export function releaseLater(sub: MockSubmission, signature: string, advanced: boolean) {
	const role = db.roles.get(sub.roleId);
	const later = sub.split?.later ?? 0n;
	if (!role || sub.laterStatus !== "HELD") return;
	role.balance -= later;
	role.heldBack -= later;
	role.paid += later;
	sub.laterStatus = "RELEASED";
	if (advanced) sub.outcome = "ADVANCED";
	const scout = db.profiles.get(sub.scoutWallet);
	if (scout) {
		scout.balance += later;
		scout.earned += later;
		if (advanced) scout.advanced++;
	}
	mockEvents.emit({
		type: advanced ? "submission.outcome" : "submission.released",
		roleId: role.id,
		submissionId: sub.id,
		signature,
		scout: sub.scoutWallet,
		payout: later.toString(),
	});
}

/** attest_outcome(fabricated): the held part goes back to the company and the recruiter is flagged. */
export function refundLater(sub: MockSubmission, signature: string) {
	const role = db.roles.get(sub.roleId);
	const later = sub.split?.later ?? 0n;
	if (!role || sub.laterStatus !== "HELD") return;
	role.balance -= later;
	role.heldBack -= later;
	const company = db.profiles.get(role.companyWallet);
	if (company) company.balance += later;
	sub.laterStatus = "REFUNDED";
	sub.outcome = "FABRICATED";
	const scout = db.profiles.get(sub.scoutWallet);
	if (scout) scout.flagged++;
	mockEvents.emit({ type: "submission.outcome", roleId: role.id, submissionId: sub.id, signature });
}

export { inFuture };
