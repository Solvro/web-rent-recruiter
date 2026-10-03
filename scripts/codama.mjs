// Generates a typed @solana/kit client for the app from the Anchor IDL.
// Run after `anchor build`: pnpm codegen

import { readFileSync } from "node:fs";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import renderVisitor from "@codama/renderers-js";
import { createFromRoot } from "codama";

const idl = JSON.parse(readFileSync(new URL("../target/idl/scout.json", import.meta.url), "utf-8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));

await codama.accept(
	renderVisitor(new URL("../packages/shared", import.meta.url).pathname, {
		generatedFolder: "src/generated",
	}),
);
