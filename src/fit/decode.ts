/**
 * A small, fast FIT decoder.
 *
 * Garmin's SDK decodes every field of every message into objects, which costs
 * 25+ ms per hour of recording: more than a Workers Free invocation may spend.
 * This decoder reads only what the analysis needs. Records go straight into
 * columns, a few summary messages get Garmin's names and scales, and the
 * undocumented physiological-metrics message (140) is kept raw.
 *
 * Format reference: FIT protocol, https://developer.garmin.com/fit/protocol/
 */
import { ENUMS, FIELDS } from "./profile";

const FIT_EPOCH_S = 631_065_600; // 1989-12-31T00:00:00Z
const BASE_SIZE = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];
const SEMICIRCLE_DEG = 180 / 2 ** 31;

export const MESG = {
  fileId: 0,
  zonesTarget: 7,
  sport: 12,
  session: 18,
  lap: 19,
  record: 20,
  physiologicalMetrics: 140,
  timeInZone: 216,
} as const;

/** Record columns. Values are NaN where the device wrote nothing. */
export const COLUMNS = ["time", "hr", "speed", "distance", "power", "altitude", "cadence", "lat", "lon", "temperature", "performanceCondition"] as const;
export type Column = (typeof COLUMNS)[number];
export type Records = Record<Column, Float64Array> & { length: number };

// Record field number -> [column index, scale, offset]
const RECORD_FIELDS: Record<number, [number, number, number]> = {
  253: [0, 1, -FIT_EPOCH_S], // timestamp -> unix seconds
  3: [1, 1, 0], // heart_rate
  6: [2, 1000, 0], // speed
  73: [2, 1000, 0], // enhanced_speed (wins over speed)
  5: [3, 100, 0], // distance
  7: [4, 1, 0], // power
  2: [5, 5, 500], // altitude
  78: [5, 5, 500], // enhanced_altitude (wins over altitude)
  4: [6, 1, 0], // cadence
  0: [7, 1 / SEMICIRCLE_DEG, 0], // position_lat
  1: [8, 1 / SEMICIRCLE_DEG, 0], // position_long
  13: [9, 1, 0], // temperature
  90: [10, 1, 0], // performance condition (undocumented; community-decoded)
};
const ENHANCED = new Set([73, 78]);

export type Fields = Record<string, number | string | number[]>;
export type RawFields = Record<number, number | number[]>;

export interface FitFile {
  fileId: Fields | null;
  sport: Fields | null;
  zonesTarget: Fields | null;
  sessions: Fields[];
  laps: Fields[];
  timeInZone: Fields[];
  /** Undocumented message 140, keyed by field number. */
  physiology: RawFields[];
  records: Records;
  messageCounts: Record<number, number>;
  warnings: string[];
}

interface FieldDef {
  num: number;
  size: number;
  base: number;
  offset: number;
}

interface RecordPlan {
  offsets: number[];
  bases: number[];
  cols: number[];
  scales: number[];
  offsetsAdd: number[];
  enhanced: boolean[];
}

interface Definition {
  global: number;
  little: boolean;
  fields: FieldDef[];
  size: number;
  timestampOffset: number;
  /** For record messages: where each wanted field sits and how to scale it. */
  plan?: RecordPlan;
}

function recordPlan(fields: FieldDef[]): RecordPlan {
  const plan: RecordPlan = { offsets: [], bases: [], cols: [], scales: [], offsetsAdd: [], enhanced: [] };
  // Basic fields first so the enhanced variant, when present, overwrites them.
  const ordered = [...fields].sort((a, b) => Number(ENHANCED.has(a.num)) - Number(ENHANCED.has(b.num)));
  for (const f of ordered) {
    const map = RECORD_FIELDS[f.num];
    if (!map) continue;
    const base = f.base & 0x1f;
    if ((BASE_SIZE[base] ?? 1) !== f.size) continue; // arrays are not expected here
    plan.offsets.push(f.offset);
    plan.bases.push(base);
    plan.cols.push(map[0]);
    plan.scales.push(map[1]);
    plan.offsetsAdd.push(map[2]);
    plan.enhanced.push(ENHANCED.has(f.num));
  }
  return plan;
}

export class FitDecodeError extends Error {
  override name = "FitDecodeError";
}

function invalid(base: number, v: number): boolean {
  switch (base) {
    case 0:
    case 2:
    case 13:
      return v === 0xff;
    case 1:
      return v === 0x7f;
    case 3:
      return v === 0x7fff;
    case 4:
      return v === 0xffff;
    case 5:
      return v === 0x7fffffff;
    case 6:
      return v === 0xffffffff;
    case 10:
    case 11:
    case 12:
    case 16:
      return v === 0;
    case 8:
    case 9:
      return Number.isNaN(v);
    case 14:
      return v === 0x7fffffffffffffff;
    case 15:
      return v === 0xffffffffffffffff;
    default:
      return false;
  }
}

