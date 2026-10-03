CREATE TABLE "agent_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"roleId" uuid NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"gigId" uuid,
	"deliverableId" uuid,
	"signature" text,
	"data" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"gigId" uuid NOT NULL,
	"wallet" text NOT NULL,
	"claimedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"releasedAt" timestamp with time zone,
	"tx" text
);
--> statement-breakpoint
CREATE TABLE "gigs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"roleId" uuid NOT NULL,
	"onchainTaskId" integer NOT NULL,
	"taskAddress" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"script" jsonb,
	"briefHash" text NOT NULL,
	"bounty" bigint NOT NULL,
	"maxDeliverables" integer NOT NULL,
	"exclusive" boolean NOT NULL,
	"holdbackBps" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"postWhen" text DEFAULT 'now' NOT NULL,
	"aboutCandidateId" uuid,
	"claimantWallet" text,
	"claimedAt" timestamp with time zone,
	"acceptedCount" integer DEFAULT 0 NOT NULL,
	"pendingCount" integer DEFAULT 0 NOT NULL,
	"createTx" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shortlist" (
	"roleId" uuid NOT NULL,
	"candidateId" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" integer,
	"agentNote" text NOT NULL,
	"screening" jsonb,
	"reference" jsonb,
	"decision" text DEFAULT 'NONE' NOT NULL,
	"decidedAt" timestamp with time zone,
	"decisionTx" text,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "agentManaged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "agentStatus" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "gigId" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "deliverableType" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "aboutCandidateId" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "agentReview" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "agentLockedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_activity_role_idx" ON "agent_activity" ("roleId","createdAt");--> statement-breakpoint
CREATE INDEX "claims_gig_idx" ON "claims" ("gigId");--> statement-breakpoint
CREATE UNIQUE INDEX "gigs_role_task_uq" ON "gigs" ("roleId","onchainTaskId");--> statement-breakpoint
CREATE INDEX "gigs_status_idx" ON "gigs" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "shortlist_role_candidate_uq" ON "shortlist" ("roleId","candidateId");--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_gigId_gigs_id_fkey" FOREIGN KEY ("gigId") REFERENCES "gigs"("id");--> statement-breakpoint
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "shortlist" ADD CONSTRAINT "shortlist_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");