import { Languages, type LucideIcon, MessagesSquare, PhoneCall, UserSearch } from "lucide-react";
import type { GigType, GigView } from "./gigs/schemas";

/**
 * What a recruiter sees as a type. LANGUAGE_CHECK is a SCREENING_CALL on-chain with a different script
 * (GigView.variant "language"): the agent composes new gigs without new contracts.
 */
export type GigKind = GigType | "LANGUAGE_CHECK";

export type GigTypeInfo = {
	kind: GigKind;
	/** The on-chain gig type behind this kind */
	type: GigType;
	icon: LucideIcon;
	/** Tab / chip label */
	name: string;
	/** One line: what you do */
	does: string;
	/** What you send to the agent */
	deliver: string;
	/** Typical time spent */
	time: string;
	/** "per profile" — used in pay lines */
	unit: string;
	/** One recruiter takes it (screening, reference) vs. open to many (sourcing) */
	exclusive: boolean;
	/** CTA on the card */
	action: string;
};

/** The one source of truth for gig types: board tabs, cards, forms and explainers read from here. */
export const GIG_TYPES: Record<GigKind, GigTypeInfo> = {
	SOURCING: {
		kind: "SOURCING",
		type: "SOURCING",
		icon: UserSearch,
		name: "Find candidates",
		does: "Find people who match the role",
		deliver: "Profile link and a short note",
		time: "About 5 minutes per profile",
		unit: "per profile",
		exclusive: false,
		action: "Add candidates",
	},
	SCREENING_CALL: {
		kind: "SCREENING_CALL",
		type: "SCREENING_CALL",
		icon: PhoneCall,
		name: "Screening call",
		does: "30-minute call with a candidate, using the agent's questions",
		deliver: "An answer to each question and your recommendation",
		time: "About 45 minutes",
		unit: "per call",
		exclusive: true,
		action: "Take gig",
	},
	LANGUAGE_CHECK: {
		kind: "LANGUAGE_CHECK",
		type: "SCREENING_CALL",
		icon: Languages,
		name: "Language check",
		does: "15-minute call to check a candidate's language level",
		deliver: "An answer to each question and the level you heard",
		time: "About 20 minutes",
		unit: "per check",
		exclusive: true,
		action: "Take gig",
	},
	REFERENCE_CHECK: {
		kind: "REFERENCE_CHECK",
		type: "REFERENCE_CHECK",
		icon: MessagesSquare,
		name: "Reference check",
		does: "Call a former manager of the finalist",
		deliver: "Answers to the agent's questions",
		time: "About 30 minutes",
		unit: "per check",
		exclusive: true,
		action: "Take gig",
	},
};

export const GIG_TYPE_ORDER: GigKind[] = ["SOURCING", "SCREENING_CALL", "LANGUAGE_CHECK", "REFERENCE_CHECK"];

/** A gig's kind: language checks are screening calls with the "language" variant. */
export function kindOf(gig: Pick<GigView, "type" | "variant">): GigKind {
	return gig.type === "SCREENING_CALL" && gig.variant === "language" ? "LANGUAGE_CHECK" : gig.type;
}

/** How long an exclusive gig stays yours after taking it. */
export const CLAIM_HOURS = 24;
