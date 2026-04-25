import { createKey } from "../src/db.ts";

const label = process.argv[2] ?? "admin-seed";
const credits = Number(process.argv[3] ?? process.env.DEFAULT_INITIAL_CREDITS ?? 1000);

const k = createKey(label, credits);

console.log("---");
console.log("API key created. SAVE THIS NOW — it will not be shown again:");
console.log("");
console.log(`  ${k.plain}`);
console.log("");
console.log(`  id:      ${k.id}`);
console.log(`  label:   ${k.label}`);
console.log(`  credits: ${k.credits}`);
console.log("---");
