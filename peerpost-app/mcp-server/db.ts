import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";

// The MCP server shares PeerPost's Postgres (and Drizzle schema). Its own
// connection so it can run as a standalone process next to the Next app.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const client = postgres(url, { prepare: false });
export const db = drizzle(client, { schema });
export { schema };
