# date-core Date Math Spec v1.0.0 (Date Calculator Tool)

# date-core: Date Math Specification (v1.0.0)

Status: planning spec. `crates/date-core` is the source of truth. The mobile inline JS engine mirrors it byte for byte. Every number in the golden vectors (section 12) was computed with an independent JS model of this spec. The model was cross-checked in four ways:
- Day numbers were round-tripped for all 3,652,059 days in range.
- About 1 in 1,000 of those days was compared against `Date.UTC`.
- ISO weeks were checked for every day in range against the "Thursday rule".
- The y/m/d breakdown was checked against a brute-force "max months" search over about 230k date pairs under both leap rules.

Every check gave zero mismatches.

---

## 0. Principles

1. **Pure and deterministic.** The core never reads a clock, time zone, locale or environment. "Today" and "now" are always inputs, supplied by the UI from the JS `Date` of the webview or browser.
2. **Integers only.** No floats anywhere. Rust uses `i64` for every day, month and second quantity. JS uses `Number`, and every intermediate value is far below 2^53. The largest magnitude is about 3.2e11 seconds.
3. **Calendar.** Proleptic Gregorian with astronomical year numbering inside the engine (year 0 = 1 BCE, leap). Input and output are limited to **0001-01-01 ..= 9999-12-31**.
4. **Dependencies.** `[dependencies]` is `serde` (derive) only. `[dev-dependencies]` are `serde_json` (bridge and tests) and `chrono` (test oracle only; never linked into the app). Use `#![forbid(unsafe_code)]`. No input may cause a panic: every parse path returns `CoreError`, and arithmetic is bounded by validated limits.
5. **One error at a time.** The first error in the documented validation order wins (section 5.2).
6. **No time zones in date math.** A "day" is a calendar day, so hours = days x 24 in every date-only mode. Only the Countdown mode uses UTC offsets, and the UI supplies them.

---

## 1. Crate layout

```
crates/date-core/
  Cargo.toml                 # serde only; dev: serde_json, chrono
  src/lib.rs                 # pub use; Outcome; calc_* entry points
  src/civil.rs               # epoch-day <-> civil, leap, weekday, ISO week, add_months, ymd_between
  src/parse.rs               # parse_date, parse_amount, parse_time, trim_ascii_ws
  src/format.rs              # format_int, format_iso, format_long, plural, format_parts, format_hms
  src/error.rs               # CoreError, codes, Field labels
  src/calendar.rs            # WorkWeek, HolidaySource trait, Calendar, count/add business days
  src/holidays/*.rs          # preset rules (separate HOLIDAY spec; this spec defines only the contract)
  src/modes/{days_between,add_subtract,business_days,age,date_info,countdown}.rs
  examples/eval_bridge.rs    # NDJSON bridge (same framing as percent-core: 64 KiB line cap)
  tests/golden_vectors.rs    # hand-verified vectors (section 12), partial-field match
  tests/golden_parity.rs     # bulk Rust-generated parity.json, exact canonical match
  tests/oracle_chrono.rs     # exhaustive chrono cross-check
  tests/properties.rs        # invariants (section 11)
  tests/safety_evaluations.rs
  tests/fixtures/{vectors.json, parity.json, generate-parity.mjs}
```

---

## 2. Representation and core algorithms (`civil.rs`)

```rust
pub type EpochDay = i64;                       // days since 1970-01-01 (Unix day number)
pub const MIN_EPOCH_DAY: EpochDay = -719_162;  // 0001-01-01 (Monday)
pub const MAX_EPOCH_DAY: EpochDay = 2_932_896; // 9999-12-31 (Friday)
pub const JDN_OFFSET: i64 = 2_440_588;         // JDN = epochDay + 2_440_588 (JDN of 1970-01-01)
pub const SPAN_DAYS: i64 = 3_652_058;          // MAX - MIN

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Civil { pub year: i64, pub month: u32 /*1..=12*/, pub day: u32 /*1..=31*/ }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LeapDayRule { Feb28, Mar1 }           // JSON "feb28" | "mar1"

pub fn in_range(z: EpochDay) -> bool;          // MIN <= z <= MAX
pub fn is_leap_year(y: i64) -> bool;           // (y%4==0 && y%100!=0) || y%400==0  (rem_euclid)
pub fn days_in_month(y: i64, m: u32) -> u32;   // [31,28/29,31,30,31,30,31,31,30,31,30,31]
pub fn days_in_year(y: i64) -> u32;            // 365 | 366
pub fn days_from_civil(c: Civil) -> EpochDay;
pub fn civil_from_days(z: EpochDay) -> Civil;
pub fn iso_weekday(z: EpochDay) -> u32;        // 1=Mon..7=Sun = (z+3).rem_euclid(7)+1
pub fn day_of_year(z: EpochDay) -> u32;        // z - days_from_civil(y,1,1) + 1
pub fn iso_weeks_in_year(y: i64) -> u32;       // 53 iff Jan 1 is Thu, or (leap && Jan 1 is Wed)
pub fn iso_week(z: EpochDay) -> IsoWeek;       // { year: i64, week: u32, weekday: u32 }
pub fn add_months(c: Civil, k: i64, rule: LeapDayRule) -> (Civil, bool /*clamped*/);
pub fn ymd_between(earlier: EpochDay, later: EpochDay, rule: LeapDayRule) -> Ymd;
// Ymd { years: i64, months: i64 /*0..=11*/, days: i64, total_months: i64 }
```

### 2.1 days_from_civil and civil_from_days (H. Hinnant)

All divisions are floor divisions: `div_euclid` in Rust, `Math.floor(a/b)` in JS. All moduli are Euclidean: `rem_euclid` in Rust, `((a%b)+b)%b` in JS.

```
days_from_civil(y, m, d):
  y  = y - (m <= 2 ? 1 : 0)
  era = floor(y / 400)
  yoe = y - era*400                         // 0..399
  mp  = (m + 9) mod 12                      // Mar=0 .. Feb=11
  doy = floor((153*mp + 2) / 5) + d - 1     // 0..365
  doe = yoe*365 + floor(yoe/4) - floor(yoe/100) + doy
  return era*146097 + doe - 719468

civil_from_days(z):
  z  = z + 719468
  era = floor(z / 146097)
  doe = z - era*146097                      // 0..146096
  yoe = floor((doe - floor(doe/1460) + floor(doe/36524) - floor(doe/146096)) / 365)
  y   = yoe + era*400
  doy = doe - (365*yoe + floor(yoe/4) - floor(yoe/100))
  mp  = floor((5*doy + 2) / 153)
  d   = doy - floor((153*mp + 2) / 5) + 1
  m   = mp < 10 ? mp + 3 : mp - 9
  y   = y + (m <= 2 ? 1 : 0)
```

Both functions are valid for any `i64` that does not overflow, including years <= 0 and >= 10000. Out-of-range values occur only as intermediates (sections 7.2 and 7.1 inclusive end) and are never formatted.

### 2.2 Weekday, ISO week, ordinal

- `iso_weekday(z) = ((z + 3) mod 7) + 1`. Check: 1970-01-01 = 4 (Thursday).
- Ordinal: `o = z - days_from_civil(y,1,1) + 1`.
- ISO week: `w = iso_weekday(z)`, `wk = floor((o - w + 10) / 7)`.
  - If `wk < 1`, the date belongs to `(y-1, iso_weeks_in_year(y-1))`.
  - Else if `wk > iso_weeks_in_year(y)`, it belongs to `(y+1, 1)`.
  - Otherwise it is `(y, wk)`.
- `iso_weeks_in_year(y) = 53` if `iso_weekday(Jan 1 y) == 4`, or (`== 3` and leap). Otherwise 52.
- In range this never yields ISO year 0 or 10000: 0001-01-01 is a Monday and 9999-12-31 is a Friday.

### 2.3 add_months (month-end clamping)

```
t  = y*12 + (m-1) + k ; ny = floor(t/12) ; nm = (t mod 12) + 1
if rule == Mar1 && m == 2 && d == 29 && nm == 2 && !is_leap(ny): return ((ny,3,1), true)
nd = min(d, days_in_month(ny, nm)) ; return ((ny,nm,nd), nd != d)
```

