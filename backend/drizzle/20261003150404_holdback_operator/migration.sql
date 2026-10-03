ALTER TABLE "roles" ADD COLUMN "holdbackBps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "holdbackWindowSeconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "heldBack" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "screeningNotes" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "evidenceHash" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "operatorFeeBps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "payoutNow" bigint;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "payoutLater" bigint;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "operatorFee" bigint;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "platformFee" bigint;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "holdbackDeadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "outcome" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "laterStatus" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "laterTx" text;