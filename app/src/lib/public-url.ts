/**
 * Where candidate links (/c/<token>) point. On stage the candidate opens the link on a real phone, which can't
 * reach localhost: the public base (a tunnel, or the deployed app) comes from `?public=https://…` (remembered),
 * then VITE_PUBLIC_APP_URL, then this page's own origin.
 */
const KEY = "scout.public-url";

function readOverride(): string | null {
	try {
		const param = new URLSearchParams(location.search).get("public");
		if (param === "off") localStorage.removeItem(KEY);
		else if (param && /^https?:\/\/\S+$/.test(param)) localStorage.setItem(KEY, param.replace(/\/$/, ""));
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

const BASE = (readOverride() ?? import.meta.env.VITE_PUBLIC_APP_URL ?? location.origin).replace(/\/$/, "");

export const publicBase = () => BASE;

/** The same candidate link on the public base ("http://localhost:5173/c/x" → "https://….trycloudflare.com/c/x"). */
export function publicLink(url: string): string;
export function publicLink(url: string | null | undefined): string | null;
export function publicLink(url: string | null | undefined) {
	if (!url) return url ?? null;
	const path = url.match(/\/c\/[^?#\s]+.*$/)?.[0];
	return path ? `${BASE}${path}` : url;
}