`anniversary(start, k, rule) = days_from_civil(add_months(civil_from_days(start), k, rule).0)`.

`Mar1` changes only a Feb 29 start landing in February of a common year. `Feb28` is plain clamping. `Feb28` is used everywhere except where the Age request selects `mar1`.

### 2.4 ymd_between: the anniversary walk

**Definition (normative).** For `a <= b`:
- `M` is the largest integer `>= 0` with `anniversary(a, M, rule) <= b`.
- `days = b - anniversary(a, M, rule)`.
- `years = floor(M/12)`, `months = M mod 12`, `total_months = M`.

**Algorithm (equivalent, O(1)).**
```
M0 = (y2*12 + m2) - (y1*12 + m1)          // >= 0
M  = anniversary(a, M0) > b ? M0 - 1 : M0  // at most one decrement is ever needed
```

Why one decrement is enough: `anniversary(a, M0-1)` falls in the month before `b` (or on Mar 1 under `Mar1` when `b` is in March), so it is `<= b`.

Guarantees:
- Monotonic in `b`.
- `days` resets to 0 exactly on anniversaries.
- **Round-trip:** `add_months(a, M) + days == b`. This means Add/Subtract with `months = M` and `days = days` reproduces the end date (Feb28 rule).

Edge-case table (Feb28 rule unless noted):

| from | to | result | note |
|---|---|---|---|
| 2023-01-31 | 2023-02-27 | 27 days | anniversary Feb 28 > Feb 27 |
| 2023-01-31 | 2023-02-28 | 1 month | clamped anniversary. Java `Period` would give 28 days |
| 2023-01-28 | 2023-02-28 | 1 month | Jan 28..31 all reach "1 month" on Feb 28 |
| 2023-01-31 | 2023-03-01 | 1 month, 1 day | |
| 2024-01-31 | 2024-03-01 | 1 month, 1 day | anniversary Feb 29 |
| 2025-03-31 | 2025-04-30 | 1 month | |
| 2024-02-29 | 2025-02-28 | 1 year | Mar1 rule: 11 months, 30 days |
| 2024-02-29 | 2028-02-29 | 4 years | |
| 0001-01-01 | 9999-12-31 | 9,998 years, 11 months, 30 days | |

---

## 3. Input parsing (`parse.rs`)

### 3.1 Whitespace

`trim_ascii_ws(s)` strips only U+0020, U+0009, U+000A and U+000D from both ends.
- Rust: never `str::trim`.
- JS: `s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")`, never `String.prototype.trim`.

The reason is byte parity: the Rust and JS whitespace sets differ, for example U+FEFF and U+00A0.

### 3.2 `parse_date(raw: &str, field: Field) -> Result<EpochDay, CoreError>`

1. `s = trim_ascii_ws(raw)`. If empty, return `missing_date`.
2. `s` must match `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`, with ASCII digits only and exactly 10 bytes. Otherwise return `invalid_date_format`.
   - In Rust, check bytes with `is_ascii_digit`.
   - In JS, use a regex without the `u` flag: `\d` is ASCII-only, but write `[0-9]` explicitly.
   - Fullwidth or Arabic-Indic digits, `/` separators, 5-digit years and `2025-1-05` are all format errors.
3. `year == 0` gives `date_out_of_range`.
4. `month` not in 1..=12 gives `invalid_month`.
5. `day` not in 1..=days_in_month gives `invalid_day`.
6. Return `days_from_civil`.

### 3.3 `parse_amount(raw: &str, field: Field) -> Result<i64, CoreError>`

Used for Years, Months, Weeks and Days. Business days are entered in the Days field.

1. `s = trim_ascii_ws(raw)`. If empty, the value is **0** (a blank field means zero).
2. `s` must match `^[+-]?[0-9]+$`. Otherwise return `invalid_amount`. These all fail: `1.5`, `1e3`, `1,000`, `+`, `--1`, `٣` (U+0663).
3. Strip the sign, then strip leading zeros. If more than 15 digits remain, return `amount_out_of_range`. Otherwise parse the value; it is exact in JS because it is below 1e15.
4. Apply the sign. Normalize `-0` to `0`.
5. If `|v| > max(field)`, return `amount_out_of_range`.

| Field | max |
|---|---|
| Years | 9,999 |
| Months | 119,988 (= 9,999 x 12) |
| Weeks | 521,722 (= floor(3,652,058 / 7)) |
| Days | 3,652,058 (full supported span) |

### 3.4 `parse_time(raw: &str, field: Field, required: bool) -> Result<u32 /*secs of day*/, CoreError>`

- `s = trim_ascii_ws(raw)`.
- If empty: when not required, return `0` (00:00:00); when required, return `missing_time`.
- `s` must match `^([0-9]{2}):([0-9]{2})(:([0-9]{2}))?$` with `HH <= 23`, `MM <= 59` and `SS <= 59`. No `24:00`, no leap seconds, no 12-hour clock. Otherwise return `invalid_time`.
- Normalized output format is `HH:MM:SS`.

### 3.5 UTC offsets (countdown only)

- JSON integer in minutes, east-positive (ISO sign). UTC+02:00 is `120`.
- **The UI must negate JS `getTimezoneOffset()`.**
- Valid range is -1080..=1080. Otherwise return `invalid_utc_offset`.
- Defaults to `0` when omitted (`#[serde(default)]`).

### 3.6 Weekend

- `weekend: Vec<u8>` holds ISO weekday numbers.
- Every element must be in 1..=7 with no duplicates. Otherwise return `invalid_weekend`.
- Length 7 gives `no_working_days`.
- An empty array is allowed and means every day is a working day.
- The output echoes the weekend sorted ascending.
- UI presets: Sat/Sun `[6,7]`, Fri/Sat `[5,6]`, Fri only `[5]`, or any custom subset.
- `wpw` (workdays per week) = `7 - weekend.len()`.

---

## 4. Formatting (`format.rs`): exact byte rules

- `format_int(n: i64) -> String`: ASCII `-` for negatives, then digits with `,` every 3 digits from the right. **Never** use `toLocaleString`, `Intl` or `{:n}`.
  - Examples: `0`, `999`, `1,000`, `-1,234,567`, `315,537,897,600`.
- `format_iso(z)`: `YYYY-MM-DD` with a 4-digit zero-padded year, for example `0001-01-01`. Only called for in-range dates.
- `format_long(z)`: `"{Weekday}, {MonthName} {day}, {year}"`. Day and year are unpadded with no separators.
  - Examples: `Monday, January 1, 1`; `Friday, February 28, 2025`.
- `format_hms(secs)`: `HH:MM:SS`.
- Weekday names, ISO order: `Monday Tuesday Wednesday Thursday Friday Saturday Sunday`.
- Month names: `January` .. `December`.
- `plural(n, unit)`: `"{format_int(n)} {unit}"`, where the unit is singular iff `n == 1` and plural otherwise (including 0).
  - Units: `year(s)`, `month(s)`, `week(s)`, `day(s)`, `hour(s)`, `minute(s)`, `second(s)`, `business day(s)`, `business week(s)`, `calendar day(s)`, `weekend day(s)`, `holiday(s)`.
- `format_parts(&[(n, unit)])`:
  - Skips zero parts and joins the rest with `", "` (no "and").
  - If every part is zero, it returns `"0 {plural of LAST unit}"`, for example `0 days` or `0 seconds`.
  - Inputs are always >= 0.
- Unless stated otherwise, all text is English and ASCII-only.
- JSON outputs:
  - All numbers are integers.
  - JS must normalize `-0` to `0`.
  - Optional values are **explicit `null`, never omitted**.
  - Key order equals the Rust struct declaration order listed below.

---

## 5. Errors and envelope

### 5.1 Types

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CoreError { pub code: &'static str, pub field: Option<&'static str>, pub message: String }

