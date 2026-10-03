CREATE TABLE "company_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"roleId" uuid NOT NULL,
	"candidateId" uuid NOT NULL,
	"text" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "passedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "withdrawn" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "company_notes_candidate_idx" ON "company_notes" ("candidateId");--> statement-breakpoint
ALTER TABLE "company_notes" ADD CONSTRAINT "company_notes_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");