/**
 * Prefixed, time-ordered, client-generatable ids.
 *
 * Format: `<prefix>_<26-char base32 body>`. The body is a UUIDv7 (RFC 9562)
 * encoded with a Crockford base32 alphabet, lowercased.
 *
 * Four properties are load-bearing (spec: skema database):
 *  - time-ordered: UUIDv7 carries a 48-bit unix-ms timestamp in its most
 *    significant bits, and base32 encoding preserves byte order, so string
 *    sort order tracks creation order (index locality on `(project_id, id)`).
 *  - safe as a git ref component: the alphabet is lowercase-only (no case
 *    collision on case-insensitive filesystems) and excludes every character
 *    git rejects in a ref (`/. ~ ^ : ? * [ \` and friends never appear).
 *  - generatable client-side: no database round-trip and no server clock
 *    read is required, so the id can exist before the row it names does
 *    (idempotency key; encryption AAD needs the id first).
 *  - self-describing: the type prefix survives being pasted bare into a log
 *    line or a `git checkout`.
 */

const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Closed set of id prefixes. Extend this as later issues add entities — one
 * entry per table that owns an id column. `probe` belongs to the scaffold-
 * only `scaffold_probes` table this issue adds to prove the rig; it is not a
 * domain entity. The rest are the entity tables in `control-plane`'s Drizzle
 * schema (`src/db/schema/*.ts`) — the literal string is whatever `$type<Id<"...">>()`
 * uses there, so the two sides can't drift silently.
 */
export const ID_PREFIXES = [
  "probe",
  "user",
  "serviceaccount",
  "project",
  "group",
  "installation",
  "repository",
  "secret",
  "run",
  "steprun",
  "question",
  "artifact",
  "runner",
  "jointoken",
  "audit",
  "session",
  // Issue #20: the visual editor's per-submit idempotency key. It is not an
  // entity row — it rides in the branch name of the PR the editor opens, and
  // nothing is stored — but it is a client-generated id like every other
  // prefix, and a table-less prefix is exactly as cheap.
  "edit",
  "skip",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * A generated id, tagged with the entity it names. `Id<"project">` and
 * `Id<"run">` are distinct types even though both are plain strings at
 * runtime — this is what stops a Run id from being passed where a Project id
 * is expected. Parameterized (rather than one branded type per entity) so
 * `Id<P>`-generic code — a table's id column, a lookup keyed by prefix — has
 * one definition instead of one per entity.
 */
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const BODY_LENGTH = 26; // ceil(128 bits / 5 bits per base32 char)
const ID_BODY_PATTERN = new RegExp(`^[${BASE32_ALPHABET}]{${BODY_LENGTH}}$`);

export interface IdGeneratorOptions {
  /** Defaults to `Date.now`. Inject a fixed clock in tests for determinism. */
  now?: () => number;
  /** Defaults to WebCrypto. Inject a seeded source in tests for determinism. */
  randomBytes?: (length: number) => Uint8Array;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function writeUnixTimestampMs(bytes: Uint8Array, timestampMs: number): void {
  const ts = BigInt(Math.floor(timestampMs));
  for (let i = 0; i < 6; i++) {
    const shift = BigInt((5 - i) * 8);
    bytes[i] = Number((ts >> shift) & 0xffn);
  }
}

/** Encodes bytes as Crockford base32 (lowercase), most-significant-bit first. */
export function encodeBase32(bytes: Uint8Array): string {
  let buffer = 0;
  let bufferBits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferBits += 8;
    while (bufferBits >= 5) {
      bufferBits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bufferBits) & 0x1f];
    }
    buffer &= (1 << bufferBits) - 1;
  }
  if (bufferBits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bufferBits)) & 0x1f];
  }
  return output;
}

/** Inverse of {@link encodeBase32}. Trailing pad bits beyond `byteLength` are discarded. */
export function decodeBase32(input: string, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let buffer = 0;
  let bufferBits = 0;
  let byteIndex = 0;
  for (const char of input) {
    const charValue = BASE32_ALPHABET.indexOf(char);
    if (charValue === -1) {
      throw new Error(`invalid base32 character: ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 5) | charValue;
    bufferBits += 5;
    if (bufferBits >= 8) {
      bufferBits -= 8;
      if (byteIndex < byteLength) {
        bytes[byteIndex] = (buffer >>> bufferBits) & 0xff;
        byteIndex++;
      }
    }
    buffer &= (1 << bufferBits) - 1;
  }
  return bytes;
}

function uuidV7Bytes(options: IdGeneratorOptions): Uint8Array {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const rand = randomBytes(10);
  const bytes = new Uint8Array(16);

  writeUnixTimestampMs(bytes, now());

  // byte 6: version nibble (0111) + top 4 bits of rand_a
  bytes[6] = 0x70 | (rand[0]! & 0x0f);
  // byte 7: bottom 8 bits of rand_a
  bytes[7] = rand[1]!;
  // byte 8: variant (10) + top 6 bits of rand_b
  bytes[8] = 0x80 | (rand[2]! & 0x3f);
  // bytes 9..15: remaining 56 bits of rand_b
  bytes.set(rand.subarray(3, 10), 9);

  return bytes;
}

/** Generates a new prefixed id. Safe to call client-side (browser, Runner, or control plane). */
export function generateId<P extends IdPrefix>(prefix: P, options: IdGeneratorOptions = {}): Id<P> {
  return `${prefix}_${encodeBase32(uuidV7Bytes(options))}`;
}

/** Structural validation only — does not confirm the id refers to an existing row. */
export function isValidId(prefix: IdPrefix, id: string): boolean {
  const expectedPrefix = `${prefix}_`;
  if (!id.startsWith(expectedPrefix)) {
    return false;
  }
  const body = id.slice(expectedPrefix.length);
  return ID_BODY_PATTERN.test(body);
}
