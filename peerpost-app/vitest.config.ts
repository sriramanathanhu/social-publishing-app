import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// db/index.ts reads DATABASE_URL at import; postgres() is lazy (no connect),
		// so a dummy URL lets modules load for pure-logic tests.
		env: { DATABASE_URL: "postgres://test:test@localhost:5432/test" },
	},
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
});
