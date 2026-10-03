ALTER TABLE "submissions" ADD COLUMN "followUps" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "updatedAt" timestamp with time zone;