#[derive(Serialize)]                 // Tauri command return type
pub struct Outcome<T: Serialize> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<CoreError>,
}
pub fn into_outcome<T: Serialize>(r: Result<T, CoreError>) -> Outcome<T>;
```

- Success: `{"ok":true,"result":{...}}`.
- Failure: `{"ok":false,"error":{"code":"invalid_day","field":"startDate","message":"Start date is not a real date: February 2023 has 28 days."}}`.

`ok` is a real JSON boolean. This deliberately differs from percent-core's string tag.

### 5.2 Error catalogue

`{L}` is the field label from the per-mode table in section 7.

| code | field | message (exact) |
|---|---|---|
| missing_date | date field | `{L} is required.` |
| invalid_date_format | date field | `{L} must be in YYYY-MM-DD format.` |
| date_out_of_range | date field | `{L} must be between 0001-01-01 and 9999-12-31.` |
| invalid_month | date field | `{L} is not a real date: month must be 01 to 12.` |
| invalid_day | date field | `{L} is not a real date: {MonthName} {YYYY} has {n} days.` (YYYY zero-padded to 4) |
| invalid_amount | amount field | `{L} must be a whole number.` |
| amount_out_of_range | amount field | `{L} must be between -{fmt max} and {fmt max}.` |
| missing_time | time field | `{L} is required.` |
| invalid_time | time field | `{L} must be a valid 24-hour time (HH:MM or HH:MM:SS).` |
| invalid_utc_offset | offset field | `{L} UTC offset must be between -1,080 and 1,080 minutes.` |
| invalid_weekend | `calendar.weekend` | `Weekend days must be distinct numbers from 1 (Monday) to 7 (Sunday).` |
| no_working_days | `calendar.weekend` | `At least one day of the week must be a working day.` |
| invalid_holiday / too_many_holidays / ... | `calendar.*` | defined by HOLIDAY spec |
| birth_after_as_of | `birthDate` | `Date of birth must be on or before the age-at date.` |
| result_out_of_range | null | `The result is outside the supported range (0001-01-01 to 9999-12-31).` |
| invalid_request | null | `Invalid request.` (serde failure: Tauri/bridge only; not parity-tested) |

**Validation order** (the first error wins):
1. Dates, in request field order.
2. Times and offsets.
3. Amounts, in the order years, months, weeks, days.
4. Calendar: weekend, then holidays.
5. Semantic checks (`birth_after_as_of`).
6. Computation (`result_out_of_range`).

---

## 6. Business calendar contract (`calendar.rs`)

```rust
pub struct Holiday { pub day: EpochDay, pub name: String }
pub trait HolidaySource {
    /// Sorted ascending, at most one entry per date (names merged with " / " in source order:
    /// presets in request order, then custom list order), every `day` inside calendar year `year`
    /// (observed dates that cross a year boundary, e.g. Fri 2021-12-31 for New Year 2022, belong to the
    /// year they fall in). Pure and deterministic. Called only for years 1..=9999.
    fn holidays_in_year(&self, year: i64) -> Vec<Holiday>;
}
#[derive(Clone, Copy)] pub struct WorkWeek(u8);        // bit (iso-1) set = weekend day
pub struct Calendar<'a> { pub week: WorkWeek, pub source: &'a dyn HolidaySource /* + per-year memo */ }

#[derive(Deserialize, Default)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarSpec {                 // JSON "calendar"
    #[serde(default = "sat_sun")] pub weekend: Vec<u8>,      // default [6,7]
    #[serde(default)] pub presets: Vec<String>,              // "us" | "uk-ew" | "eg" (HOLIDAY spec)
    #[serde(default)] pub custom_holidays: Vec<CustomHoliday>, // {date, name}; HOLIDAY spec validates
    #[serde(default)] pub islamic_adjust_days: i64,          // HOLIDAY spec (range, e.g. -2..=2)
}
pub fn build_calendar(spec: &CalendarSpec) -> Result<(WorkWeek, Box<dyn HolidaySource>), CoreError>;

pub fn is_business_day(cal: &Calendar, z: EpochDay) -> bool; // !weekend(z) && !holiday(z)
pub fn count_business_days(cal: &Calendar, from: EpochDay, to_excl: EpochDay) -> BusinessCount;
// BusinessCount { business: i64, weekend: i64, holiday: i64, listed: Vec<Holiday>, truncated: bool }
pub fn add_business_days(cal: &Calendar, start: EpochDay, n: i64) -> Result<BusinessStep, CoreError>;
// BusinessStep { date: EpochDay, skipped_weekend: i64, skipped_holidays: i64 }
```

**Classification of each day** (mutually exclusive, so nothing is double-counted):
- A weekend weekday counts as a **weekend** day, even if it is also a holiday.
- Otherwise a holiday date counts as a **holiday**.
- Otherwise the day is a **business** day.

**count_business_days on [from, to_excl)** (O(years)):
1. `n = to_excl - from`, `full = floor(n/7)`, `rem = n mod 7`.
2. `workdaysNoHol = full*wpw + #{i in 0..rem : !weekend(weekday(from+i))}`.
3. `weekend = n - workdaysNoHol`.
4. For each year `y` from `year(from)` to `year(to_excl - 1)`: for each holiday `h` with `from <= h < to_excl` and `!weekend(weekday(h))`, add 1 to `holiday` and push `h` to `listed`. Cap `listed` at **500** entries; set `truncated` beyond that.
5. `business = workdaysNoHol - holiday`.

**add_business_days(start, n)**
- **n == 0**: return `start` unchanged, even when `start` is not a business day. The caller reports `startIsBusinessDay`.
- **n > 0** (n < 0 is symmetric, walking backwards with year starts):
  - The start day is never counted.
  - Step one calendar day at a time. Each business day reached decrements the remaining count.
  - The result is the day where the remaining count reaches 0, so it is always a business day.
  - Production algorithm:
    1. `cursor = start+1`, `remaining = n`.
    2. Loop:
       - If `cursor > MAX`, fail with `result_out_of_range`.
       - Let `ye = min(Dec 31 of year(cursor), MAX)` and `c = count(cursor, ye+1).business`.
       - If `c < remaining`: `remaining -= c`, `cursor = ye+1`, and continue.
       - Otherwise walk day by day (at most 366 days) to the remaining-th business day.
  - `skipped_weekend` and `skipped_holidays` are the counts strictly between `start` and the result: `count(start+1, result)` forward, `count(result+1, start)` backward.
- **Reference oracle (tests only):** a naive day-by-day loop. Production must equal the oracle on every case.

---

## 7. Modes

Every request uses `#[serde(rename_all = "camelCase", deny_unknown_fields)]`. Each entry point is `pub fn calc_X(req: &XRequest) -> Result<XResult, CoreError>`. The Tauri commands `calc_X(req) -> Outcome<XResult>` are invoked as `invoke('calc_X', { req })`.

### 7.1 Days Between Two Dates: `calc_days_between`

Request: `{ "startDate": "2025-01-01", "endDate": "2025-12-31", "includeEndDay": false }`. `includeEndDay` defaults to false.

Labels: `startDate` is "Start date"; `endDate` is "End date".

Semantics:
1. `a = parse(start)`, `b = parse(end)`.
2. `direction` is `"same"` if `a == b`, `"forward"` if `a < b`, otherwise `"backward"`.
3. `lo = min(a,b)`, `hi = max(a,b)`, and `hiX = hi + (includeEndDay ? 1 : 0)`. `hiX` may equal MAX+1 (10000-01-01); this is allowed internally.
4. `totalDays = hiX - lo`, which is never negative.
5. `signedDays = (direction == "backward") ? -totalDays : totalDays`. For example, "same" with include gives +1.
6. The breakdown is `ymd_between(lo, hiX, Feb28)`. It is always computed from the earlier date toward the later one.
7. Other totals:
   - `weeks = floor(totalDays/7)`, `weekRemainderDays = totalDays mod 7`.
   - `totalHours = totalDays*24`, `totalMinutes = totalDays*1440`, `totalSeconds = totalDays*86400`.