function readNumber(view: DataView, pos: number, base: number, little: boolean): number {
  let v: number;
  switch (base) {
    case 1:
      v = view.getInt8(pos);
      break;
    case 3:
      v = view.getInt16(pos, little);
      break;
    case 4:
    case 11:
      v = view.getUint16(pos, little);
      break;
    case 5:
      v = view.getInt32(pos, little);
      break;
    case 6:
    case 12:
      v = view.getUint32(pos, little);
      break;
    case 8:
      v = view.getFloat32(pos, little);
      break;
    case 9:
      v = view.getFloat64(pos, little);
      break;
    case 14:
      v = Number(view.getBigInt64(pos, little));
      break;
    case 15:
    case 16:
      v = Number(view.getBigUint64(pos, little));
      break;
    default:
      v = view.getUint8(pos);
  }
  return invalid(base, v) ? NaN : v;
}

const utf8 = new TextDecoder();

/** One field's value: a number, an array of numbers, a string, or undefined when invalid. */
function readField(bytes: Uint8Array, view: DataView, pos: number, f: FieldDef, little: boolean): number | number[] | string | undefined {
  const base = f.base & 0x1f;
  if (base === 7) {
    let end = pos;
    while (end < pos + f.size && bytes[end] !== 0) end++;
    const s = utf8.decode(bytes.subarray(pos, end));
    return s || undefined;
  }
  const size = BASE_SIZE[base] ?? 1;
  const count = Math.floor(f.size / size);
  if (count < 1) return undefined;
  if (count === 1) {
    const v = readNumber(view, pos, base, little);
    return Number.isNaN(v) ? undefined : v;
  }
  const out: number[] = [];
  let any = false;
  for (let i = 0; i < count; i++) {
    const v = readNumber(view, pos + i * size, base, little);
    out.push(v);
    if (!Number.isNaN(v)) any = true;
  }
  return any ? out : undefined;
}

function named(global: number, raw: Map<number, number | number[] | string>): Fields {
  const specs = FIELDS[global] ?? {};
  const out: Fields = {};
  for (const [num, value] of raw) {
    const spec = specs[num];
    if (!spec) continue;
    const [name, scale, offset, kind, enumType] = spec;
    if (kind === "s") {
      if (typeof value === "string") out[name] = value;
    } else if (kind === "t") {
      if (typeof value === "number") out[name] = new Date((value + FIT_EPOCH_S) * 1000).toISOString();
    } else if (kind === "e") {
      if (typeof value === "number") out[name] = ENUMS[enumType]?.[value] ?? value;
    } else if (typeof value === "number") {
      out[name] = value / scale - offset;
    } else if (Array.isArray(value)) {
      out[name] = value.map((v) => (Number.isNaN(v) ? NaN : v / scale - offset));
    }
  }
  return out;
}

/** Growable column store. */
class ColumnStore {
  length = 0;
  cols: Float64Array[];
  constructor(capacity: number) {
    this.cols = COLUMNS.map(() => new Float64Array(Math.max(64, capacity)));
  }
  row(): number {
    if (this.length === this.cols[0].length) {
      this.cols = this.cols.map((c) => {
        const next = new Float64Array(c.length * 2);
        next.set(c);
        return next;
      });
    }
    const i = this.length++;
    for (const c of this.cols) c[i] = NaN;
    return i;
  }
  finish(): Records {
    const out = { length: this.length } as Records;
    COLUMNS.forEach((name, i) => (out[name] = this.cols[i].slice(0, this.length)));
    return out;
  }
}

export interface DecodeOptions {
  /** Skip per-second records (faster when only summaries are needed). */
  records?: boolean;
}

