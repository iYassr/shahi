/**
 * Generates TypeScript types from herdr's bundled API schema.
 *
 * `herdr api schema --json` is one document holding five independent JSON
 * Schemas under `schemas`, each carrying its own `$defs`. Two wrinkles:
 *
 *  1. Internal `$ref`s are rooted at the *document* (`#/schemas/<n>/$defs/X`),
 *     not at their own sub-schema, so they must be re-rooted to `#/$defs/X`.
 *  2. 27 definition names appear in more than one sub-schema. 15 are already
 *     byte-identical; the other 12 (PaneInfo, PaneReadResult, WorkspaceInfo, …)
 *     differ *only* in those `$ref` prefixes. Re-rooting makes all 27 collapse
 *     into one definition, so everything can share a single `$defs` pool.
 *
 * The five sub-schema roots are then promoted into that pool as named
 * definitions, letting one compile pass emit the whole API as flat named types.
 *
 * Run: bun run gen:types
 */
import { compile } from "json-schema-to-typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCHEMA_PATH = join(ROOT, "herdr-schema.json");
// Emitted as `.ts`, not `.d.ts`: the file carries the protocol constants as
// real runtime values, which a declaration file cannot provide.
const OUT_PATH = join(ROOT, "lib", "herdr-schema.ts");

/** Sub-schema key in the document -> exported TypeScript type name. */
const ROOTS: Record<string, string> = {
  request: "Request",
  success_response: "SuccessResponse",
  error_response: "ErrorResponse",
  event: "EventEnvelope",
  subscription_event: "SubscriptionEventEnvelope",
};

/** Rewrite every `#/schemas/<anything>/$defs/X` into `#/$defs/X`. */
function rerootRefs<T>(node: T): T {
  if (Array.isArray(node)) return node.map(rerootRefs) as T;
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] =
      key === "$ref" && typeof value === "string"
        ? value.replace(/^#\/schemas\/[^/]+\/\$defs\//, "#/$defs/")
        : rerootRefs(value);
  }
  return out as T;
}

const doc = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const { protocol, schema_version: schemaVersion } = doc;

const defs: Record<string, unknown> = {};

for (const [subKey, typeName] of Object.entries(ROOTS)) {
  const sub = doc.schemas[subKey];
  if (!sub) throw new Error(`schema "${subKey}" missing from ${SCHEMA_PATH}`);

  // Merge this sub-schema's definitions into the shared pool, asserting that
  // any name collision really is identical once refs are re-rooted. If herdr
  // ever introduces a genuine divergence, fail loudly rather than silently
  // dropping one of the two definitions.
  for (const [name, def] of Object.entries(sub.$defs ?? {})) {
    const rerooted = rerootRefs(def);
    const existing = defs[name];
    if (existing && JSON.stringify(existing) !== JSON.stringify(rerooted)) {
      throw new Error(
        `definition "${name}" differs between sub-schemas even after ref ` +
          `re-rooting — the shared-pool assumption no longer holds.`,
      );
    }
    defs[name] = rerooted;
  }

  const { $defs: _dropped, $schema: _s, title: _t, ...rootBody } = sub;
  defs[typeName] = { title: typeName, ...rerootRefs(rootBody) };
}

// The root is deliberately empty — `unreachableDefinitions` is what emits all
// the named types. (A bare `$ref` root is not resolved by the compiler.)
const merged = {
  $defs: defs,
  title: "HerdrApiSchemaRoot",
  type: "object",
  properties: {},
  additionalProperties: false,
};

const body = await compile(merged as never, "HerdrApiSchemaRoot", {
  bannerComment: "",
  additionalProperties: false,
  declareExternallyReferenced: true,
  unreachableDefinitions: true,
  style: { semi: true, singleQuote: false },
});

writeFileSync(
  OUT_PATH,
  [
    "/* eslint-disable */",
    "/**",
    " * AUTO-GENERATED from herdr's bundled API schema. Do not edit by hand.",
    " * Regenerate with: bun run gen:types",
    " *",
    ` * herdr protocol: ${protocol}, schema_version: ${schemaVersion}`,
    " */",
    "",
    `export const HERDR_PROTOCOL = ${protocol};`,
    `export const HERDR_SCHEMA_VERSION = ${schemaVersion};`,
    "",
    body.trim(),
    "",
  ].join("\n"),
);

console.log(
  `wrote ${OUT_PATH} — protocol ${protocol}, ${Object.keys(defs).length} named types`,
);
