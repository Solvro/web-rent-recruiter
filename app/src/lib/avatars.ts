import { useQuery } from "@tanstack/react-query";

type Manifest = Record<string, string>;
const fold = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

/** Accepts { "Name": "file.png" }, { avatars: [...] } or [{ name, file|src|path }]. */
function parse(raw: unknown): Manifest {
	const out: Manifest = {};
	const list = Array.isArray(raw) ? raw : (raw as { avatars?: unknown })?.avatars;
	if (Array.isArray(list)) {
		for (const item of list as Record<string, string>[]) {
			const file = item.src ?? item.file ?? item.path ?? item.url;
			if (item.name && file) out[fold(item.name)] = file;
		}
	} else if (raw && typeof raw === "object") {
		for (const [name, file] of Object.entries(raw)) if (typeof file === "string") out[fold(name)] = file;
	}
	for (const [k, v] of Object.entries(out))
		out[k] = v.startsWith("/") || v.startsWith("http") ? v : `/avatars/${v}`;
	return out;
}

/** Avatar image for a person, from public/avatars/manifest.json when present. */
export function useAvatar(name: string) {
	const manifest = useQuery({
		queryKey: ["avatars"],
		queryFn: async () => {
			const res = await fetch("/avatars/manifest.json");
			if (!res.ok) return {};
			return parse(await res.json());
		},
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return manifest.data?.[fold(name)] ?? null;
}
