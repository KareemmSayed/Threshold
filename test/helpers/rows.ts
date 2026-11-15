/** Archive rows for unit tests. */
import type { ActivityRow, DailyRow } from "../../src/archive/store";
import type { ProfileFacts } from "../../src/context";
import { addDays, eachDate } from "../../src/util/dates";

export const facts: ProfileFacts = { unit: "km", hrZoneFloors: {}, restingHr: 50, maxHr: 190, gender: "male" };

/** `n` consecutive days ending at `end`. */
export function days(end: string, n: number, make: (d: string, i: number) => Partial<DailyRow>): DailyRow[] {
  return eachDate(addDays(end, -(n - 1)), end).map((d, i) => ({ date: d, ...make(d, i) }) as DailyRow);
}

/** A 10 km run with a given training load. */
export function act(date: string, load: number, extra: Partial<ActivityRow> = {}): ActivityRow {
  return {
    activity_id: Date.parse(date) / 1000,
    name: "Run",
    type: "running",
    sport: "running",
    date,
    start_local: `${date} 07:00:00`,
    start_gmt: `${date} 05:00:00`,
    event_type: null,
    distance_m: 10000,
    duration_s: 3000,
    moving_s: 3000,
    elevation_gain_m: 50,
    avg_speed_mps: 3.33,
    avg_hr: 145,
    max_hr: 170,
    avg_power_w: null,
    norm_power_w: null,
    avg_cadence: null,
    stride_length_m: null,
    ground_contact_ms: null,
    vertical_oscillation_cm: null,
    vertical_ratio_pct: null,
    calories: 600,
    aerobic_te: 3,
    anaerobic_te: 1,
    garmin_load: load,
    tss: null,
    vo2max: 52,
    hr_zone1_s: 300,
    hr_zone2_s: 2000,
    hr_zone3_s: 500,
    hr_zone4_s: 200,
    hr_zone5_s: 0,
    training_effect_label: "AEROBIC_BASE",
    total_sets: null,
    total_reps: null,
    swolf: null,
    pool_length_m: null,
    fit_status: null,
    fit_version: null,
    fit_vo2max: null,
    fit_recovery_min: null,
    fit_performance_condition: null,
    decoupling_pct: null,
    efficiency_factor: null,
    workout_type: null,
    workout_structure: null,
    rep_count: null,
    rep_distance_m: null,
    rep_time_s: null,
    work_speed_mps: null,
    work_hr: null,
    rest_s: null,
    fit_max_hr: null,
    avg_temp_c: null,
    device: null,
    ...extra,
  };
}
