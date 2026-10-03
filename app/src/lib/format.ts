import { BPS_DENOMINATOR, fromBaseUnits } from "@scout/shared";

/** "$18", "$13.50": money is shown as plain dollars everywhere. */
export function formatMoney(base: bigint | number | string) {
	const value = fromBaseUnits(base);
	return value.toLocaleString("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
		maximumFractionDigits: 2,
	});
}

/** Agent text from the backend quotes amounts as "20 USDC"; show them as "$20". */
export function plainMoney(text: string) {
	return text.replace(/(\d[\d,]*(?:\.\d+)?)\s*USDC\b/g, "$$$1").replace(/\bUSDC\b/g, "dollars");
}

export function netOfFee(bounty: bigint | string, feeBps: number) {
	const b = BigInt(bounty);
	return b - (b * BigInt(feeBps)) / BigInt(BPS_DENOMINATOR);
}

export function pct(part: bigint | string, whole: bigint | string) {
	const w = Number(BigInt(whole));
	return w === 0 ? 0 : Math.min(100, (Number(BigInt(part)) / w) * 100);
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function timeAgo(iso: string) {
	const diff = (new Date(iso).getTime() - Date.now()) / 1000;
	const abs = Math.abs(diff);
	if (abs < 60) return rtf.format(Math.round(diff), "second");
	if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
	return rtf.format(Math.round(diff / 86400), "day");
}

export function formatDuration(seconds: number) {
	const s = Math.max(0, Math.floor(seconds));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

export function reviewWindowLabel(seconds: number) {
	if (seconds === 60) return "1 minute";
	if (seconds < 120) return `${seconds} seconds`;
	if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
	if (seconds < 172800) return `${Math.round(seconds / 3600)} hours`;
	return `${Math.round(seconds / 86400)} days`;
}

export function initials(name: string) {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase())
		.join("");
}

export function hostOf(url: string) {
	try {
		const u = new URL(url);
		return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
	} catch {
		return url;
	}
}

/** "Ola Wiśniewska" → "ola-wisniewska", for /r/<slug> profile links. */
export function slugify(name: string) {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ł/g, "l")
		.replace(/Ł/g, "L")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export const firstName = (name: string) => name.split(" ")[0] ?? name;

/** "3 Oct, 14:05" */
export function dateLabel(date: Date | string) {
	return new Date(date).toLocaleString("en-GB", {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** The candidate a call gig is about, from its title ("30-min screening call with Karolina Mazurek"). */
export function personInTitle(title: string) {
	const m = title.match(/\b(?:with|for)\s+([\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+)+)\s*(?:[:(·].*)?$/u);
	return m?.[1] ?? title;
}
