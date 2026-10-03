import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/** Query keys are account-agnostic, so switching account must drop everything cached for the previous one. */
export function useResetOnAccountChange(address: string | null) {
	const qc = useQueryClient();
	const previous = useRef(address);
	useEffect(() => {
		if (previous.current === address) return;
		previous.current = address;
		void qc.resetQueries();
	}, [address, qc]);
}
