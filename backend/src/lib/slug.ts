import { eq, isNull } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";

/** "Ola Wiśniewska" → "ola-wisniewska" (diacritics folded, incl. Polish ł). */
export function slugify(name: string): string {
	const s = name
		.replace(/[łŁ]/g, "l")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "user";
}

/** First free slug for `name` ("x", "x-2", "x-3", …), ignoring the row that already owns it. */
export async function uniqueSlug(db: Db, name: string, wallet: string): Promise<string> {
	const base = slugify(name);
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? base : `${base}-${n}`;
		const [owner] = await db
			.select({ wallet: schema.accounts.wallet })
			.from(schema.accounts)
			.where(eq(schema.accounts.slug, candidate));
		if (!owner || owner.wallet === wallet) return candidate;
	}
}

/** Give every account without a slug one (idempotent; runs at startup after migrations). */
export async function backfillSlugs(db: Db) {
	const rows = await db.select().from(schema.accounts).where(isNull(schema.accounts.slug));
	for (const r of rows) {
		const slug = await uniqueSlug(db, r.displayName, r.wallet);
		await db.update(schema.accounts).set({ slug }).where(eq(schema.accounts.wallet, r.wallet));
	}
	return rows.length;
}
