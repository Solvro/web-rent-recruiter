ALTER TABLE "gigs" ADD COLUMN "reportReason" text;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "closedReason" text;--> statement-breakpoint
ALTER TABLE "gigs" ADD COLUMN "closedAt" timestamp with time zone;