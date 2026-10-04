import { PROJECT_NAME } from "@scout/shared";
import { useEffect } from "react";

const DEFAULT_TITLE = `${PROJECT_NAME} · your hiring agent`;

/** "Gigs · RentRecruiter" while the page is open; back to the default title after. */
export function useTitle(title: string | null | undefined) {
	useEffect(() => {
		document.title = title ? `${title} · ${PROJECT_NAME}` : DEFAULT_TITLE;
		return () => {
			document.title = DEFAULT_TITLE;
		};
	}, [title]);
}
