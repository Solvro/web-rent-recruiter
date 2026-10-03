ALTER TABLE "accounts" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_slug_key" UNIQUE("slug");