/** Tool result helpers: compact JSON, size caps, readable errors. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SqlRejected } from "../archive/sql";
import { BudgetExhaustedError, GarminAuthError, GarminError, GarminRateLimitError } from "../garmin/client";
import { FitDecodeError } from "../fit/decode";

const MAX_CHARS = 80_000;

export class UserError extends Error {
  override name = "UserError";
}

function prune(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map((v) => (v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? null : prune(v) ?? null));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return value;
}

export function ok(data: unknown, notes: string[] = []): CallToolResult {
  const body = prune(data) as Record<string, unknown> | unknown;
  const payload = notes.length && body && typeof body === "object" && !Array.isArray(body) ? { ...(body as object), notes: [...new Set(notes)] } : body;
  let text = JSON.stringify(payload);
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS)}… [truncated at ${MAX_CHARS} characters; narrow the date range or ask for fewer samples]`;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof GarminAuthError || err instanceof GarminRateLimitError || err instanceof UserError || err instanceof SqlRejected || err instanceof FitDecodeError) {
    message = err.message;
  } else if (err instanceof BudgetExhaustedError) {
    message = "This request needs more Garmin calls than one invocation allows. Try a shorter date range; the background sync fills the archive over time.";
  } else if (err instanceof GarminError) {
    message =
      err.status === 404
        ? `${err.message}. Garmin has no data there, or the path is not part of the Personal API.`
        : err.status === 400 || err.status === 500
          ? `${err.message}. Garmin answers 400/500 when a range is too long or data does not exist; try a shorter range.`
          : err.message;
  } else if (err instanceof Error && /D1_|SQLITE/i.test(err.message)) {
    message = `Database error: ${err.message.replace(/^.*?D1_ERROR:\s*/i, "")}`;
  } else {
    console.error("tool error", err);
    message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}
