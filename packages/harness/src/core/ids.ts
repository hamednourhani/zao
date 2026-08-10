/**
 * ID generation — single source for all session and event identifiers.
 *
 * ## UUIDv7 (RFC 9562)
 *
 * Uses Unix timestamp in milliseconds as the first 48 bits, enabling
 * chronological sorting without embedding human-readable timestamps
 * in directory names. The remaining bits are filled with
 * cryptographically secure random values.
 *
 * @module ids
 */

/**
 * Generates a UUIDv7 identifier per RFC 9562.
 *
 * ## Layout (128 bits)
 *
 * ```
 * | 48 bits: unix_ts_ms  | 4: ver  | 12: rand_a | 2: var | 62: rand_b |
 * ```
 *
 * @returns A UUIDv7 string (e.g., `018f1234-5678-7abc-8000-123456789abc`).
 */
export function generateSessionId(): string {
  const tsMs = BigInt(Date.now());
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);

  // Write timestamp into upper 48 bits of the first 64 bits (big-endian).
  // Equivalent to a 48-bit unsigned integer in bytes 0-5, with bytes 6-7 zero.
  dv.setBigUint64(0, tsMs << 16n, false); // false = big-endian

  // Fill remaining 10 bytes with cryptographic random.
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  const uuid = new Uint8Array(buf);

  // Byte 6: version nibble (0x7) in upper 4 bits + rand_a lower nibble.
  uuid[6] = (rand[0]! & 0x0f) | 0x70;

  // Byte 7: rand_a lower byte.
  uuid[7] = rand[1]!;

  // Byte 8: variant (10₂ → upper 2 bits = 0x80) + rand_b upper 6 bits.
  uuid[8] = (rand[2]! & 0x3f) | 0x80;

  // Bytes 9-15: remaining rand_b.
  uuid[9] = rand[3]!;
  uuid[10] = rand[4]!;
  uuid[11] = rand[5]!;
  uuid[12] = rand[6]!;
  uuid[13] = rand[7]!;
  uuid[14] = rand[8]!;
  uuid[15] = rand[9]!;

  const hex = [...uuid]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
