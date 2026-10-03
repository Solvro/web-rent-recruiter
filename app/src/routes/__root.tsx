import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useLocation } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/bits";
import { buttonVariants } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	component: Root,
	errorComponent: () => (
		<EmptyState
			title="Something went wrong."
			action={
				<button
					type="button"
					className={buttonVariants({ variant: "outline" })}
					onClick={() => location.reload()}
				>
					Reload
				</button>
			}
		/>
	),
	notFoundComponent: () => (
		<EmptyState
			title="Page not found."
			action={
				<Link to="/" className={buttonVariants({ variant: "outline" })}>
					Go home
				</Link>
			}
		/>
	),
});

/** Candidate links (/c/…) are a bare page: no app header, no accounts. */
function Root() {
	const bare = useLocation({ select: (l) => l.pathname.startsWith("/c/") });
	return (
		<TooltipProvider>
			{bare ? (
				<Outlet />
			) : (
				<AppShell>
					<Outlet />
				</AppShell>
			)}
			<Toaster position="bottom-center" />
		</TooltipProvider>
	);
}
