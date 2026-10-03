ALTER TABLE "roles" ADD COLUMN "companyLabel" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "intendedDeposit" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "refunded" bigint DEFAULT 0 NOT NULL;