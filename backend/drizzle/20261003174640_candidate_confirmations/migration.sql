CREATE TABLE "candidate_confirmations" (
	"tokenHash" text PRIMARY KEY,
	"submissionId" uuid NOT NULL UNIQUE,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"answers" jsonb,
	"proofHash" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"respondedAt" timestamp with time zone,
	"link" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "candidate_confirmations_status_idx" ON "candidate_confirmations" ("status","expiresAt");--> statement-breakpoint
ALTER TABLE "candidate_confirmations" ADD CONSTRAINT "candidate_confirmations_submissionId_submissions_id_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id");