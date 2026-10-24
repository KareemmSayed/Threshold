import React from 'react';
import { useFrame } from '../lib/rest';
import { ms } from '../lib/time';
import { typedAt, TypedSpans } from '../lib/type';

/* #why: raw Garmin JSON against the computed readout (docs/index.html, initRawJson in site.js). */

const FIELDS: [string, string | number][] = [
  ['calendarDate', '"2026-10-23"'], ['totalKilocalories', 2841], ['activeKilocalories', 912], ['bmrKilocalories', 1929],
  ['totalSteps', 14203], ['totalDistanceMeters', 11872], ['minHeartRate', 44], ['maxHeartRate', 171],
  ['restingHeartRate', 47], ['lastSevenDaysAvgRestingHeartRate', 46], ['averageStressLevel', 29], ['maxStressLevel', 96],
  ['stressDuration', 18720], ['restStressDuration', 31260], ['lowStressDuration', 11400], ['mediumStressDuration', 5160],
  ['highStressDuration', 2160], ['bodyBatteryChargedValue', 58], ['bodyBatteryDrainedValue', 61], ['bodyBatteryHighestValue', 71],
  ['bodyBatteryLowestValue', 12], ['averageSpo2', 95], ['lowestSpo2', 89], ['avgWakingRespirationValue', 14],
  ['highestRespirationValue', 22], ['floorsAscendedInMeters', 41.2], ['moderateIntensityMinutes', 38], ['vigorousIntensityMinutes', 51],
  ['sleepTimeSeconds', 26640], ['deepSleepSeconds', 5220], ['lightSleepSeconds', 14460], ['remSleepSeconds', 5520],
  ['awakeSleepSeconds', 1440], ['sleepScores', '{ "overall": { "value": 82 } }'], ['hrvSummary', '{ "weeklyAvg": 49, "lastNightAvg": 47 }'],
  ['baseline', '{ "balancedLow": 51, "balancedUpper": 63 }'], ['status', '"UNBALANCED"'], ['vo2MaxValue', 58], ['trainingEffectLabel', '"VO2MAX"'],
];

const OneJson: React.FC = () => (
  <>
    {'{\n'}
    {FIELDS.map(([k, v]) => (
      <React.Fragment key={k}>
        {'  '}
        <span className="k">"{k}"</span>: {String(v)},{'\n'}
      </React.Fragment>
    ))}
    {'  …\n}\n'}
  </>
);

/** .raw-scroll pre: @keyframes rawscroll, 40 s linear, translateY(-50%). `speed` runs it faster for video. */
export const RawJson: React.FC<{ t: number; speed?: number }> = ({ t, speed = 1 }) => (
  <pre id="raw-json" style={{ transform: `translateY(${-(((t * speed) % 40) / 40) * 50}%)` }}>
    <OneJson />
    <OneJson />
  </pre>
);

export const READOUT: [string, string, string, string, string][] = [
  ['HRV 7-day', '49 ms', 'normal 51–63', 'amber', 'slightly low'],
  ['Resting HR', '47 bpm', 'baseline 46', 'green', '+1'],
  ['Sleep', '7 h 24', 'usual 7.3 h', 'green', 'score 82'],
  ['Body Battery', '71', '30-day avg 64', 'green', 'good'],
  ['Form (TSB)', '−12', 'CTL 58 · ATL 70', 'blue', 'ok'],
  ['Load ramp', '1.34', 'ACWR > 1.3', 'amber', 'caution'],
];

/** The verdict word types in with Doto. */
export const Verdict: React.FC<{ at: number; style?: React.CSSProperties; dotStyle?: React.CSSProperties }> = ({ at, style, dotStyle }) => {
  const frame = useFrame();
  const t = typedAt('AMBER', ms(frame - at), frame, { slow: 1.8, seed: 41 });
  return (
    <div className="verdict" style={style}>
      <span className="dot dot-md amber-text" style={dotStyle}>
        <TypedSpans t={t} />
      </span>
      <span>Keep intensity moderate. Easy aerobic work is fine.</span>
    </div>
  );
};

