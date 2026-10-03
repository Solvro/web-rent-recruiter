import type { CandidateInfo } from "@scout/shared";
import manifest from "../../../public/avatars/manifest.json";

/** Fictional demo people; avatar paths come from public/avatars/manifest.json (same paths the backend serves). */
const INFO: Record<string, Omit<CandidateInfo, "avatarUrl">> = {
	"Karolina Mazurek": {
		currentTitle: "Senior Protocol Engineer",
		currentCompany: "a DeFi lending protocol",
		location: "Warsaw",
	},
	"Tomasz Brzeziński": {
		currentTitle: "Senior Rust Engineer",
		currentCompany: "an HFT trading firm",
		location: "Warsaw",
	},
	"Piotr Lewandowski": {
		currentTitle: "Frontend Developer",
		currentCompany: "a trading app startup",
		location: "Gdańsk",
	},
	"Marek Zieliński": {
		currentTitle: "Founding Engineer",
		currentCompany: "a computer-vision startup",
		location: "Munich",
	},
	"Julia Kowalska": {
		currentTitle: "Solutions Engineer",
		currentCompany: "an IoT platform",
		location: "Zürich",
	},
	"Lukas Brandt": {
		currentTitle: "Account Executive",
		currentCompany: "a facility-management SaaS",
		location: "Kraków",
	},
};

const fold = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
const byFold = <T>(rec: Record<string, T>) => new Map(Object.entries(rec).map(([k, v]) => [fold(k), v]));
const AVATARS = byFold(manifest as Record<string, string>);
const INFO_BY_NAME = byFold(INFO);

export function avatarFor(name: string): string | null {
	return AVATARS.get(fold(name)) ?? null;
}

export function candidateInfo(name: string): CandidateInfo {
	return {
		avatarUrl: avatarFor(name),
		currentTitle: INFO_BY_NAME.get(fold(name))?.currentTitle ?? null,
		currentCompany: INFO_BY_NAME.get(fold(name))?.currentCompany ?? null,
		location: INFO_BY_NAME.get(fold(name))?.location ?? null,
	};
}