Result (field order):
```
startDate, endDate (ISO, echo normalized), includeEndDay, direction, totalDays, signedDays,
years, months, days, totalMonths, weeks, weekRemainderDays, totalHours, totalMinutes, totalSeconds,
startWeekday, endWeekday, breakdownText, weeksText, summaryText, formulaText, copyText
```
- `breakdownText = format_parts([(years,year),(months,month),(days,day)])`
- `weeksText = format_parts([(weeks,week),(weekRemainderDays,day)])`
- `summaryText = plural(totalDays, day)`
- `formulaText = "{iso hi} - {iso lo}" + (include ? " + 1" : "") + " = " + summaryText`
- `copyText` (lines joined with `\n`, no trailing newline):
  ```
  From {startIso} ({startWeekday}) to {endIso} ({endWeekday})[, end date included]
  Total: {summaryText}
  Breakdown: {breakdownText}
  Weeks: {weeksText}
  Hours: {fmt totalHours}
  Minutes: {fmt totalMinutes}
  Seconds: {fmt totalSeconds}
  [Note: the end date is before the start date.]      <- only when backward
  ```

### 7.2 Add/Subtract from a Date: `calc_add_subtract`

Request:
```json
{ "date":"2025-01-31", "operation":"add", "years":"", "months":"1", "weeks":"", "days":"",
  "businessDays": false, "calendar": { "weekend":[6,7], "presets":[], "customHolidays":[], "islamicAdjustDays":0 } }
```
- `operation` is the serde enum `"add" | "subtract"`.
- The four amounts are **raw strings** from the inputs, parsed by `parse_amount`. They may be signed.
- `businessDays` defaults to false. `calendar` defaults to `CalendarSpec::default()` and is validated only when `businessDays` is true.

Labels: `date` is "Date"; the amounts are "Years", "Months", "Weeks" and "Days".

Effective amounts: `s = +1` for add, `-1` for subtract. `Y = s*years`, `Mo = s*months`, `W = s*weeks`, `D = s*days`.

**Calendar mode** (`businessDays = false`):
1. **Month step first, in one combined step:** `(c1, clamped) = add_months(civil(date), Y*12 + Mo, Feb28)`. This uses a single clamp, never one per field.
   - Example: 2023-01-31 + 1 year 1 month gives 2024-02-29. A stepwise approach would give 2024-02-28.
2. **Then the day step:** `result = days_from_civil(c1) + W*7 + D`.
3. The intermediate `c1` is **not** range-checked, so 9999-12-15 + 1 month - 30 days is valid. Only `result` is checked; outside the range it fails with `result_out_of_range`.
4. `monthClamped = clamped && (Y*12 + Mo) != 0`.
5. Subtraction is **not** the inverse of addition: 2025-01-31 + 1 month - 1 month = 2025-01-28.

**Business mode** (`businessDays = true`):
1. Validate the calendar.
2. Month step as above. The result `D1` **must** be in range; otherwise fail with `result_out_of_range`, because holidays are undefined outside the range.
3. Weeks mean **business weeks**: `N = W*wpw + D`. With a Sat/Sun weekend, 1 week = 5 business days. With Fri only, 1 week = 6. With no weekend, 1 week = 7.
4. `result = add_business_days(D1, N)`.
5. `startIsBusinessDay = is_business_day(D1)`.

Result (field order):
```
date, operation, businessDays, years, months, weeks, days        (effective signed ints Y, Mo, W, D)
resultDate, resultWeekday, resultLongText, calendarDaysDelta (= result - date), monthClamped,
businessStartDate (ISO of D1 | null), businessDayCount (N | null), startIsBusinessDay (bool | null),
skippedWeekendDays (int | null), skippedHolidays (int | null), expressionText, summaryText, copyText
```
In calendar mode, the five business fields are null.

`expressionText` is `"{dateIso}"`, then for each **non-zero** effective component in the order Y, Mo, W, D: `" + "` or `" - "` followed by `plural(|n|, unit)`. It ends with `" = {resultIso}"`.
- In business mode the units for W and D are `business week` and `business day`.
- If every component is 0, the term is `" + 0 days"` (or `" + 0 business days"` in business mode).
- Example: `2025-03-31 + 1 month - 1 day = 2025-04-29`.

`summaryText = resultLongText`.

`copyText`:
```
{expressionText}
Result: {resultLongText}
Calendar days moved: {fmt calendarDaysDelta}
[Note: the day was moved to the last day of the month.]               <- monthClamped
[Business days: {fmt N} (skipped {plural skW 'weekend day'}, {plural skH 'holiday'})]   <- business mode
[Note: the start date is not a business day.]                          <- business && N==0 && !startIsBusinessDay
```

### 7.3 Business Days Between: `calc_business_days`

Request: `{ "startDate", "endDate", "includeEndDay": false, "calendar": {...} }`.

Labels: as in 7.1.

Semantics:
- `lo`, `hi`, `hiX` and `direction` are defined exactly as in 7.1.
- The counted interval is **[lo, hiX)**: the earlier date is always counted, and the later date is counted only when `includeEndDay` is true.
  - Mon to Fri gives 4; with includeEndDay it gives 5, which matches Excel `NETWORKDAYS`.
- `BusinessCount = count_business_days(lo, hiX)`.
- `signedBusinessDays = backward ? -business : business`.

Result (field order):
```
startDate, endDate, includeEndDay, direction, weekend (sorted), calendarDays (= hiX-lo), businessDays,
signedBusinessDays, weekendDays, holidayDays, holidays [{date, name}] (<=500), holidaysTruncated,
summaryText, formulaText, copyText
```
- Invariant: `calendarDays = businessDays + weekendDays + holidayDays`.
- `summaryText = plural(businessDays, business day)`
- `formulaText = "{plural cal 'calendar day'} - {plural we 'weekend day'} - {plural ho 'holiday'} = {summaryText}"`
- `copyText`:
  ```
  From {startIso} ({wd}) to {endIso} ({wd})[, end date included]
  Business days: {fmt}
  Calendar days: {fmt}
  Weekend days: {fmt}
  Holidays on working days: {fmt}
  Weekend: {names joined ", " | "None"}
  [Holidays: {date} {name}; {date} {name}[; and {n} more]]     <- only if holidayDays > 0
  [Note: the end date is before the start date.]
  ```

### 7.4 Age: `calc_age`

Request: `{ "birthDate": "1990-05-15", "asOfDate": "2026-11-16", "leapDayRule": "feb28" }`.
- `leapDayRule` defaults to `"feb28"`.
- The UI pre-fills `asOfDate` with local today.

Labels: `birthDate` is "Date of birth"; `asOfDate` is "Age at date".

Semantics:
1. If `birth > asOf`, fail with `birth_after_as_of`.
2. `Ymd = ymd_between(birth, asOf, rule)`. The rule only matters for a Feb 29 birth date.
   - `feb28`: the birthday in common years is Feb 28 (the age increments on Feb 28).
   - `mar1`: it is Mar 1 (UK-style). Monthly anniversaries otherwise clamp normally.
3. Totals:
   - `totalDays = asOf - birth`.
   - `totalWeeks = floor(totalDays/7)`, plus `weekRemainderDays`.
   - `totalMonths = years*12 + months`, with the same `days` remainder.
   - `totalHours`, `totalMinutes` and `totalSeconds` are `totalDays` x 24, x 1440 and x 86400.
4. Next birthday, with `Y = years`:
   - If `Y >= 1` and `anniversary(birth, 12*Y, rule) == asOf`, it is **today**: `date = asOf`, `turningAge = Y`, `daysUntil = 0`, `isToday = true`.
   - Otherwise `nb = anniversary(birth, 12*(Y+1), rule)` and `turningAge = Y+1`. Being born today (`Y = 0`) is never "today is the birthday"; the next birthday is one year later.
   - If `nb > MAX`, `nextBirthday = null`.
   - The until-breakdown is `ymd_between(asOf, nb, Feb28)`, giving `years/months/days`. `untilText = format_parts(y,m,d)`, which is `"0 days"` when isToday.

