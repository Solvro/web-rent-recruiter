CREATE TABLE "recruiter_seeded_stats" (
	"wallet" text NOT NULL,
	"gigType" text NOT NULL,
	"accepted" integer NOT NULL,
	"decided" integer NOT NULL,
	"advanced" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT 'seeded demo history' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recruiter_skills" (
	"wallet" text NOT NULL,
	"skill" text NOT NULL,
	"source" text NOT NULL,
	"verifiedBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recruiter_seeded_stats_uq" ON "recruiter_seeded_stats" ("wallet","gigType");--> statement-breakpoint
CREATE UNIQUE INDEX "recruiter_skills_uq" ON "recruiter_skills" ("wallet","skill","source");