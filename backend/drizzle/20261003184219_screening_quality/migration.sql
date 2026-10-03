CREATE TABLE "candidate_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"profileKey" text NOT NULL,
	"kind" text NOT NULL,
	"roleId" uuid NOT NULL,
	"submissionId" uuid,
	"gigId" uuid,
	"byWallet" text NOT NULL,
	"reason" text NOT NULL,
	"resolvedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "timeZone" text;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "noShows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "reported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "aboutGigId" uuid;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "showUpFee" bigint;--> statement-breakpoint
CREATE INDEX "candidate_flags_key_idx" ON "candidate_flags" ("profileKey","kind");