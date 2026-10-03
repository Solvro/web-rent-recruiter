CREATE TABLE "agent_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"roleId" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"result" text,
	"decidedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_proposals_role_idx" ON "agent_proposals" ("roleId","status");--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id");