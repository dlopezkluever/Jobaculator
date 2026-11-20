import { createHash } from "node:crypto";
import { z } from "zod";

type Json = Record<string, unknown>;

/** The provider-neutral JSON Schema of a structured output (draft 2020-12, output side). */
export function canonicalSchema(schema: z.ZodType): Json {
	const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "output", unrepresentable: "throw" }) as Json;
	return json;
}

/** Stable short hash of a canonical schema: part of a failure's fingerprint. */
export function schemaHash(json: Json): string {
	return createHash("sha256").update(stableStringify(json)).digest("hex").slice(0, 16);
}

// Anthropic structured output rejects these (400); our Zod re-validation still enforces them.
const ANTHROPIC_UNSUPPORTED = [
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"maxItems",
] as const;

/** Anthropic `output_config.format`: closed objects, no numeric or length constraints, `minItems` only 0 or 1. */
export function anthropicSchema(json: Json): Json {
	return transform(json, (node) => {
		for (const key of ANTHROPIC_UNSUPPORTED) delete node[key];
		if (typeof node.minItems === "number" && node.minItems > 1) node.minItems = 1;
		closeObject(node);
	});
}

/**
 * OpenAI `text.format` json_schema. Strict mode needs every property required, so a
 * schema with optional properties is sent non-strict (still followed, and re-validated here).
 */
export function openaiSchema(json: Json): { schema: Json; strict: boolean } {
	let strict = true;
	const schema = transform(json, (node) => {
		closeObject(node);
		if (isObjectNode(node)) {
			const properties = Object.keys((node.properties as Json | undefined) ?? {});
			const required = new Set((node.required as string[] | undefined) ?? []);
			if (properties.some((name) => !required.has(name))) strict = false;
		}
	});
	return { schema, strict };
}

function isObjectNode(node: Json): boolean {
	return node.type === "object" || "properties" in node;
}

function closeObject(node: Json) {
	if (isObjectNode(node)) node.additionalProperties = false;
}

const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);
const LITERALS = new Set(["enum", "const", "default", "examples", "required"]);

/** Deep-copies a JSON Schema, applying `visit` to every subschema. */
function transform(json: Json, visit: (node: Json) => void): Json {
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (value === null || typeof value !== "object") return value;
		const node: Json = {};
		for (const [key, child] of Object.entries(value as Json)) {
			if (SCHEMA_MAPS.has(key) && child && typeof child === "object") {
				node[key] = Object.fromEntries(Object.entries(child as Json).map(([name, sub]) => [name, walk(sub)]));
			} else {
				node[key] = LITERALS.has(key) ? structuredClone(child) : walk(child);
			}
		}
		visit(node);
		return node;
	};
	return walk(json) as Json;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Json).sort(([a], [b]) => (a < b ? -1 : 1));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
