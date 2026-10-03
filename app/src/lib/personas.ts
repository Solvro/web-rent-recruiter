import type { Me } from "@scout/shared";

export type PersonaId = "company" | "scout" | "scout2";

export type Persona = {
	id: PersonaId;
	kind: Me["kind"];
	displayName: string;
	companyName?: string;
	role: string;
	/** Address used by the mock API. Demo mode derives the real one from the keypair. */
	mockAddress: string;
};

export const PERSONAS: Record<PersonaId, Persona> = {
	company: {
		id: "company",
		kind: "company",
		displayName: "Hanna Lewicka",
		companyName: "Northwind Robotics",
		role: "Head of Talent, Northwind Robotics",
		mockAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
	},
	scout: {
		id: "scout",
		kind: "scout",
		displayName: "Marta Zielińska",
		role: "Independent tech recruiter, Kraków",
		mockAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
	},
	scout2: {
		id: "scout2",
		kind: "scout",
		displayName: "Jonas Weber",
		role: "Freelance sourcer, Berlin",
		mockAddress: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
	},
};
