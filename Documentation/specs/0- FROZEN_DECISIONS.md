# 0 — Frozen Decisions (v1.0.0)

Approved by the owner on 2026-11-16 together with the project Plan (PBS v1.1 Goal approval). **This file overrides any conflicting text in specs 1–4.** Specs 1–3 were produced by a read-only design workflow; spec 4 is the adversarial critique that recomputed every vector.

## Owner decisions (Q&A, 2026-11-16)

- **Modes:** 6 cards.
  1. Days Between: y/m/w/d breakdown, include-end toggle, totals in days/weeks/hours/minutes/seconds.
  2. Add/Subtract, with a business-day option.
  3. Business Days count.
  4. Age, with next birthday.
  5. Date Info: weekday, ISO week, day-of-year, quarter, leap year, days left.
  6. Live Countdown.
- **Holidays:** presets for US federal, UK (England & Wales) and Egypt, plus custom holidays. The weekend is configurable: Sat/Sun, Fri/Sat, Fri only, or custom.
- **Egypt preset:** selecting it auto-switches the weekend to Fri/Sat. Coptic Christmas and Coptic Easter are included, and both can be excluded. Islamic dates are estimated from the tabular Hijri calendar: default offset 0, adjustable ±2, with per-year overrides, and they are labelled "estimated".
- **Month-end rule:** clamp. Jan 31 + 1 month = Feb 28/29. Between dates walks month anniversaries.
- **Business mode in Add/Subtract:** years and months step on the calendar first. Then weeks count as business weeks (W × working days per week), then business days.
- **Platforms:** the same split as the reference (Windows NSIS/MSI/portable + PWA). The design system is identical: dark terminal look, gold #E9A715, green #94C59A, monospace type, square corners.
- **Repo:** new **public** repo `CipherVaults/Date-Calculator-Tool`, UNLICENSED (as in the reference). Version v1.0.0, identifier `com.datecalculator.tool`.


## Frozen decisions (resolve the critique's 28 contradictions)

1. **Result envelope:** the reference `#[serde(tag="ok")]` with `"true"`/`"false"` string tags, used everywhere (core, bridge, Tauri, JS, CI).
2. **Names:**
   - Core functions: `calc_days_between`, `calc_add_subtract`, `calc_business_days`, `calc_age`, `calc_date_info`, `calc_countdown`, `holidays_in_range`, `month_grid`, `validate_calendar`.
   - JS: the camelCase twins.
   - Bridge ops and Tauri commands: the same snake_case names. Each takes one `req` struct (camelCase, `deny_unknown_fields`) that embeds `calendar`, so the settings modal can preview unsaved edits.
3. **Field names:**
   - Requests follow spec-date-math: `startDate`/`endDate`/`includeEndDay`, `date`/`operation`/`years`/`months`/`weeks`/`days`/`businessDays`, `birthDate`/`asOfDate`/`leapDayRule`, and `now`/`target {date,time,utcOffsetMinutes}`.
   - Results: `summaryText`, `breakdownText`, `traceLines[]` (right-hand "live formula" panel), `copyText`, `warnings[]`, `usedApproximateHolidays`, and per holiday `approximate`/`actualDate`.
4. **CalendarSpec:**

   | Field | Rule |
   |---|---|
   | `weekend` | ISO 1..7 array in JSON, converted to a bitmask internally; all 7 days → `no_working_days` |
   | `preset` | single value: `none` \| `us` \| `uk` \| `eg` |
   | `hijriOffsetDays` | −2..=2 |
   | `hijriOverrides` | ≤50 entries, each within ±3 days of the tabular date, `hijriYear` 1317..=1626 |
   | `excludedHolidays` | `{us,uk,eg}` lists of camelCase ids |
   | `customHolidays` | ≤100 `{id, name≤60, kind date\|yearly, enabled}` |
   | `observedMode` | as in spec-holidays |
   | `schemaVersion` | 1 |

   - Presets cover the years 1900..=2199. Outside that range they add nothing, the math continues, and the result carries `warnings:["presetYearOutOfRange"]`.
   - Error codes are snake_case.
   - Defaults: preset `none`, weekend Sat/Sun.
