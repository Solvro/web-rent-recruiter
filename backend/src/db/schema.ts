import type { AgentReview, Criteria } from "@scout/shared";
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow();
/** Token amounts in base units (6 decimals). */
const amount = () => bigint({ mode: "bigint" }).notNull().default(sql`0`);

export const accounts = pgTable("accounts", {
	wallet: text().primaryKey(),
	kind: text().$type<"company" | "scout">().notNull(),
	displayName: text().notNull(),
	avatarUrl: text(),
	companyName: text(),
	createdAt: createdAt(),
});

export const roles = pgTable(
	"roles",
	{
		id: uuid().primaryKey().defaultRandom(),
		/** u64 used in the RoleVault PDA seeds. */
		onchainRoleId: bigserial({ mode: "number" }).notNull().unique(),
		companyWallet: text()
			.notNull()
			.references(() => accounts.wallet),
		title: text().notNull(),
		summary: text().notNull(),
		jobDescription: text().notNull(),
		criteria: jsonb().$type<Criteria>().notNull(),
		/** 16 random bytes, hex. Never leaves the backend. */
		roleSalt: text().notNull(),
		taskType: text().$type<"SOURCING" | "SCREENING_CALL">().notNull().default("SOURCING"),
		bounty: amount(),
		maxCandidates: integer().notNull(),
		reviewWindowSeconds: integer().notNull(),
		feeBps: integer().notNull(),
		autoAccept: jsonb().$type<{ enabled: boolean; threshold: number }>(),
		status: text().$type<"DRAFT" | "OPEN" | "CLOSED">().notNull().default("DRAFT"),
		roleVault: text(),
		// Cached on-chain state (indexer + poller keep these fresh).
		deposited: amount(),
		paid: amount(),
		remaining: amount(),
		acceptedCount: integer().notNull().default(0),
		pendingCount: integer().notNull().default(0),
		pipelineSummary: text(),
		/** State the summary was written for (see services/pipeline.ts). */
		pipelineSummaryKey: text(),
		createdAt: createdAt(),
	},
	(t) => [index("roles_company_idx").on(t.companyWallet), index("roles_status_idx").on(t.status)],
);

export const submissions = pgTable(
	"submissions",
	{
		id: uuid().primaryKey().defaultRandom(),
		roleId: uuid()
			.notNull()
			.references(() => roles.id),
		scoutWallet: text()
			.notNull()
			.references(() => accounts.wallet),
		candidateName: text().notNull(),
		profileUrl: text().notNull(),
		notes: text().notNull(),
		consent: boolean().notNull(),
		/** hex sha256(roleSalt + normalized profileUrl) */
		candidateHash: text().notNull(),
		onchainAddress: text(),
		/** False until the submit_candidate tx is confirmed. Unconfirmed rows are invisible. */
		confirmed: boolean().notNull().default(false),
		status: text().$type<"PENDING" | "ACCEPTED" | "REJECTED">().notNull().default("PENDING"),
		rejectReason: text().$type<"NOT_MATCHING" | "NOT_INTERESTED" | "ALREADY_IN_PIPELINE" | "OTHER">(),
		autoSettled: boolean().notNull().default(false),
		submittedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
		reviewDeadline: timestamp({ withTimezone: true, mode: "date" }).notNull(),
		settlementTx: text(),
		submitTx: text(),
	},
	(t) => [
		uniqueIndex("submissions_role_hash_uq").on(t.roleId, t.candidateHash),
		index("submissions_scout_idx").on(t.scoutWallet),
	],
);

export const agentReviews = pgTable("agent_reviews", {
	submissionId: uuid()
		.primaryKey()
		.references(() => submissions.id),
	review: jsonb().$type<AgentReview>().notNull(),
	createdAt: createdAt(),
});

export const txLog = pgTable(
	"tx_log",
	{
		signature: text().primaryKey(),
		kind: text().notNull(),
		wallet: text(),
		roleId: uuid(),
		submissionId: uuid(),
		processed: boolean().notNull().default(false),
		createdAt: createdAt(),
	},
	(t) => [index("tx_log_role_idx").on(t.roleId)],
);