export function decodeFit(bytes: Uint8Array, opts: DecodeOptions = {}): FitFile {
  const wantRecords = opts.records !== false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: FitFile = {
    fileId: null,
    sport: null,
    zonesTarget: null,
    sessions: [],
    laps: [],
    timeInZone: [],
    physiology: [],
    records: { length: 0 } as Records,
    messageCounts: {},
    warnings: [],
  };
  // A record is rarely shorter than 8 bytes, so this rarely needs to grow.
  const store = new ColumnStore(Math.ceil(bytes.length / 16));

  let pos = 0;
  let files = 0;
  while (pos + 12 <= bytes.length) {
    const headerSize = bytes[pos];
    const magic = String.fromCharCode(bytes[pos + 8], bytes[pos + 9], bytes[pos + 10], bytes[pos + 11]);
    if ((headerSize !== 12 && headerSize !== 14) || magic !== ".FIT") {
      if (files === 0) throw new FitDecodeError("Not a FIT file (missing .FIT header).");
      break;
    }
    files++;
    const dataSize = view.getUint32(pos + 4, true);
    let p = pos + headerSize;
    const end = Math.min(p + dataSize, bytes.length);
    if (p + dataSize > bytes.length) out.warnings.push("File is truncated; decoded what was there.");
    const defs: Array<Definition | undefined> = new Array(16);
    let lastTimestamp = 0;

    while (p < end) {
      const header = bytes[p++];
      let local: number;
      let compressedTs = -1;
      if (header & 0x80) {
        local = (header >> 5) & 0x3;
        const offset = header & 0x1f;
        lastTimestamp = lastTimestamp + ((offset - (lastTimestamp & 0x1f)) & 0x1f);
        compressedTs = lastTimestamp;
      } else if (header & 0x40) {
        local = header & 0x0f;
        if (p + 5 > end) break;
        const little = bytes[p + 1] === 0;
        const global = view.getUint16(p + 2, little);
        const count = bytes[p + 4];
        p += 5;
        const fields: FieldDef[] = [];
        let offset = 0;
        let timestampOffset = -1;
        for (let i = 0; i < count; i++) {
          const f = { num: bytes[p], size: bytes[p + 1], base: bytes[p + 2], offset };
          if (f.num === 253 && f.size === 4) timestampOffset = offset;
          fields.push(f);
          offset += f.size;
          p += 3;
        }
        let devSize = 0;
        if (header & 0x20) {
          const devCount = bytes[p++];
          for (let i = 0; i < devCount; i++) {
            devSize += bytes[p + 1];
            p += 3;
          }
        }
        defs[local] = { global, little, fields, size: offset + devSize, timestampOffset, plan: global === MESG.record ? recordPlan(fields) : undefined };
        continue;
      } else {
        local = header & 0x0f;
      }

      const def = defs[local];
      if (!def) {
        out.warnings.push(`Data message without a definition at byte ${p - 1}; stopped decoding.`);
        p = end;
        break;
      }
      const start = p;
      p += def.size;
      if (p > end) {
        out.warnings.push("Last message is incomplete.");
        break;
      }
      out.messageCounts[def.global] = (out.messageCounts[def.global] ?? 0) + 1;
      if (def.timestampOffset >= 0) {
        const ts = view.getUint32(start + def.timestampOffset, def.little);
        if (ts !== 0xffffffff) lastTimestamp = ts;
      }

      if (def.global === MESG.record) {
        if (!wantRecords) continue;
        const plan = def.plan!;
        const i = store.row();
        const cols = store.cols;
        if (compressedTs >= 0) cols[0][i] = compressedTs + FIT_EPOCH_S;
        for (let k = 0; k < plan.offsets.length; k++) {
          const v = readNumber(view, start + plan.offsets[k], plan.bases[k], def.little);
          if (v !== v) continue; // NaN: the device wrote "invalid"
          cols[plan.cols[k]][i] = v / plan.scales[k] - plan.offsetsAdd[k];
        }
        if (cols[0][i] !== cols[0][i]) store.length--; // a record without time cannot be placed
        continue;
      }

      if (
        def.global !== MESG.session &&
        def.global !== MESG.lap &&
        def.global !== MESG.fileId &&
        def.global !== MESG.sport &&
        def.global !== MESG.zonesTarget &&
        def.global !== MESG.timeInZone &&
        def.global !== MESG.physiologicalMetrics
      ) {
        continue;
      }
      const raw = new Map<number, number | number[] | string>();
      for (const f of def.fields) {
        const v = readField(bytes, view, start + f.offset, f, def.little);
        if (v !== undefined) raw.set(f.num, v);
      }
      switch (def.global) {
        case MESG.session:
          out.sessions.push(named(def.global, raw));
          break;
        case MESG.lap:
          out.laps.push(named(def.global, raw));
          break;
        case MESG.fileId:
          out.fileId ??= named(def.global, raw);
          break;
        case MESG.sport:
          out.sport ??= named(def.global, raw);
          break;
        case MESG.zonesTarget:
          out.zonesTarget ??= named(def.global, raw);
          break;
        case MESG.timeInZone:
          out.timeInZone.push(named(def.global, raw));
          break;
        case MESG.physiologicalMetrics: {
          const rec: RawFields = {};
          for (const [k, v] of raw) if (typeof v !== "string") rec[k] = v;
          out.physiology.push(rec);
          break;
        }
      }
    }
    pos = end + 2; // skip the file CRC; another FIT file may follow (chained)
  }

  out.records = store.finish();
  return out;
}

/** Garmin's download endpoint returns a ZIP holding `<id>_ACTIVITY.fit`; accept a bare FIT too. */
export async function extractFit(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length >= 12 && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === ".FIT") return bytes;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new FitDecodeError("Download is neither a ZIP archive nor a FIT file.");
  const { unzipSync } = await import("fflate");
  const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith(".fit") });
  const name = Object.keys(files)[0];
  if (!name) throw new FitDecodeError("The activity download contains no FIT file.");
  return files[name];
}
