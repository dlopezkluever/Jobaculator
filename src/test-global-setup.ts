import { fileURLToPath } from "node:url";
import { prepareTemplateDatabase } from "./packages/db/testing";

export default async function setup() {
	await prepareTemplateDatabase(fileURLToPath(new URL("../drizzle", import.meta.url)));
}
