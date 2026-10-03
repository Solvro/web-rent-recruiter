CREATE TABLE "pending_cosigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"roleId" uuid NOT NULL,
	"gigId" uuid,
	"submissionId" uuid,
	"kind" text NOT NULL,
	"gatekeeper" text NOT NULL,
	"transaction" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"signature" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "agentPubkey" text;--> statement-breakpoint
CREATE INDEX "pending_cosigns_role_idx" ON "pending_cosigns" ("roleId","status");--> statement-breakpoint
ALTER TABLE "pending_cosigns" ADD CONSTRAINT "pending_cosigns_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");