CREATE TABLE "accounts" (
	"wallet" text PRIMARY KEY,
	"kind" text NOT NULL,
	"displayName" text NOT NULL,
	"avatarUrl" text,
	"companyName" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_reviews" (
	"submissionId" uuid PRIMARY KEY,
	"review" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"onchainRoleId" bigserial UNIQUE,
	"companyWallet" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"jobDescription" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"roleSalt" text NOT NULL,
	"taskType" text DEFAULT 'SOURCING' NOT NULL,
	"bounty" bigint DEFAULT 0 NOT NULL,
	"maxCandidates" integer NOT NULL,
	"reviewWindowSeconds" integer NOT NULL,
	"feeBps" integer NOT NULL,
	"autoAccept" jsonb,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"roleVault" text,
	"deposited" bigint DEFAULT 0 NOT NULL,
	"paid" bigint DEFAULT 0 NOT NULL,
	"remaining" bigint DEFAULT 0 NOT NULL,
	"acceptedCount" integer DEFAULT 0 NOT NULL,
	"pendingCount" integer DEFAULT 0 NOT NULL,
	"pipelineSummary" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"roleId" uuid NOT NULL,
	"scoutWallet" text NOT NULL,
	"candidateName" text NOT NULL,
	"profileUrl" text NOT NULL,
	"notes" text NOT NULL,
	"consent" boolean NOT NULL,
	"candidateHash" text NOT NULL,
	"onchainAddress" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"rejectReason" text,
	"autoSettled" boolean DEFAULT false NOT NULL,
	"submittedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewDeadline" timestamp with time zone NOT NULL,
	"settlementTx" text,
	"submitTx" text
);
--> statement-breakpoint
CREATE TABLE "tx_log" (
	"signature" text PRIMARY KEY,
	"kind" text NOT NULL,
	"wallet" text,
	"roleId" uuid,
	"submissionId" uuid,
	"processed" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "roles_company_idx" ON "roles" ("companyWallet");--> statement-breakpoint
CREATE INDEX "roles_status_idx" ON "roles" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_role_hash_uq" ON "submissions" ("roleId","candidateHash");--> statement-breakpoint
CREATE INDEX "submissions_scout_idx" ON "submissions" ("scoutWallet");--> statement-breakpoint
CREATE INDEX "tx_log_role_idx" ON "tx_log" ("roleId");--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_submissionId_submissions_id_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_companyWallet_accounts_wallet_fkey" FOREIGN KEY ("companyWallet") REFERENCES "accounts"("wallet");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_scoutWallet_accounts_wallet_fkey" FOREIGN KEY ("scoutWallet") REFERENCES "accounts"("wallet");