Result (field order):
```
birthDate, asOfDate, leapDayRule, years, months, days, ageText, totalMonths, totalWeeks, weekRemainderDays,
totalDays, totalHours, totalMinutes, totalSeconds, bornWeekday,
nextBirthday: { date, weekday, longText, turningAge, daysUntil, years, months, days, untilText, isToday } | null,
summaryText, copyText
```
- `ageText = format_parts(y,m,d)`
- `summaryText = plural(years, year) + " old"`, for example `0 years old` or `1 year old`.
- `copyText`:
  ```
  Born {birthIso} ({bornWeekday}), age on {asOfIso}
  Age: {ageText}
  In months: {format_parts([(totalMonths,month),(days,day)])}
  In weeks: {format_parts([(totalWeeks,week),(weekRemainderDays,day)])}
  In days: {plural(totalDays, day)}
  Next birthday: {iso} ({wd}), turning {n}, in {plural daysUntil day} ({untilText})
     | Next birthday: today, {iso} ({wd}), turning {n}
     | Next birthday: after 9999-12-31 (outside the supported range)
  [Leap-day birthday: celebrated on February 28 in common years.]   <- birth is Feb 29, rule feb28
  [Leap-day birthday: celebrated on March 1 in common years.]       <- birth is Feb 29, rule mar1
  ```

### 7.5 Day of Week / Date Info: `calc_date_info`

Request: `{ "date": "2026-11-16", "today": "2026-11-13" }`. `today` is optional; it may be null or omitted.

Labels: `date` is "Date"; `today` is "Today's date".

Result (field order):
```
date, weekday, isoWeekday (1..7), longText, year, month, day, monthName, dayOfYear, daysInYear,
daysRemainingInYear (= daysInYear - dayOfYear; excludes the date itself; Dec 31 -> 0), daysInMonth,
quarter (= floor((month-1)/3)+1), isLeapYear, isoWeekYear, isoWeek, isoWeeksInYear (of isoWeekYear),
isoWeekText ("YYYY-Www-D", YYYY padded 4), ordinalText ("YYYY-DDD"), epochDay, unixTimestamp
(= epochDay*86400, 00:00 UTC), julianDayNumber (= epochDay + 2440588, JDN at noon UT), daysFromToday
(date - today | null), relativeText ("Today" | "In {plural n day}" | "{plural |n| day} ago" | null), copyText
```
`copyText`:
```
{longText}
ISO date: {iso}
ISO week: {isoWeekText}
Ordinal date: {ordinalText}
Day of year: {dayOfYear} of {daysInYear} ({plural remaining day} remaining)
Quarter: Q{q}
Leap year: Yes|No
Days in month: {n}
Unix day number: {epochDay}               <- plain integer, no separators
Unix timestamp (00:00 UTC): {unixTimestamp}  <- plain integer, no separators
Julian Day Number: {jdn}                  <- plain integer, no separators
[Relative to today: {relativeText}]
```

### 7.6 Countdown: `calc_countdown`

The UI calls this once per second; the core is pure.

Request:
```json
{ "now":    { "date":"2026-11-16", "time":"12:00:00", "utcOffsetMinutes": 0 },
  "target": { "date":"2026-12-25", "time":"",         "utcOffsetMinutes": 0 } }
```
Labels: "Current date", "Current time", "Target date", "Target time".
- `now.time` is required.
- `target.time` is optional; empty or missing means 00:00:00.
- Each offset is the UI's offset for *that* instant: `-new Date(y, m-1, d, hh, mm, ss).getTimezoneOffset()`. This makes the result correct across DST.

Semantics:
1. `N = nowDay*86400 + nowSecs - nowOff*60`.
2. `T = tgtDay*86400 + tgtSecs - tgtOff*60`.
3. `totalSeconds = T - N`.
4. `status` is `"future"` if positive, `"past"` if negative, `"now"` if zero.
5. `A = |totalSeconds|`:
   - `days = floor(A/86400)`, `hours = floor((A mod 86400)/3600)`, `minutes = floor((A mod 3600)/60)`, `seconds = A mod 60`.
   - `totalHours = floor(A/3600)`, `totalMinutes = floor(A/60)`.

Result (field order):
```
nowDate, nowTime, targetDate, targetTime (HH:MM:SS), targetWeekday, status, totalSeconds (signed),
days, hours, minutes, seconds, totalHours, totalMinutes, text, clockText, summaryText, copyText
```
- `text = format_parts([(d,day),(h,hour),(m,minute),(s,second)])`
- `clockText = "{fmt days}d {HH}h {MM}m {SS}s"`
- `summaryText`:
  - future: `"{text} until {tIso} {tTime} ({wd})"`
  - past: `"{text} since {tIso} {tTime} ({wd})"`
  - now: `"The target time is now: {tIso} {tTime} ({wd})"`
- `copyText = summaryText + "\nClock: " + clockText + "\nTotal: " + plural(A, second)`

---

## 8. Bridge (`examples/eval_bridge.rs`)

- Framing matches percent-core: NDJSON, 64 KiB line cap, flush per line.
- Request: `{"id":<any>,"op":"calc_days_between"|"calc_add_subtract"|"calc_business_days"|"calc_age"|"calc_date_info"|"calc_countdown"|"format_int"|"parse_date"|"parse_amount"|"parse_time","req":{...}}`.
- Helper requests:
  - `format_int` takes `{"n":int}`.
  - `parse_date` takes `{"raw":str,"field":"startDate"}`.
  - `parse_amount` takes `{"raw":str,"field":"years"}`.
  - `parse_time` takes `{"raw":str,"field":"target.time","required":bool}`.
- Response:
  - `{"id":..,"ok":true,"result":{...}}`
  - or `{"id":..,"ok":false,"error":{code,field,message}}`
  - Serde failures return `invalid_request`.

---

## 9. JS mirror (mobile/index.html) parity rules

1. The engine sits between `/* date-core:begin v1.0.0 */` and `/* date-core:end */` inside the inline script. CI extracts it and runs it in `node:vm` with no DOM and no `Date`.
2. It exports the same entry points: `calcDaysBetween(req)`, `calcAddSubtract`, `calcBusinessDays`, `calcAge`, `calcDateInfo`, `calcCountdown`, `formatInt`, `parseDate`, `parseAmount` and `parseTime`.
   - Each `calc*` function returns exactly the `Outcome` JSON shape (`{ok:true,result}` or `{ok:false,error}`).
   - Errors are returned, not thrown.
3. Arithmetic rules:
   - Use integer-only helpers `div(a,b)=Math.floor(a/b)` and `mod(a,b)=((a%b)+b)%b`.
   - No `Date`, `Intl` or `toLocaleString` inside the engine.
   - No floating-point fractional values.
   - Normalize `-0` to `0` before output.
4. String rules:
   - `[0-9]` regexes without the `u` flag.
   - The ASCII trim from 3.1.
   - Count name lengths in code points with `Array.from(s).length` (HOLIDAY spec).
5. Object rules:
   - Build objects in the documented key order.
   - Set optional values to `null` explicitly; never use `undefined`.
6. Parity checks:
   - CI compares the **canonical JSON** (recursively key-sorted `JSON.stringify`) of the JS and Rust outcomes.
   - CI also compares raw `JSON.stringify` against the Rust bytes to enforce key order.
   - This must hold for every `parity.json` case and every case in the random safety-eval.
7. Desktop `ui/main.js` contains **no math** and always calls `invoke`. The Countdown mode invokes once per second.

---

## 10. Testing

- **chrono oracle** (`tests/oracle_chrono.rs`): exhaustive over all 3,652,059 days.
  - `civil_from_days(z) == NaiveDate::from_num_days_from_ce_opt(z + 719_163)`.
  - Weekday, ordinal, `iso_week()` (year and week) and the leap year flag match chrono.
  - `add_months` equals `checked_add_months` / `checked_sub_months`, which clamp, for k in -30..=30 on a grid of 50k dates (Feb28 rule).
- **Brute force:**
  - `ymd_between` equals the max-M search for pairs (a, b) with a in 1999-12..2001-03, b up to a+800 days, under both rules.
  - `add_business_days` and `count_business_days` equal naive loops for random cases with random weekend masks and random custom holiday sets.
- **Fixtures:**
  - `tests/fixtures/vectors.json` holds the section 12 vectors as partial-field expectations, written by hand and never regenerated. These guard *correctness*.
  - `tests/fixtures/parity.json` holds about 5,000 seeded cases generated through the Rust bridge, with full outcomes. These guard *JS == Rust*.
  - `scripts/safety-eval.mjs` runs both engines on additional random and adversarial inputs: Unicode digits, whitespace variants, 20-digit amounts, boundary dates and all weekend masks.

## 11. Invariants (property tests)

