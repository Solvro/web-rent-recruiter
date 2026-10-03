/**
 * The pasted job description the job post is built over. It is rendered exactly as it was typed (same wrapping as
 * the textarea it came from) and never moves: it only changes colour. The post covers it from the top down (see
 * Curtain); below the curtain the sentence the agent is about to use is softly highlighted, used sentences go
 * quieter, and when the post is done what's left fades out.
 */
import type { Ref } from "react";
import { cn } from "@/lib/utils";
import "./role-draft.css";

const STOP = new Set(
	"the and for with you our are your will that this from have has into about who what work team role able plus years year experience strong good great".split(
		" ",
	),
);

const words = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.split(/[^a-z0-9+#.]+/)
		.filter((w) => w.length > 2 && !STOP.has(w));

/** Lines → sentences, keeping each line's bullets/headings as their own unit. */
export function splitSentences(text: string): string[][] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()) ?? [line]);
}

/** Index (flat) of the sentence that best matches a piece of extracted text, or -1. */
export function bestSentence(sentences: string[], text: string): number {
	const target = new Set(words(text));
	if (target.size === 0) return -1;
	let best = -1;
	let bestScore = 0;
	sentences.forEach((s, i) => {
		const ws = words(s);
		if (!ws.length) return;
		const hits = ws.filter((w) => target.has(w)).length;
		const score = hits / Math.sqrt(ws.length);
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	});
	return bestScore > 0 ? best : -1;
}

const SENTENCE = /[^.!?]+[.!?]+(?=\s|$)\s*|[^.!?]+$/g;

export function JdBackdrop({
	ref,
	text,
	active,
	used,
	quiet,
	hidden,
	className,
}: {
	ref?: Ref<HTMLDivElement>;
	text: string;
	/** Flat sentence index being read now (-1: none), as in `splitSentences(text).flat()`. */
	active: number;
	/** Flat sentence indices already turned into fields. */
	used: Set<number>;
	/** The post has started: the text steps back into a low-contrast backdrop. */
	quiet: boolean;
	/** The post is done: fade out. */
	hidden: boolean;
	className?: string;
}) {
	// Same sentence numbering as splitSentences (trimmed, non-empty lines), but keeping every character so the text
	// wraps exactly as it did in the textarea.
	let n = 0;
	const lines = text.split(/\r?\n/);
	return (
		<div
			ref={ref}
			aria-hidden
			className={cn(
				"rd-backdrop pointer-events-none select-none whitespace-pre-wrap break-words",
				// Faded out, then out of layout: a long posting must not leave empty scroll under the finished post.
				hidden && "invisible max-h-0 overflow-hidden opacity-0",
				className,
			)}
		>
			{lines.map((line, li) => {
				const trimmed = line.trim();
				const lead = line.slice(0, line.length - line.trimStart().length);
				const parts = trimmed ? (trimmed.match(SENTENCE) ?? [trimmed]) : [];
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: the text is static while it is being read
					<span key={li}>
						{lead}
						{parts.map((part) => {
							const i = n++;
							const body = part.trimEnd();
							return (
								<span key={i}>
									<span
										data-sentence={i}
										className={cn(
											"rd-sentence box-decoration-clone",
											quiet ? "text-muted-foreground" : "text-foreground",
											used.has(i) && "text-muted-foreground/50",
											i === active && !used.has(i) && "bg-primary/10 text-foreground",
										)}
									>
										{body}
									</span>
									{part.slice(body.length)}
								</span>
							);
						})}
						{li < lines.length - 1 && "\n"}
					</span>
				);
			})}
		</div>
	);
}
