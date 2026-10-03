import type { Me } from "@scout/shared";

export type PersonaId = "company" | "scout" | "scout2";

export type Persona = {
	id: PersonaId;
	kind: Me["kind"];
	displayName: string;
	companyName?: string;
	companyDescription?: string;
	/** Plain label in the account switcher. */
	role: "Company" | "Recruiter";
	/** Identity used by the mock API. Demo mode against the real API derives it from the demo key. */
	mockAddress: string;
};

/** Names follow docs/research/demo-use-cases.json so mock and live demos tell the same story. */
export const PERSONAS: Record<PersonaId, Persona> = {
	company: {
		id: "company",
		kind: "company",
		displayName: "Hanna Lewicka",
		companyName: "Wisła Labs",
		/** How the company describes itself to recruiters and candidates. */
		companyDescription: "Seed-stage DeFi startup, Warsaw",
		role: "Company",
		mockAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
	},
	scout: {
		id: "scout",
		kind: "scout",
		displayName: "Ola Wiśniewska",
		role: "Recruiter",
		mockAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
	},
	scout2: {
		id: "scout2",
		kind: "scout",
		displayName: "Lucía Fernández",
		role: "Recruiter",
		mockAddress: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
	},
};

export const PERSONA_STORAGE_KEY = "scout.persona";

/** Pick the demo account before switching to demo mode, so the switch lands signed in instead of on another gate. */
export function rememberPersona(id: PersonaId) {
	try {
		localStorage.setItem(PERSONA_STORAGE_KEY, id);
	} catch {
		// private mode: the gate asks once more
	}
}