1. `days_from_civil(civil_from_days(z)) == z`.
2. `iso_weekday(z+7) == iso_weekday(z)`.
3. Days between: `signedDays(a,b) == -signedDays(b,a)` (includeEndDay false). `totalDays(include) == totalDays(exclude) + 1`.
4. `days_from_civil(add_months(lo, totalMonths, Feb28)) + days == hiX`, and `anniversary(lo, totalMonths+1) > hiX`.
5. Business count additivity: `count[a,b) + count[b,c) == count[a,c)`.
6. For N > 0, `r = add(D, N)`: `count[D+1, r+1).business == N` and `is_business_day(r)`. The mirror holds for N < 0.
7. `calendarDays == business + weekend + holiday`.
8. Age: `isToday || nextBirthday.date > asOf`. `daysUntil <= 366`. `turningAge == years + (isToday ? 0 : 1)`.
9. Countdown: `|totalSeconds| == days*86400 + hours*3600 + minutes*60 + seconds`.
10. Calendar-mode add with only weeks and days: `add(add(d, +x), -x) == d`.

---

## 12. Golden vectors

Weekend is `[6,7]` and there are no presets unless stated. `H[...]` lists custom holidays. Every value below was computed and cross-checked (section 0).

### 12.1 Parsing and formatting

| # | call | expected |
|---|---|---|
| P1 | parse_date("2023-02-29", startDate) | invalid_day `Start date is not a real date: February 2023 has 28 days.` |
| P2 | parse_date("2025-1-05", startDate) | invalid_date_format `Start date must be in YYYY-MM-DD format.` |
| P3 | parse_date("0000-12-31", startDate) | date_out_of_range `Start date must be between 0001-01-01 and 9999-12-31.` |
| P4 | parse_date("2025-13-01", startDate) | invalid_month `Start date is not a real date: month must be 01 to 12.` |
| P5 | parse_date("  ", startDate) | missing_date `Start date is required.` |
| P6 | parse_date(" 2025-01-01\t", date) | ok 20089 |
| P7 | parse_date("1900-02-29", date) | invalid_day `Date is not a real date: February 1900 has 28 days.` |
| P8 | parse_date("2025-04-31", date) / ("2025-01-00") | `... April 2025 has 30 days.` / `... January 2025 has 31 days.` |
| P9 | parse_date("2025/01/01") / ("10000-01-01") / ("２０２５-01-01") | invalid_date_format |
| P10 | parse_date("2024-02-29") / ("0001-01-01") / ("9999-12-31") | 19782 / -719162 / 2932896 |
| P11 | parse_amount("", years) / (" +007 ") / ("-0") | 0 / 7 / 0 |
| P12 | parse_amount("1.5"\|"1e3"\|"1,000"\|"+"\|"--1"\|"٣", years) | invalid_amount `Years must be a whole number.` |
| P13 | parse_amount("10000", years) | amount_out_of_range `Years must be between -9,999 and 9,999.` |
| P14 | parse_amount("3652059", days) / ("99999999999999999999", days) | `Days must be between -3,652,058 and 3,652,058.` (both) |
| P15 | parse_amount("-3652058", days) / ("119988", months) | ok -3652058 / ok 119988 |
| P16 | parse_time("23:59") / ("07:05") / ("", target, not required) | 86340 / 25500 / 0 |
| P17 | parse_time("24:00") / ("7:05") / ("23:59:60") | invalid_time `Target time must be a valid 24-hour time (HH:MM or HH:MM:SS).` |
| P18 | format_int 0 / 999 / 1000 / -1234567 / 315537897600 | `0` `999` `1,000` `-1,234,567` `315,537,897,600` |
| P19 | weekend [7,7] / [0] / [1,2,3,4,5,6,7] / [] | invalid_weekend / invalid_weekend / no_working_days / ok (wpw 7) |

### 12.2 Days Between

Columns: start -> end, include | direction, totalDays, signedDays, breakdownText, weeksText, other.

| # | input | expected |
|---|---|---|
| V1 | 2025-01-01 -> 2025-12-31, F | forward, 364, 364, `11 months, 30 days`, `52 weeks`; hours 8736, minutes 524160, seconds 31449600 |
| V2 | same, T | 365, `1 year`, `52 weeks, 1 day`; totalMonths 12; seconds 31536000; formulaText `2025-12-31 - 2025-01-01 + 1 = 365 days` |
| V3 | 2023-01-31 -> 2023-03-01, F | 29, `1 month, 1 day`, `4 weeks, 1 day` |
| V4 | 2024-01-31 -> 2024-03-01, F | 30, `1 month, 1 day`, `4 weeks, 2 days` |
| V5 | 2023-01-31 -> 2023-02-28, F | 28, `1 month`, `4 weeks` |
| V6 | 2023-01-31 -> 2023-02-27, F | 27, `27 days`, `3 weeks, 6 days` |
| V7 | 2024-02-29 -> 2025-02-28, F | 365, `1 year` |
| V8 | 2024-02-29 -> 2028-02-29, F | 1461, `4 years`, `208 weeks, 5 days`; totalMonths 48 |
| V9 | 2025-03-15 -> 2025-01-10, F | backward, 64, -64, `2 months, 5 days`, `9 weeks, 1 day`; formula `2025-03-15 - 2025-01-10 = 64 days`; copy ends `Note: the end date is before the start date.` |
| V10 | same, T | backward, 65, -65, `2 months, 6 days`, `9 weeks, 2 days` |
| V11 | 2025-06-01 -> 2025-06-01, F | same, 0, 0, `0 days`, `0 days` |
| V12 | same, T | same, 1, 1, `1 day`, `1 day`; hours 24 |
| V13 | 0001-01-01 -> 9999-12-31, F | 3652058, `9,998 years, 11 months, 30 days`, `521,722 weeks, 4 days`; totalMonths 119987; seconds 315537811200 |
| V14 | same, T | 3652059, `9,999 years`, `521,722 weeks, 5 days`; totalMonths 119988; hours 87649416; minutes 5258964960; seconds 315537897600 |
| V15 | 1900-02-28 -> 1900-03-01, F | 1, `1 day` (1900 is not a leap year) |
| V16 | 2000-02-28 -> 2000-03-01, F | 2, `2 days` (2000 is a leap year) |
| V17 | 2025-03-31 -> 2025-04-30, F | 30, `1 month`, `4 weeks, 2 days` |
| V18 | 2023-01-28 -> 2023-02-28, F | 31, `1 month`, `4 weeks, 3 days` |

V1 full copyText:
```
From 2025-01-01 (Wednesday) to 2025-12-31 (Wednesday)
Total: 364 days
Breakdown: 11 months, 30 days
Weeks: 52 weeks
Hours: 8,736
Minutes: 524,160
Seconds: 31,449,600
```

### 12.3 Add/Subtract, calendar mode

| # | input (amount strings; blank = "") | resultDate / weekday | delta | monthClamped | expressionText |
|---|---|---|---|---|---|
| A1 | 2025-01-31 add months 1 | 2025-02-28 Fri | 28 | true | `2025-01-31 + 1 month = 2025-02-28` |
| A2 | 2024-01-31 add months 1 | 2024-02-29 Thu | 29 | true | |
| A3 | 2024-02-29 add years 1 | 2025-02-28 Fri | 365 | true | |
| A4 | 2024-02-29 add years 4 | 2028-02-29 Tue | 1461 | false | |
| A5 | 2023-01-31 add years 1 months 1 | 2024-02-29 Thu | 394 | true | (combined step; stepwise would give 02-28) |
| A6 | 2025-03-31 subtract months 1 | 2025-02-28 Fri | -31 | true | `2025-03-31 - 1 month = 2025-02-28` |
| A7 | 2025-01-01 add weeks 1 days 3 | 2025-01-11 Sat | 10 | false | `2025-01-01 + 1 week + 3 days = 2025-01-11` |
| A8 | 2025-03-31 add months 1 days -1 | 2025-04-29 Tue | 29 | true | `2025-03-31 + 1 month - 1 day = 2025-04-29` |
| A9 | 0001-01-01 subtract days 1 | error result_out_of_range | | | |
| A10 | 9999-12-31 add days 1 | error result_out_of_range | | | |
| A11 | 9999-12-15 add months 1 days -30 | 9999-12-16 Thu | 1 | false | (intermediate 10000-01-15 allowed) |
| A12 | 2025-01-01 subtract days -10 | 2025-01-11 Sat | 10 | false | `2025-01-01 + 10 days = 2025-01-11` (effective days = 10) |
| A13 | 2000-01-01 add years 7999 | 9999-01-01 Fri | 2921575 | false | |
| A14 | 9999-12-31 subtract years 9998 months 11 days 30 | 0001-01-01 Mon | -3652058 | false | resultLongText `Monday, January 1, 1` |
| A15 | 2025-05-31 subtract years 1 months 3 weeks 2 | 2024-02-15 Thu | -471 | true | `2025-05-31 - 1 year - 3 months - 2 weeks = 2024-02-15` |
| A16 | 2025-01-01 add (all blank) | 2025-01-01 Wed | 0 | false | `2025-01-01 + 0 days = 2025-01-01` |
| A17 | 2025-01-01 add years "10000" | error amount_out_of_range (Years) | | | |

