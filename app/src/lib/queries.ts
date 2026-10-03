import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";
import { useWallet } from "./wallet";

/**
 * Read hooks over the tRPC router. Query keys don't include the account, so the wallet layer resets the cache
 * whenever the account changes; `enabled` keeps account-only queries quiet while logged out.
 */
export function useMe() {
	const trpc = useTRPC();
	const { address } = useWallet();
	return useQuery(trpc.me.get.queryOptions(undefined, { enabled: !!address }));
}

export function useRoles() {
	const trpc = useTRPC();
	const { address } = useWallet();
	return useQuery(trpc.roles.list.queryOptions(undefined, { enabled: !!address }));
}

export function useRole(id: string) {
	const trpc = useTRPC();
	const { address } = useWallet();
	return useQuery(trpc.roles.byId.queryOptions({ id }, { enabled: !!address, refetchInterval: 10_000 }));
}

export function useTasks() {
	const trpc = useTRPC();
	return useQuery(trpc.tasks.list.queryOptions());
}

export function useMySubmissions() {
	const trpc = useTRPC();
	const { address } = useWallet();
	return useQuery(
		trpc.submissions.mine.queryOptions(undefined, { enabled: !!address, refetchInterval: 8_000 }),
	);
}

/** A recruiter's public profile, by wallet (inside the app) or by slug (/r/<slug> links). */
export function useScout(by: { wallet: string } | { slug: string }) {
	const trpc = useTRPC();
	const key = "wallet" in by ? by.wallet : by.slug;
	return useQuery(trpc.scouts.profile.queryOptions(by, { enabled: !!key }));
}
