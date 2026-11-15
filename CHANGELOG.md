# Changelog

## 1.0.0 (2026-11-15)

The first major release. It fixes analysis that was wrong for interval training and for
watches without HRV, and adds six tools for questions the model used to answer by guessing.

### Upgrading

Deploy as usual; the schema upgrades itself on the first request.

* **Your activity files are analyzed again in the background**, newest first, because the
  analysis now produces more (session type, reps, cleaned heart rate, more distances). On
  the Workers Free plan that is one file every 10 minutes: about a day for the last few
  months, a few days for a long history. `server_status` shows the progress as
  `fit_reanalysis_pending`. Until a file is done, its activity is left out of the efficiency
  and decoupling trends, and asking for it with `analyze_activity` analyzes it at once.
* **`analyze_activity` returns a different shape** (see Changed). Anything that reads its
  output by field name needs updating.

### Fixed

* **Interval sessions are reported as reps.** A session such as 10 x 1000 m used to get
  kilometre splits that mixed reps with rests, and a decoupling verdict ("good aerobic
  durability") that meant nothing. The analysis now finds the reps (from the laps of a
  structured workout, from laps pressed by hand, or from the speed stream) and reports each
  one: time, pace, heart rate, rest, and how far heart rate fell in the rest, plus fade and
  consistency across the session.
* **Decoupling and efficiency are computed for steady efforts only.** Every session gets a
  type (intervals, long, tempo, steady, recovery, variable). The `running_efficiency` and
  `aerobic_decoupling` trends use steady sessions only.
* **The briefing no longer judges a night that has not synced.** A morning briefing that ran
  before the watch synced used to present the night before last as "last night" and could
  flag a low Body Battery that was only a leftover from the evening. It now says the night
  has not synced, shows those signals as stale, and leaves them out of the call.
* **Recovery works without HRV.** Accounts and watches with no HRV used to get no recovery
  signal beyond resting HR and sleep. Overnight stress and sleep breathing rate are now
  judged against the same 60-day baseline, and an illness watch combines them.
* **Heart rate is cleaned of sensor spikes** (readings outside 30 to 230 bpm, and jumps the
  heart cannot make) before zones, peaks and maximums are computed. `get_profile` now
  checks the max and threshold HR settings against the highest values recorded.
* Best efforts that span a GPS glitch stay filtered as before; four track distances join them.

### Added

* `race_predictor`: race times from 1500 m to the marathon and training paces, from recent
  best efforts (VDOT, Riegel, critical speed). For cycling: an FTP estimate, critical power,
  W' and power zones from the power curve.
* `load_forecast`: fitness, fatigue and form projected to a date for a plan (train as usual,
  taper, rest, or planned loads per day), with the load that reaches a target form.
* `training_status`: productive, maintaining, peaking, recovery, unproductive, overreaching
  or detraining, from the load chart and the VO2 max trend; and load focus, the split of the
  last four weeks between low aerobic, high aerobic and anaerobic work.
* `correlate`: how two daily metrics move together, with a lag ("does late training hurt my
  sleep?").
* `compare_workouts`: one workout against earlier sessions of the same kind.
* `race_calendar`: target races kept in the server's own archive. The briefing counts down
  to the next one, the predictor shows the gap to its goal, and the forecast aims at its date.
* Records: `analyze_activity` flags best efforts that rank in the all-time top three or are
  the best of the last 12 months; `weekly_report` lists the records set each week.
* Sleep regularity (bedtime and wake-time spread) and 7-day sleep debt in `recovery_analysis`.
* Best efforts over 200 m, 800 m, 1500 m and 3 km, and the highest heart rate held for 5, 20
  and 60 minutes.
* A recovery-time countdown in the briefing, from the FIT file's hidden recovery field
  (labelled experimental).
* Running form (stride length, ground contact time, vertical oscillation and ratio), strength
  sets and exercises, and swim details (SWOLF, pool length, pace per 100 m).
* Grade-adjusted pace on hilly runs, used for splits, decoupling and efficiency.
* A change of watch is noticed from the activity files and restarts the HRV baseline;
  `HRV_BASELINE_FROM` still overrides it.
* Resting HR and weight missing from Garmin's profile are filled from the archive.
* 16 more metrics for `metric_trend` and `correlate`, including bedtime, sleep stress, sleep
  breathing rate, hard minutes, steady-run pace and strength sets.
* A `workout` filter for `list_activities`, and the prompt `workout_progress`.

### Changed

* `analyze_activity` returns its lists (reps, splits, laps) as `columns` plus `rows` instead
  of one object per row, which is much shorter. It takes `sections` to return only some
  parts. By default it leaves out the laps, and the kilometre splits of an interval session.
* `daily_briefing` and `recovery_analysis`: `last_night` is the night that ended on the
  report date, or absent; an older night is returned as `latest_night`.
* `weekly_report`: `best_efforts` (a count) is replaced by `records` (a list).
* The archive gains columns on `activities` and an `events` table; see the schema in
  `query_archive`'s description.

## 0.1.x

The first releases: the archive, the analysis tools, FIT decoding, OAuth, and `show_view`.
See the git history for details.
