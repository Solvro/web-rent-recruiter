import type { Me } from "@scout/shared";

export type PersonaId = "company" | "scout" | "scout2";

export type Persona = {
	id: PersonaId;
	kind: Me["kind"];
	displayName: string;
	companyName?: string;
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
		companyName: "Seed-stage Solana DeFi startup · Warsaw",
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
