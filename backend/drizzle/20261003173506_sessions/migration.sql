CREATE TABLE "sessions" (
	"tokenHash" text PRIMARY KEY,
	"wallet" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sessions_wallet_idx" ON "sessions" ("wallet");