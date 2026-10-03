/**
 * Link previews for candidate links (/c/<token>): chat apps read only the static HTML head, so the candidate would
 * see the company pitch. This rewrites the head for /c/* in dev and in `vite preview` with a candidate-facing
 * title and description ("Karolina, a role at Kelp Labs"). Unknown tokens (mock mode) get a neutral line.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Connect, Plugin } from "vite";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

type View = { candidateFirstName: string; recruiterName: string; roleTitle: string; companyDescriptor: string };

async function lookup(backend: string, token: string): Promise<View | null> {
	try {
		const input = encodeURIComponent(JSON.stringify({ json: { token } }));
		const res = await fetch(`${backend}/trpc/candidate.view?input=${input}`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return null;
		const body = (await res.json()) as { result?: { data?: { json?: View } } };
		return body.result?.data?.json ?? null;
	} catch {
		return null;
	}
}

async function headFor(backend: string, path: string) {
	const token = path.match(/^\/c\/([^/?#]+)/)?.[1];
	if (!token) return null;
	const v = await lookup(backend, token);
	const title = v ? `${v.candidateFirstName}, a role at ${v.companyDescriptor}` : "A role shared with you";
	const description = v
		? `${v.recruiterName.split(" ")[0]} thinks the ${v.roleTitle} role could fit you. Open to say if you're interested.`
		: "A recruiter thinks this role could fit you. Open to say if you're interested.";
	return { title: `${title} · Scout`, description };
}

function rewrite(html: string, head: { title: string; description: string }) {
	const t = esc(head.title);
	const d = esc(head.description);
	return html
		.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
		.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${d}" />`)
		.replace(
			"</head>",
			`<meta property="og:title" content="${t}" />\n\t\t<meta property="og:description" content="${d}" />\n\t</head>`,
		);
}

export function candidateHead(backend: string): Plugin {
	return {
		name: "candidate-head",
		async transformIndexHtml(html, ctx) {
			const head = await headFor(backend, ctx.originalUrl ?? ctx.path);
			return head ? rewrite(html, head) : html;
		},
		configurePreviewServer(server) {
			const handler: Connect.NextHandleFunction = (req, res, next) => {
				if (req.method !== "GET" || !req.url?.startsWith("/c/")) return next();
				void (async () => {
					const head = await headFor(backend, req.url ?? "");
					if (!head) return next();
					const html = await readFile(resolve(server.config.root, server.config.build.outDir, "index.html"), "utf8");
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(rewrite(html, head));
				})().catch(next);
			};
			server.middlewares.use(handler);
		},
	};
}
