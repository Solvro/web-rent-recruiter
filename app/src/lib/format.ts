import { BPS_DENOMINATOR, fromBaseUnits } from "@scout/shared";

const usdcFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** "18 USDC" from base units. */
export function formatUsdc(base: bigint | number | string, { unit = true } = {}) {
	const value = usdcFormat.format(fromBaseUnits(base));
	return unit ? `${value} USDC` : value;
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
	const sec = s % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
	return `${sec}s`;
}

export function reviewWindowLabel(seconds: number) {
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
