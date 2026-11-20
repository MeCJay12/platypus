/**
 * Sanitize message content by removing characters that PostgreSQL's jsonb type
 * rejects. Covers all three categories documented at:
 * https://www.postgresql.org/docs/current/datatype-json.html
 *
 * 1. **Null (\u0000)** — code 22P05 "unsupported Unicode escape sequence"
 *    because it cannot be represented in PostgreSQL's text type.
 *
 * 2. **Lone surrogates (U+D800-U+DFFF not in a valid high+low pair)**
 *    — causes "invalid input syntax for type json": the JSONB parser insists
 *    any high surrogate (U+D800..U+DBFF) must be immediately followed by a
 *    low surrogate (U+DC00..U+DFFF). An isolated or swapped pair is rejected.
 *
 * 3. **Unicode non-characters** (U+FDD0-U+FDEF, U+FFFE, U+FFFF) — these are
 *    permanently reserved by Unicode and cannot appear in JSON/UTF-8 text.
 *    PostgreSQL rejects them with "unsupported Unicode escape sequence".
 */

/** Check if a code point is a non-character per Unicode spec Section 2.5. */
function isNonCharacter(cp: number): boolean {
  // Pattern 1: U+nFFFE and U+nFFFF for all planes n=0..10 — the last two nibbles
  // are FFFE or FFFF. Because every plane starts at a multiple of 0x1_0000, this
  // bitmask check correctly matches across the entire valid Unicode range (U+0
  // through U+10FFFF).
  if ((cp & 0xfffe) === 0xfffe) return true;

  // Pattern 2: the private-use / reserved blocks FDD0-FDEF for each plane.
  // The offset within a plane must fall in this range.
  const offset = cp % 0x1_0000;
  if (offset >= 0xfdd0 && offset <= 0xfdef) return true;

  return false;
}

/** Filter out all characters rejected by PostgreSQL jsonb from a single string. */
const sanitizeString = (s: string): string => {
  const result: number[] = [];
  let i = 0;
  while (i < s.length) {
    // Decode the Unicode code point at position i.
    const cp = s.codePointAt(i);
    if (cp === undefined) {
      i++;
      continue;
    }

    // Category 1: null character — always rejected (U+0000 fits in 1 code unit).
    if (cp === 0x0000) {
      i++;
      continue;
    }

    // Category 2: surrogate code points.
    // High surrogates in range U+D800..U+DBFF; low surrogates in U+DC00..U+DFFF.
    if (cp >= 0xd800 && cp <= 0xdbff) {
      // High surrogate — check that the next UTF-16 code unit is a valid low
      // surrogate before consuming it as a pair.
      const nextCp = s.codePointAt(i + 2);
      if (
        nextCp !== undefined &&
        nextCp >= 0xdc00 &&
        nextCp <= 0xdfff
      ) {
        // Valid high+low pair — decode to the actual Unicode code point.
        const combined = 0x1_0000 + ((cp - 0xd800) << 10) + (nextCp - 0xdc00);

        // Reject if the decoded code point is a non-character.
        if (!isNonCharacter(combined)) {
          result.push(combined);
        }
        i += 2; // skip both UTF-16 code units of the pair
      } else {
        // Lone high surrogate — reject it (consume only this one code unit).
        i += 1;
        continue;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      // Low surrogate without a preceding high surrogate — reject it.
      i += 1;
      continue;
    }

    // Category 3: non-characters (all planes) — permanently reserved by Unicode.
    if (isNonCharacter(cp)) {
      i += cp > 0xffff ? 2 : 1;
      continue;
    }

    // Valid character — keep it. Advance by code-point width.
    result.push(cp);
    i += cp > 0xffff ? 2 : 1;
  }

  if (result.length === 0) return "";
  try {
    return String.fromCodePoint(...result);
  } catch {
    // Fallback for extremely large arrays — should not happen in practice.
    let out = "";
    for (const cp of result) {
      out += String.fromCodePoint(cp);
    }
    return out;
  }
};

/** Recursively strip rejected characters from all string values. */
const sanitizeValue = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return value as T;
  if (typeof value === "string") return sanitizeString(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeValue) as unknown as T;
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(v);
    }
    return result as T;
  }
  // Primitives (number, boolean) pass through unchanged.
  return value;
};

/** Strip rejected characters from a PlatypusUIMessage (deep clone). */
export const sanitizeMessageForPersistence = <T extends { parts: unknown[] }>(
  msg: T,
): T => ({ ...msg, parts: msg.parts.map(sanitizeValue) as unknown[] }) as T;

/** Strip rejected characters from message parts only. */
export const sanitizePartsForPersistence = (parts: unknown[]): unknown[] =>
  parts.map(sanitizeValue);
