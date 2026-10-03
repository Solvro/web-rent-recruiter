#!/usr/bin/env node
// scout-agent: runs the TypeScript sources through tsx (no build step).
import { register } from "tsx/esm/api";

register();
await import("../src/remote/cli.ts");
