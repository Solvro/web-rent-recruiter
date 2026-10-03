import { PersonAvatar } from "@/components/bits";
import { useAvatar } from "@/lib/avatars";

/** Avatar for a person by name: explicit URL from the API first, then the shared manifest, then initials. */
export function Avatar({
	name,
	src,
	size,
}: {
	name: string;
	src?: string | null;
	size?: "xs" | "sm" | "md" | "lg";
}) {
	const fromManifest = useAvatar(name);
	return <PersonAvatar name={name} src={src ?? fromManifest} size={size} />;
}