5. **Business days:**
   - Count over the half-open range [earlier, later): the earlier date is counted; the later date is counted only when the toggle is on. The UI label says "include the later date".
   - Add vectors for backward ranges.
   - Counting and adding run year by year, with no 100k cap.
   - Holidays falling on the same date count once; each name appears once.
6. **Amount inputs:** `type=text inputmode=numeric`, never `type=number`. The core accepts signed `^[+-]?\d+$`, up to 15 digits, with a maximum per field. The UI converts Arabic-Indic digits to ASCII.
   - Times: `HH:MM[:SS]`.
7. **Countdown:**
   - DST-correct, using the per-instant `utcOffsetMinutes` the UI supplies, computed with `setFullYear` and rounded.
   - The tick aligns to the next whole second and pauses while the tab is hidden.
   - The clock itself is not aria-live; a separate polite status region announces changes.
8. **Age:**
   - `leapDayRule` toggle: `feb28` (default) or `mar1`.
   - An empty as-of field means local today, and the UI shows that date.
   - Add a vector for the 366-day case.
9. **`month_grid` lives in the core and is covered by parity:** the mini calendars on the Business, Date Info and Countdown cards use it.
10. **Holiday fixes from the critique:**
    - UK: add the 1981-07-29 royal wedding.
    - Egypt: add a `copticEaster` rule and keep Sham el-Nessim on Easter + 1.
    - Keep Egypt's estimated "reported" Islamic dates out of the fixtures.
11. **History:**
    - Each entry's `copyText` ≤1024 bytes; clipboard copy stays ≤4096.
    - Holiday lists in `copyText` are capped at 10 entries plus "and n more".
    - A test feeds the longest possible output of each mode through both validators.
    - Custom holiday names are never stored in history.
12. **Settings:**
    - The calendar is nested under `calendar` with `schemaVersion`; the file limit is 64 KiB.
    - On a corrupt file, keep a `.bak` copy (mobile: a `_bak` key) once, then fall back to defaults with `checkUpdatesOnStartup=false`, as the reference does.
13. **Fixtures:**
    - `tests/fixtures/vectors.json` holds the hand-verified vectors from both specs, minus the critique's corrected ones. It is never regenerated.
    - `golden.json` (≥12k cases) is generated by `examples/gen_golden.rs` and checked with `--check`.
    - The `chrono` dev-dependency oracle checks all 3.65M days in range.
    - Engine markers in the mobile file: `/* date-core:begin v1.0.0 */ … /* date-core:end */`.
    - The parity check compares both canonical JSON and raw key order.
14. **CI:**
    - The node vm replay removes `Date` and `Intl` from the context, and a static regex bans them in the engine slice.
    - The smoke step runs `Start-Process -Wait -PassThru` and gates on its exit code.
    - A check keeps the three copies of the inline node block identical.
    - Actions stay SHA-pinned with `persist-credentials:false`.
    - Fix the smoke vectors: use 2024-01-01..05 (Sat/Sun vs Fri/Sat counts differ, pinned exact numbers). Expect US January 2024 = 20 business days with the later date excluded, 21 with it included. The countdown regex allows comma-grouped day counts.
15. **Accessibility:** carry over everything from the reference:
    - `role=status aria-live=polite` result regions;
    - dialog roles with aria-modal/aria-labelledby, and focus returning after a modal closes;
    - `:focus-visible`;
    - safe-area insets;
    - 760/540/440 px breakpoints;
    - 44 px targets on coarse pointers, including calendar cells and ‹ › buttons;
    - fieldset/legend around the weekend pills;
    - 16 px date/time inputs on iOS, with the `.date-empty` hint.
16. **Stated limits (About and README):**
    - Islamic dates are estimated (±1–2 days).
    - UK one-off holidays are verified through 2027.
    - Holidays Egypt moves by decree are not modelled.
    - Jan 31 + 1 month − 1 month = Jan 28.
    - The month-end convention is documented.