### 12.4 Add/Subtract, business mode (`businessDays: true`)

| # | input | resultDate | delta | skW | skH | startIsBusinessDay |
|---|---|---|---|---|---|---|
| B1 | 2025-01-03 (Fri) add days 1 | 2025-01-06 Mon | 3 | 2 | 0 | true |
| B2 | 2025-01-04 (Sat) add days 0 | 2025-01-04 | 0 | 0 | 0 | **false**; expression `2025-01-04 + 0 business days = 2025-01-04` |
| B3 | 2025-01-04 (Sat) add days 1 | 2025-01-06 Mon | 2 | 1 | 0 | false |
| B4 | 2025-12-22 (Mon) add days 5, H[2025-12-25, 2025-12-26] | 2025-12-31 Wed | 9 | 2 | 2 | true |
| B5 | 2025-01-06 (Mon) subtract days 1 | 2025-01-03 Fri | -3 | 2 | 0 | true |
| B6 | weekend [5,6]: 2025-01-02 (Thu) add days 1 | 2025-01-05 Sun | 3 | 2 | 0 | true |
| B7 | 2025-01-01 (Wed) add weeks 2 (N = 10) | 2025-01-15 Wed | 14 | 4 | 0 | true; expression `2025-01-01 + 2 business weeks = 2025-01-15` |
| B8 | 2025-01-31 add months 1 days 1 | 2025-03-03 Mon (businessStartDate 2025-02-28) | 31 | 2 | 0 | true |
| B9 | 2025-01-04 (Sat) subtract days 1 | 2025-01-03 Fri | -1 | 0 | 0 | false |
| B10 | weekend [5]: 2025-01-01 add days 260 | 2025-11-01 Sat | 304 | 44 | 0 | true |
| B11 | 9999-12-30 add days 2 | error result_out_of_range | | | | |
| B12 | weekend []: 2025-01-05 (Sun) add days 0 | 2025-01-05 | 0 | 0 | 0 | true |
| B13 | 2025-01-01 add days 1, H[2025-01-02] | 2025-01-03 Fri | 2 | 0 | 1 | true |
| B14 | 2025-01-03 subtract days 5, H[2025-01-01] | 2024-12-26 Thu | -8 | 2 | 1 | true |
| B15 | 2024-12-31 subtract days 1, H[2024-12-30] | 2024-12-27 Fri | -4 | 2 | 1 | true |
| B16 | weekend [1,2,3,4,5,6,7] | error no_working_days | | | | |

### 12.5 Business Days Between

| # | input | direction | calendarDays | business | weekend | holiday | signed |
|---|---|---|---|---|---|---|---|
| C1 | 2025-01-01 -> 2025-01-31, F | forward | 30 | 22 | 8 | 0 | 22 |
| C2 | same, T | forward | 31 | 23 | 8 | 0 | 23 |
| C3 | same, T, H[2025-01-01 "New Year's Day", 2025-01-20 "Martin Luther King Jr. Day"] | forward | 31 | 21 | 8 | 2 | 21; formula `31 calendar days - 8 weekend days - 2 holidays = 21 business days` |
| C4 | 2025-01-31 -> 2025-01-01, F | backward | 30 | 22 | 8 | 0 | -22 |
| C5 | 2025-01-01 -> 2025-01-31, T, H[2025-01-04 (Sat)] | forward | 31 | 23 | 8 | 0 | 23; holidays [] |
| C6 | 2025-01-06 -> 2025-01-13, F | forward | 7 | 5 | 2 | 0 | 5 |
| C7 | 2025-01-04 -> 2025-01-04, T | same | 1 | 0 | 1 | 0 | 0 |
| C8 | 2025-01-04 -> 2025-01-04, F | same | 0 | 0 | 0 | 0 | 0 |
| C9 | 2025-01-01 -> 2025-12-31, T | forward | 365 | 261 | 104 | 0 | 261 |
| C10 | same, weekend [5,6] | forward | 365 | 261 | 104 | 0 | 261 |
| C11 | 0001-01-01 -> 9999-12-31, T | forward | 3652059 | 2608615 | 1043444 | 0 | 2608615 |
| C12 | 2025-01-31 -> 2025-01-01, T | backward | 31 | 23 | 8 | 0 | -23 |
| C13 | 2025-01-01 -> 2025-12-31, T, weekend [5] | forward | 365 | 313 | 52 | 0 | 313 |
| C14 | 2025-01-01 -> 2025-01-31, T, weekend [] | forward | 31 | 31 | 0 | 0 | 31 |
| C15 | as C3 but 2025-01-01 listed twice | forward | 31 | 21 | 8 | 2 | 21; holidays list length 2 |

### 12.6 Age

| # | birth / asOf / rule | ageText | totals | nextBirthday |
|---|---|---|---|---|
| G1 | 2000-02-29 / 2001-02-28 / feb28 | `1 year` | days 365, months 12, weeks 52 + 1 | isToday, 2001-02-28 Wed, turning 1, 0 days, untilText `0 days`; summary `1 year old` |
| G2 | 2000-02-29 / 2001-02-28 / mar1 | `11 months, 30 days` | days 365 | 2001-03-01 Thu, turning 1, in 1 day (`1 day`); summary `0 years old` |
| G3 | 2000-02-29 / 2001-03-01 / mar1 | `1 year` | days 366 | isToday, turning 1 |
| G4 | 2000-02-29 / 2004-02-29 / mar1 | `4 years` | days 1461, months 48 | isToday, turning 4 |
| G5 | 1990-05-15 / 2026-11-16 / feb28 | `36 years, 6 months, 1 day` | months 438 (+1 d), weeks 1904 + 6, days 13334, born Tuesday | 2027-05-15 Sat, turning 37, 180 days, `5 months, 29 days` |
| G6 | 2026-11-16 / 2026-11-16 | `0 days` | all 0, born Monday | 2027-11-16 Tue, turning 1, 365 days, `1 year` (not isToday) |
| G7 | 1990-01-31 / 2026-02-28 | `36 years, 1 month` | months 433, days 13177 | 2027-01-31 Sun, turning 37, 337 days, `11 months, 3 days` |
| G8 | 2000-02-29 / 2003-12-01 / feb28 | `3 years, 9 months, 2 days` | days 1371 | 2004-02-29 Sun, turning 4, 90 days, `2 months, 28 days` |
| G9 | same / mar1 | identical to G8 | | |
| G10 | 9999-06-01 / 9999-07-01 | `1 month` | days 30 | null |
| G11 | 1985-12-31 / 2026-01-30 | `40 years, 30 days` | months 480 (+30 d), days 14640 | 2026-12-31 Thu, turning 41, 335 days, `11 months, 1 day` |
| G12 | 2000-02-29 / 2001-01-29 / mar1 | `11 months` | days 335 | 2001-03-01, 31 days, `1 month, 1 day` |
| G13 | 2000-02-29 / 2001-02-27 / feb28 | `11 months, 29 days` | days 364 | 2001-02-28, 1 day |
| G14 | 2026-11-17 / 2026-11-16 | error birth_after_as_of `Date of birth must be on or before the age-at date.` | | |

