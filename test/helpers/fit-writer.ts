/** Builds FIT files for tests, including Garmin's undocumented message 140. */

export const BASE = { enum: 0x00, sint8: 0x01, uint8: 0x02, sint16: 0x83, uint16: 0x84, sint32: 0x85, uint32: 0x86, string: 0x07 } as const;
type Base = (typeof BASE)[keyof typeof BASE];
const SIZE: Record<number, number> = { 0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1 };

const FIT_EPOCH_S = 631_065_600;
export const fitTime = (unixSeconds: number) => unixSeconds - FIT_EPOCH_S;

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
function crc16(bytes: ArrayLike<number>, from = 0, to = bytes.length): number {
  let crc = 0;
  for (let i = from; i < to; i++) {
    const byte = bytes[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

interface Def {
  global: number;
  fields: Array<{ num: number; base: Base; size: number }>;
  devSize: number;
}

export class FitWriter {
  private out: number[] = [];
  private defs: Def[] = [];

  define(local: number, global: number, fields: Array<[num: number, base: Base, count?: number]>, devFields: Array<[num: number, size: number, index: number]> = []): this {
    const header = 0x40 | (devFields.length ? 0x20 : 0) | local;
    this.out.push(header, 0, 0, global & 0xff, global >> 8, fields.length);
    const defFields = fields.map(([num, base, count = 1]) => {
      const size = base === BASE.string ? count : SIZE[base] * count;
      this.out.push(num, size, base);
      return { num, base, size };
    });
    let devSize = 0;
    if (devFields.length) {
      this.out.push(devFields.length);
      for (const [num, size, index] of devFields) {
        this.out.push(num, size, index);
        devSize += size;
      }
    }
    this.defs[local] = { global, fields: defFields, devSize };
    return this;
  }

  /** Write a data message. `values` follow the definition's field order; null writes "invalid". */
  data(local: number, values: Array<number | number[] | string | null>, compressedTimeOffset?: number): this {
    const def = this.defs[local];
    if (compressedTimeOffset !== undefined) this.out.push(0x80 | (local << 5) | (compressedTimeOffset & 0x1f));
    else this.out.push(local);
    def.fields.forEach((f, i) => this.writeValue(f.base, f.size, values[i] ?? null));
    for (let i = 0; i < def.devSize; i++) this.out.push(0x2a);
    return this;
  }

  private writeValue(base: Base, size: number, value: number | number[] | string | null): void {
    if (base === BASE.string) {
      const bytes = new TextEncoder().encode(String(value ?? ""));
      for (let i = 0; i < size; i++) this.out.push(i < bytes.length && i < size - 1 ? bytes[i] : 0);
      return;
    }
    const unit = SIZE[base];
    const list = (Array.isArray(value) ? value : [value]) as Array<number | null>;
    for (let k = 0; k < size / unit; k++) {
      const v = list[k];
      const buf = new DataView(new ArrayBuffer(4));
      if (v === null || v === undefined) {
        const invalid = { 0x00: 0xff, 0x01: 0x7f, 0x02: 0xff, 0x83: 0x7fff, 0x84: 0xffff, 0x85: 0x7fffffff, 0x86: 0xffffffff }[base]!;
        buf.setUint32(0, invalid >>> 0, true);
      } else if (base === BASE.sint8) buf.setInt8(0, v);
      else if (base === BASE.sint16) buf.setInt16(0, v, true);
      else if (base === BASE.sint32) buf.setInt32(0, v, true);
      else buf.setUint32(0, v >>> 0, true);
      for (let i = 0; i < unit; i++) this.out.push(buf.getUint8(i));
    }
  }

  finish(): Uint8Array {
    const data = this.out;
    const header = new Uint8Array(14);
    const view = new DataView(header.buffer);
    header[0] = 14;
    header[1] = 0x20;
    view.setUint16(2, 2100, true);
    view.setUint32(4, data.length, true);
    header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    view.setUint16(12, crc16(header, 0, 12), true);
    const file = new Uint8Array(14 + data.length + 2);
    file.set(header, 0);
    file.set(data, 14);
    const crc = crc16(file, 0, 14 + data.length);
    file[file.length - 2] = crc & 0xff;
    file[file.length - 1] = crc >> 8;
    return file;
  }
}

export interface RunOptions {
  start: number; // unix seconds
  seconds?: number;
  sport?: number; // FIT sport enum: 1 running, 2 cycling
  speed?: (t: number) => number;
  hr?: (t: number) => number;
  power?: (t: number) => number | null;
  vo2max?: number;
  withPhysiology?: boolean;
  /** Use compressed timestamp headers for odd records (Garmin's JS SDK cannot read them). Default true. */
  compressed?: boolean;
}

/**
 * A synthetic activity: 1 Hz records (half of them with compressed timestamps),
 * a developer field to skip, a lap, a session, zones and message 140.
 */
export function syntheticActivity(opts: RunOptions): Uint8Array {
  const seconds = opts.seconds ?? 3600;
  const speed = opts.speed ?? (() => 3);
  const hr = opts.hr ?? ((t: number) => (t < seconds / 2 ? 145 : 152));
  const power = opts.power ?? (() => null);
  const w = new FitWriter();
  const t0 = fitTime(opts.start);
  w.define(0, 0, [
    [0, BASE.enum],
    [1, BASE.uint16],
    [2, BASE.uint16],
    [4, BASE.uint32],
  ]).data(0, [4, 1, 4024, t0]);
  // zones_target: max HR 190, threshold HR 170, FTP 250
  w.define(1, 7, [
    [1, BASE.uint8],
    [2, BASE.uint8],
    [3, BASE.uint16],
  ]).data(1, [190, 170, 250]);
  // record with timestamp, a developer field, and the same layout without timestamp for compressed headers
  const recordFields: Array<[number, Base]> = [
    [3, BASE.uint8], // heart_rate
    [5, BASE.uint32], // distance (m * 100)
    [73, BASE.uint32], // enhanced_speed (m/s * 1000)
    [78, BASE.uint32], // enhanced_altitude ((m + 500) * 5)
    [7, BASE.uint16], // power
    [0, BASE.sint32], // lat
    [1, BASE.sint32], // lon
    [90, BASE.sint8], // performance condition
  ];
  w.define(2, 20, [[253, BASE.uint32], ...recordFields], [[0, 1, 0]]);
  w.define(3, 20, recordFields);
  let distance = 0;
  for (let t = 0; t < seconds; t++) {
    const v = speed(t);
    distance += v;
    const alt = 100 + 10 * Math.sin(t / 300);
    const p = power(t);
    const pc = t >= 360 ? (t < seconds / 2 ? 2 : -1) : null;
    const values = [Math.round(hr(t)), Math.round(distance * 100), Math.round(v * 1000), Math.round((alt + 500) * 5), p === null ? null : Math.round(p), 600000000 + t * 1000, 100000000, pc];
    if (opts.compressed !== false && t % 2 === 1) w.data(3, values, (t0 + t) & 0x1f);
    else w.data(2, [t0 + t, ...values]);
  }
  const end = t0 + seconds - 1;
  const lapFields: Array<[number, Base]> = [
    [253, BASE.uint32],
    [2, BASE.uint32],
    [7, BASE.uint32],
    [8, BASE.uint32],
    [9, BASE.uint32],
    [15, BASE.uint8],
    [16, BASE.uint8],
  ];
  w.define(4, 19, lapFields).data(4, [end, t0, seconds * 1000, seconds * 1000, Math.round(distance * 100), 148, 160]);
  w.define(5, 18, [
    [253, BASE.uint32],
    [2, BASE.uint32],
    [5, BASE.enum],
    [6, BASE.enum],
    [7, BASE.uint32],
    [8, BASE.uint32],
    [9, BASE.uint32],
    [16, BASE.uint8],
    [17, BASE.uint8],
    [124, BASE.uint32],
    [22, BASE.uint16],
    [24, BASE.uint8],
    [137, BASE.uint8],
    [110, BASE.string, 16],
  ]).data(5, [end, t0, opts.sport ?? 1, 0, seconds * 1000, seconds * 1000, Math.round(distance * 100), 148, 160, Math.round((distance / seconds) * 1000), 120, 31, 12, "Run"]);
  // time_in_zone for the session: [below z1, z1..z5] seconds * 1000, high boundaries
  w.define(6, 216, [
    [253, BASE.uint32],
    [0, BASE.uint16],
    [1, BASE.uint16],
    [2, BASE.uint32, 6],
    [6, BASE.uint8, 5],
  ]).data(6, [end, 18, 0, [0, 0, 600000, 2400000, 600000, 0], [114, 133, 152, 171, 190]]);
  if (opts.withPhysiology !== false) {
    const vo2 = Math.round(((opts.vo2max ?? 52.3) * 65536) / 3.5);
    w.define(7, 140, [
      [253, BASE.uint32],
      [4, BASE.uint16],
      [7, BASE.uint32],
      [9, BASE.uint16],
      [17, BASE.sint8],
    ]).data(7, [end, 150, vo2, 1260, -1]);
  }
  return w.finish();
}

/** Garmin's download endpoint returns the FIT inside a ZIP. */
export async function zipped(fit: Uint8Array, name = "123_ACTIVITY.fit"): Promise<Uint8Array> {
  const { zipSync } = await import("fflate");
  return zipSync({ [name]: fit });
}
