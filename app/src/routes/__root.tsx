import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/bits";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	component: () => (
		<TooltipProvider>
			<AppShell>
				<Outlet />
			</AppShell>
			<Toaster position="bottom-center" />
		</TooltipProvider>
	),
	notFoundComponent: () => (
		<EmptyState
			title="Page not found"
			action={
				<Link to="/" className="text-sm text-primary hover:underline">
					Back to the start
				</Link>
			}
		>
			The link may be outdated, or the role was closed.
		</EmptyState>
	),
});
