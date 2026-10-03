import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { backoff, isTransient } from "@/lib/connection";
import { makeTRPCClient, TRPCProvider } from "@/lib/trpc";
import { WalletProvider } from "@/lib/wallet";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5_000,
			refetchOnWindowFocus: false,
			// A restarting backend is retried quietly (with backoff) until it answers; real errors fail after one retry.
			retry: (count, e) => isTransient(e) || count < 1,
			retryDelay: (attempt) => backoff(attempt + 1),
		},
	},
});

const trpcClient = makeTRPCClient();

const router = createRouter({
	routeTree,
	context: { queryClient },
	defaultPreload: "intent",
	scrollRestoration: true,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
				<WalletProvider>
					<RouterProvider router={router} />
				</WalletProvider>
			</TRPCProvider>
		</QueryClientProvider>
	</StrictMode>,
);
