import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useWallet } from "./wallet";

/** Every key is scoped to the active wallet so switching persona never shows another account's data. */
export function useMe() {
	const { address } = useWallet();
	return useQuery({ queryKey: ["me", address], queryFn: api.me, enabled: !!address });
}

export function useRoles() {
	const { address } = useWallet();
	return useQuery({ queryKey: ["roles", address], queryFn: api.roles, enabled: !!address });
}

export function useRole(id: string) {
	const { address } = useWallet();
	return useQuery({
		queryKey: ["role", address, id],
		queryFn: () => api.role(id),
		enabled: !!address,
		refetchInterval: 10_000,
	});
}

export function useTasks() {
	const { address } = useWallet();
	return useQuery({ queryKey: ["tasks", address], queryFn: api.tasks });
}

export function useMySubmissions() {
	const { address } = useWallet();
	return useQuery({
		queryKey: ["submissions", address],
		queryFn: api.mySubmissions,
		enabled: !!address,
		refetchInterval: 8_000,
	});
}

export function useScout(pubkey: string) {
	return useQuery({ queryKey: ["scout", pubkey], queryFn: () => api.scout(pubkey) });
}
