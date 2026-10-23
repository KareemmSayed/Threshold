/**
 * Make Garmin JSON fit a context window: drop nulls, personal identifiers and,
 * unless asked, long sample streams and coordinates.
 */

const PERSONAL_KEYS = new Set([
  "userProfilePK",
  "userProfilePk",
  "userProfileId",
  "userProfileNumber",
  "ownerId",
  "ownerDisplayName",
  "ownerFullName",
  "ownerProfileImageUrlSmall",
  "ownerProfileImageUrlMedium",
  "ownerProfileImageUrlLarge",
  "displayName",
  "fullName",
  "userName",
  "emailAddress",
  "profileImageUrlSmall",
  "profileImageUrlMedium",
  "profileImageUrlLarge",
  "userRoles",
  "uuid",
]);

const LOCATION_KEY = /^((start|end|center|min|max|position|begin)_?)?(lat|lon|long|latitude|longitude)$|polyline|geoPoint|^location(Name)?$/i;

export interface CompactOptions {
  /** Keep arrays of samples (time series). Default false. */
  samples?: boolean;
  /** Keep coordinates and place names. Default false. */
  location?: boolean;
  /** Arrays longer than this that hold numbers or number tuples count as samples. */
  sampleThreshold?: number;
}

function isSampleArray(value: unknown[], threshold: number): boolean {
  if (value.length <= threshold) return false;
  const first = value[0];
  if (typeof first === "number") return true;
  if (Array.isArray(first)) return first.every((v) => typeof v === "number" || v === null);
  if (first && typeof first === "object") {
    // Lists of {timestamp, value}-style readings.
    const keys = Object.keys(first);
    return keys.length <= 6 && keys.some((k) => /time|stamp|gmt|epoch/i.test(k));
  }
  return false;
}

export function compact(value: unknown, opts: CompactOptions = {}, depth = 0): unknown {
  const threshold = opts.sampleThreshold ?? 24;
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (!opts.samples && isSampleArray(value, threshold)) return { omittedSamples: value.length };
    const out = value.map((v) => compact(v, opts, depth + 1)).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PERSONAL_KEYS.has(k)) continue;
      if (!opts.location && LOCATION_KEY.test(k)) continue;
      const c = compact(v, opts, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  return value;
}
