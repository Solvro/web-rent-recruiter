ALTER TABLE "roles" ADD COLUMN "bondsForfeited" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "bondForfeited" bigint;