### 12.7 Date Info

| # | date | weekday | isoWeekText (weeks in ISO yr) | doy/diy, remaining | Q | leap | epochDay | unixTimestamp | JDN |
|---|---|---|---|---|---|---|---|---|---|
| I1 | 2025-01-01 | Wednesday | 2025-W01-3 (52) | 1/365, 364 | 1 | No | 20089 | 1735689600 | 2460677 |
| I2 | 2024-12-30 | Monday | 2025-W01-1 (52) | 365/366, 1 | 4 | Yes | 20087 | 1735516800 | 2460675 |
| I3 | 2021-01-03 | Sunday | 2020-W53-7 (53) | 3/365, 362 | 1 | No | 18630 | 1609632000 | 2459218 |
| I4 | 2026-12-31 | Thursday | 2026-W53-4 (53) | 365/365, 0 | 4 | No | 20818 | 1798675200 | 2461406 |
| I5 | 1970-01-01 | Thursday | 1970-W01-4 (53) | 1/365, 364 | 1 | No | 0 | 0 | 2440588 |
| I6 | 0001-01-01 | Monday | 0001-W01-1 (52) | 1/365, 364 | 1 | No | -719162 | -62135596800 | 1721426 |
| I7 | 9999-12-31 | Friday | 9999-W52-5 (52) | 365/365, 0 | 4 | No | 2932896 | 253402214400 | 5373484 |
| I8 | 2024-12-31 | Tuesday | 2025-W01-2 (52) | 366/366, 0 | 4 | Yes | 20088 | 1735603200 | 2460676 |
| I9 | 2000-03-01 | Wednesday | 2000-W09-3 (52) | 61/366, 305 | 1 | Yes | 11017 | 951868800 | 2451605 |
| I10 | 2020-12-31 | Thursday | 2020-W53-4 (53) | 366/366, 0 | 4 | Yes | 18627 | 1609372800 | 2459215 |
| I11 | 2027-01-01 | Friday | 2026-W53-5 (53) | 1/365, 364 | 1 | No | 20819 | 1798761600 | 2461407 |
| I12 | 2008-12-29 | Monday | 2009-W01-1 (53) | 364/366, 2 | 4 | Yes | 14242 | 1230508800 | 2454830 |
| I13 | 1600-02-29 | Tuesday | 1600-W09-2 (52) | 60/366, 306 | 1 | Yes | -135081 | -11670998400 | 2305507 |
| I14 | 2026-11-16, today 2026-11-13 | Monday | 2026-W47-1 (53) | 320/365, 45 | 4 | No | 20773 | 1794787200 | 2461361 |

- I14: daysInMonth 30, ordinalText `2026-320`, daysFromToday 3, relativeText `In 3 days`. With today = 2026-11-16 it gives 0 and `Today`; with today = 2026-11-17 it gives -1 and `1 day ago`.
- I6: longText is `Monday, January 1, 1`.

### 12.8 Countdown

| # | now (date time off) | target (date time off) | status | totalSeconds | text | clockText |
|---|---|---|---|---|---|---|
| K1 | 2026-11-16 12:00:00 +0 | 2026-12-25 "" +0 | future | 3326400 | `38 days, 12 hours` | `38d 12h 00m 00s` |
| K2 | 2026-11-16 00:00:01 +0 | 2026-11-15 23:59:59 +0 | past | -2 | `2 seconds` | `0d 00h 00m 02s` |
| K3 | 2026-11-16 08:30:00 +120 | 2026-11-16 08:30 +120 | now | 0 | `0 seconds` | `0d 00h 00m 00s` |
| K4 (DST) | 2026-03-07 12:00:00 -300 | 2026-03-09 12:00:00 -240 | future | 169200 | `1 day, 23 hours` | `1d 23h 00m 00s` |
| K5 | 2026-11-16 23:59:59 +0 | 2027-01-01 00:00 +0 | future | 3888001 | `45 days, 1 second` | `45d 00h 00m 01s` |
| K6 | 2000-01-01 00:00:00 +0 | 1999-12-31 +0 | past | -86400 | `1 day` | `1d 00h 00m 00s` |
| K7 | 0001-01-01 00:00:00 +0 | 9999-12-31 23:59:59 +0 | future | 315537897599 | `3,652,058 days, 23 hours, 59 minutes, 59 seconds` | `3,652,058d 23h 59m 59s` |
| K8 | 2026-11-16 10:00:00 +120 | 2026-11-16 09:00:00 +0 | future | 3600 | `1 hour` | `0d 01h 00m 00s` |
| K9 | any | time "24:00" | error invalid_time (Target time) | | | |
| K10 | any | time "07:05" | targetTime normalized `07:05:00` | | | |

Further details:
- K1: totalHours 924, totalMinutes 55440. summaryText is `38 days, 12 hours until 2026-12-25 00:00:00 (Friday)`.
- K2: summaryText is `2 seconds since 2026-11-15 23:59:59 (Sunday)`.
- K3: summaryText is `The target time is now: 2026-11-16 08:30:00 (Monday)`.

---

## 13. Decisions needing confirmation

1. **Month-end convention.** The clamped anniversary walk is used, so 2023-01-31 -> 2023-02-28 is "1 month". calculator.net and Java `Period` say "28 days".
2. **Leap-day birthdays.** The default is `feb28`, with `mar1` offered as a toggle in Age only.
3. **includeEndDay semantics.** It adds the later date for both Days Between and Business Days (the earlier date is always counted). The UI default is unchecked.
4. **Business weeks.** In business mode, 1 week = `wpw` business days.
5. **Range errors.** Out-of-range results are errors, never clamped. Intermediate dates may leave the range in calendar mode only.
6. **Text language.** All output text is English and ASCII. No localization or Arabic-Indic digits in v1.0.0.


## Open risks
- Month-end convention (clamped anniversary walk) gives 'Jan 28/29/30/31 -> Feb 28 = 1 month' and differs from calculator.net / Java Period (Jan 31 -> Feb 28 = 28 days); user should confirm before golden fixtures are frozen.
- Leap-day birthday default (feb28 vs mar1) is a jurisdiction-dependent choice; spec ships both with feb28 default - needs user sign-off.
- Holiday contract (HolidaySource::holidays_in_year, CalendarSpec presets/customHolidays/islamicAdjustDays, name merging with ' / ', observed dates crossing year boundaries, custom-holiday validation messages/limits) is only interface-defined here; the separate HOLIDAY spec must match it exactly or business-day results will diverge between Rust and JS.
- Business-day add over very long spans with presets requires up to ~10,000 holidays_in_year expansions; in the mobile JS live-update path this may be slow without a per-year memo and input debounce, especially for Egypt Islamic approximations.
- Countdown DST correctness depends on the UI computing utcOffsetMinutes for both now and target with the correct sign (negated getTimezoneOffset) and on browser resolution of nonexistent/ambiguous local times during DST transitions; the core cannot detect a wrong offset.
- Byte-for-byte parity hazards in the JS mirror: Unicode-aware trim/regex, toLocaleString, -0 output, undefined vs null optional fields, key order, and code-unit vs code-point length counting for holiday names; CI must compare both canonical and raw JSON.
- parity.json is generated by the Rust bridge, so it proves JS==Rust but not correctness; correctness rests on the hand-verified vectors.json, the chrono oracle and brute-force tests - vectors.json must never be regenerated from code.
- Tauri IPC serde deserialization failures (e.g., wrong JSON types, unknown fields) produce 'invalid_request' outside the parity-tested path; the UI must always send well-formed requests.
- Proleptic Gregorian dates before 1582 (and before 1752 for UK users) do not match historical calendars; no Julian-calendar support or warning is specified.
- Arabic-Indic / fullwidth digits are rejected by parse_amount/parse_date; Egyptian users on mobile keyboards may hit 'must be a whole number' unless the UI normalizes digits (out of core scope).
- Weeks-as-business-weeks semantics (1 week = wpw business days) in Add business mode may surprise users expecting 7 calendar days; needs clear UI labelling ('business weeks').
- Subtraction is not the inverse of addition with month clamping (Jan 31 +1m -1m = Jan 28); expected behaviour but should be documented in the UI/About text.
