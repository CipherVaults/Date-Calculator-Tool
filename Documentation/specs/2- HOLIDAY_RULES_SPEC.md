# date-core Holiday + Weekend Rules Spec (v1.0.0)

# date-core: Holiday and Weekend Rules Spec (Date Calculator Tool v1.0.0)

Status: planning spec, read-only. Every date vector below was recomputed with integer reference implementations of the algorithms in section 2 (Node, no files written) and cross-checked by hand against weekday arithmetic and the published lists (calculator.net US 2026, gov.uk E&W 2026/2027). Rust `date-core` is the source of truth. The mobile inline JS engine is a line-for-line port inside `/* DATE-CORE PARITY BEGIN/END */` markers, as in percent-core.

---

## 1. Principles

1. **Pure integer arithmetic.** No floats, no `chrono`, no `Date` objects in the engine. Dates are `i32` day numbers (days since 1970-01-01, which is day 0). JS uses the same numbers and stays inside the safe-integer range.
2. **Floor division everywhere.** Rust uses `div_euclid`/`rem_euclid`. JS uses the helpers `fdiv(a,b)=Math.floor(a/b)` and `fmod(a,b)=((a%b)+b)%b`. Bare `/` and `%` on values that can be negative are banned in the parity block. A CI grep in `node -e` checks this.
3. **Supported holiday years: 1900..=2199** (`HOLIDAY_MIN_YEAR`, `HOLIDAY_MAX_YEAR`). Each preset also has a `min_year` floor, the first year its rule set is complete. Outside `[max(1900, preset.min_year), 2199]` the preset emits nothing and the result carries the warning `presetYearOutOfRange`. Business-day maths still runs, using the weekend mask only.
4. **Rules are static data plus a handful of algorithm kinds.** Nothing is fetched from the network and there are no per-year tables, except the UK one-off table (section 4.2).
5. **Legal observance is independent of the user's weekend mask.** US and UK shifts are defined against Sat/Sun by statute or proclamation, whatever weekend the user picks.

---

## 2. Core primitives (identical in Rust and JS)

### 2.1 Civil date <-> day number (Hinnant algorithm)
```
days_from_civil(y,m,d):
  y -= (m <= 2) ? 1 : 0
  era = fdiv(y, 400); yoe = y - era*400
  doy = fdiv(153*(m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1
  doe = yoe*365 + fdiv(yoe,4) - fdiv(yoe,100) + doy
  return era*146097 + doe - 719468
civil_from_days(z): the inverse, also Hinnant
weekday(z) = fmod(z + 3, 7)        // Mon=0 .. Sun=6  (1970-01-01 = Thu = 3)
```
Helpers:
- `nth_weekday(y,m,wd,n) = first + fmod(wd - weekday(first), 7) + 7*(n-1)`, where `first = days_from_civil(y,m,1)`.
- `last_weekday(y,m,wd) = L - fmod(weekday(L) - wd, 7)`, where `L` is the last day of month `m`.

### 2.2 Gregorian (Western) Easter: anonymous Gregorian algorithm (Meeus/Jones/Butcher)
```
a=Y%19; b=Y/100; c=Y%100; d=b/4; e=b%4; f=(b+8)/25; g=(b-f+1)/3
h=(19a+b-d-g+15)%30; i=c/4; k=c%4; l=(32+2e+2i-h-k)%7; m=(a+11h+22l)/451
month=(h+l-7m+114)/31; day=((h+l-7m+114)%31)+1      // all operands >= 0 for Y >= 1583
```
Invariant: the result falls between Mar 22 and Apr 25 (2285 gives Mar 22, 2038 gives Apr 25).

### 2.3 Orthodox / Coptic Easter: Julian computus (Meeus), then Julian -> Gregorian
```
a=Y%4; b=Y%7; c=Y%19; d=(19c+15)%30; e=(2a+4b-d+34)%7
jm=(d+e+114)/31; jd=((d+e+114)%31)+1                // a Julian-calendar date
day_number = julian_to_jdn(Y,jm,jd) - 2440588
julian_to_jdn(y,m,d): a=fdiv(14-m,12); yy=y+4800-a; mm=m+12a-3
                     return d + fdiv(153mm+2,5) + 365yy + fdiv(yy,4) - 32083
```
Do not hard-code "+13 days". The offset becomes 14 from 1 Mar 2100 (Julian), and going through the JDN handles that. Sham el-Nessim = Orthodox Easter Sunday + 1.

### 2.4 Julian fixed date (Coptic Christmas)
`julian_fixed(month=12, day=25)` for Gregorian year Y: evaluate Julian years Y-1 and Y through `julian_to_jdn` and keep the result that lands in Gregorian Y. That gives Jan 7 for 1901..=2100 and Jan 8 for 2101..=2199.

### 2.5 Tabular (arithmetical) Hijri calendar: the "approximate" source
- Leap-year pattern **type II** (Kuwaiti/common): years {2,5,7,10,13,16,18,21,24,26,29} of each 30-year cycle. `is_leap(hy) = fmod(14 + 11*hy, 30) < 11`.
- **Civil (Friday) epoch:** 1 Muharram 1 AH = JDN 1948440 = 19 Jul 622 proleptic Gregorian (16 Jul Julian), so `HIJRI_EPOCH = 1948440 - 2440588 = -492148`.
- Months alternate 30/29 days. Month 12 has 30 days in leap years.
```
hijri_to_days(hy,hm,hd) = hd + fdiv(59*(hm-1)+1, 2)        // = ceil(29.5*(hm-1))
                        + (hy-1)*354 + fdiv(3 + 11*hy, 30) + HIJRI_EPOCH - 1
days_to_hijri(z):
  hy = fdiv(30*(z - HIJRI_EPOCH) + 10646, 10631)
  if hijri_to_days(hy,1,1) > z: hy -= 1          // safety corrections, never fire in range
  if hijri_to_days(hy+1,1,1) <= z: hy += 1
  hm = largest m in 1..=12 with hijri_to_days(hy,m,1) <= z   // linear scan, at most 12 steps, no float ceil
  hd = z - hijri_to_days(hy,hm,1) + 1
```
- Range: 1900-01-01 = 28 Sha'ban 1317 and 2199-12-31 = 13 Dhu al-Qa'da 1626. Valid `hijriYear` is therefore **1317..=1627**.
- Safety eval: round-trip every day from 1900 to 2200, 0 failures in the reference run.

---

## 3. Rule data model (date-core `holidays.rs`)

```rust
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub enum HolidayPreset { None, Us, Uk, Eg }

pub enum RuleKind {
    Fixed        { month: u8, day: u8 },
    NthWeekday   { month: u8, weekday: u8 /*Mon=0*/, n: u8 /*1..=4*/ },
    LastWeekday  { month: u8, weekday: u8 },
    EasterOffset { offset: i16 },            // Western Easter Sunday + offset
    OrthodoxEasterOffset { offset: i16 },    // section 2.3 + offset
    JulianFixed  { month: u8, day: u8 },     // section 2.4
    Hijri        { event: HijriEvent },      // section 5, approximate = true
}
pub struct Era { pub from_year: i32, pub to_year: Option<i32>, pub kind: RuleKind } // inclusive bounds
pub enum Observance { None, UsFederal, UkSubstitute }
pub struct HolidayRule {
    pub id: &'static str,             // stable camelCase id, used in excludedHolidays
    pub name: &'static str,
    pub eras: &'static [Era],         // first era whose [from,to] contains Y wins; none -> rule absent that year
    pub observance: Observance,
}
pub struct PresetDef { pub id: HolidayPreset, pub min_year: i32, pub default_weekend: WeekendPreset,
                       pub rules: &'static [HolidayRule] }
```
The JS port holds the same tables as frozen object literals inside the parity block. A CI check extracts ids, names and eras from both files and compares them.

---

## 4. Presets

### 4.1 US federal (`us`): `min_year = 1971`, default weekend `satSun`, observance `UsFederal`

| id | name | era(s) |
|---|---|---|
| newYearsDay | New Year's Day | Fixed 1/1, from 1971 |
| mlkDay | Birthday of Martin Luther King, Jr. | NthWeekday Jan Mon 3, from **1986** |
| washingtonsBirthday | Washington's Birthday (Presidents' Day) | NthWeekday Feb Mon 3, from 1971 |
| memorialDay | Memorial Day | LastWeekday May Mon, from 1971 |
| juneteenth | Juneteenth National Independence Day | Fixed 6/19, from **2021** |
| independenceDay | Independence Day | Fixed 7/4, from 1971 |
| laborDay | Labor Day | NthWeekday Sep Mon 1, from 1971 |
| columbusDay | Columbus Day | NthWeekday Oct Mon 2, from 1971 |
| veteransDay | Veterans Day | NthWeekday Oct Mon 4 for **1971..=1977**; Fixed 11/11 from **1978** |
| thanksgivingDay | Thanksgiving Day | NthWeekday Nov Thu 4, from 1971 |
| christmasDay | Christmas Day | Fixed 12/25, from 1971 |

**Observance `UsFederal`** (5 U.S.C. 6103(b), EO 11582): Saturday moves to the Friday before, Sunday to the Monday after, other days stay. Output label suffix: " (observed)".

**Year-start edge case:** New Year's Day of year Y+1 on a Saturday is observed on **Fri Dec 31 of year Y**. Examples: 2022-01-01 (Sat) is observed 2021-12-31, and 2028-01-01 (Sat) is observed 2027-12-31. Expansion therefore always evaluates year `Y+1` (and `Y-1`) whenever range `[start,end]` touches year Y (section 6).

Juneteenth 2021 falls on a Saturday and is observed Fri 2021-06-18, which matches the first actual observance.

Not modelled: Inauguration Day (DC area only) and ad-hoc executive-order closures such as Christmas Eve. Users can add them as custom holidays.

### 4.2 United Kingdom, England & Wales (`uk`): `min_year = 1978`, default weekend `satSun`, observance `UkSubstitute`

| id | name | era(s) |
|---|---|---|
| newYearsDay | New Year's Day | Fixed 1/1, from **1974** |
| goodFriday | Good Friday | EasterOffset -2, from 1900 |
| easterMonday | Easter Monday | EasterOffset +1, from 1900 |
| earlyMayBankHoliday | Early May bank holiday | NthWeekday May Mon 1, from **1978** |
| springBankHoliday | Spring bank holiday | LastWeekday May Mon, from **1971** |
| summerBankHoliday | Summer bank holiday | LastWeekday Aug Mon, from **1971** |
| christmasDay | Christmas Day | Fixed 12/25, from 1900 |
| boxingDay | Boxing Day | Fixed 12/26, from 1900 |

**One-off table (`UK_ONE_OFFS`, data).** These are applied after the eras and before substitution.
- Moves (`{year, id, to}`):
  - 1995 earlyMay → 1995-05-08 (Mon)
  - 2002 spring → 2002-06-04 (Tue)
  - 2012 spring → 2012-06-04 (Mon)
  - 2020 earlyMay → 2020-05-08 (Fri)
  - 2022 spring → 2022-06-02 (Thu)
- Extras (`{id, name, date}`):
  - millennium1999: 1999-12-31 (Fri)
  - goldenJubilee2002: 2002-06-03 (Mon)
  - royalWedding2011: 2011-04-29 (Fri)
  - diamondJubilee2012: 2012-06-05 (Tue)
  - platinumJubilee2022: 2022-06-03 (Fri)
  - stateFuneral2022: 2022-09-19 (Mon)
  - coronation2023: 2023-05-08 (Mon)

Extra ids are valid `excludedHolidays.uk` entries. Future proclamations need a release.

**Observance `UkSubstitute`** is a generic algorithm that reproduces every gov.uk case:
```
taken = { actual dates of this year's instances that fall Mon..Fri }
for inst in instances sorted by actual date (stable by rule order):
    if weekday(inst.actual) in {Sat,Sun}:
        s = inst.actual + 1
        while weekday(s) in {Sat,Sun} or s in taken: s += 1
        inst.date = s; taken.insert(s); label suffix " (substitute day)"
```
Cases this produces:
- Christmas on Sat: Christmas moves to Mon 27, Boxing Day (Sun) to Tue 28.
- Christmas on Sun: Boxing Day stays Mon 26, Christmas moves to **Tue 27**.
- Boxing Day on Sat: moves to Mon 28.
- New Year on Sat: Mon Jan 3. New Year on Sun: Mon Jan 2.

Scotland and Northern Ireland are out of scope for v1.

### 4.3 Egypt (`eg`): `min_year = 2014`, default weekend `friSat`, observance `None` (no substitutes)

| id | name | era / kind | approx |
|---|---|---|---|
| copticChristmas | Coptic Christmas | JulianFixed 12/25 (= Jan 7 until 2100), from 2003 | no |
| revolutionDay25Jan | January 25 Revolution & Police Day | Fixed 1/25, from 2009 | no |
| sinaiLiberationDay | Sinai Liberation Day | Fixed 4/25, from 1983 | no |
| labourDay | Labour Day | Fixed 5/1, from 1900 | no |
| june30Revolution | June 30 Revolution | Fixed 6/30, from 2014 | no |
| revolutionDay23Jul | July 23 Revolution Day | Fixed 7/23, from 1953 | no |
| armedForcesDay | Armed Forces Day | Fixed 10/6, from 1974 | no |
| shamElNessim | Sham el-Nessim | OrthodoxEasterOffset +1, from 1900 | no |
| islamicNewYear | Islamic New Year | Hijri 1 Muharram, span 1 | **yes** |
| mawlid | Prophet's Birthday (Mawlid) | Hijri 12 Rabi' al-Awwal, span 1 | **yes** |
| eidAlFitr | Eid al-Fitr | Hijri 1 Shawwal, span **3** (dayIndex 1..3) | **yes** |
| arafatDay | Arafat Day | Hijri 9 Dhu al-Hijjah, span 1 (anchored to eidAlAdha - 1) | **yes** |
| eidAlAdha | Eid al-Adha | Hijri 10 Dhu al-Hijjah, span **3** (dayIndex 1..3) | **yes** |

Arafat plus Adha gives 4 days. Not modelled: government decrees that move a holiday to a Thursday or add bridge or extra Eid days (for example 29/30 Ramadan). The UI states this next to the preset. The remedy is to exclude the holiday and add a custom one-off. Coptic Easter Sunday is a Christian-only paid day and is not included.

---

## 5. Islamic dates: approximation and user adjustment

1. Base date = `hijri_to_days(hy, month, day)` from section 2.5.
2. Global `hijriOffsetDays`, an integer in **-2..=2** (default 0), is added to every Hijri event.
3. Per-event override `hijriOverrides[]`: `{ hijriYear, event, date }`, where `event` is one of `islamicNewYear | mawlid | eidAlFitr | eidAlAdha`.
   - The override replaces the anchor (day 1) for that Hijri year and wins over the offset.
   - Multi-day blocks move together: Fitr days = date..date+2. Adha days = date..date+2 and Arafat = date-1.
   - Validation: `|override - tabular_anchor| <= 3` days. `(hijriYear, event)` must be unique. At most **50** overrides.
4. Every instance from a Hijri rule has `approximate: true`. The UI marks these with "≈" and a tooltip: "Tabular Hijri estimate; actual date depends on moon sighting (typically ±1–2 days)". Business-day results that used any approximate date set `usedApproximateHolidays: true`.

---

## 6. Range expansion (efficient, year-chunked)

```
expand(cfg, start, end) -> Vec<HolidayInstance>:
  clamp [start,end] to [1900-01-01, 2199-12-31]; set warning if clamped
  y0 = year(start) - 1; y1 = year(end) + 1          // US Dec-31 observance, UK subs, Hijri overlap
  for y in y0..=y1 within [max(1900, preset.min_year), 2199]:
      insts = year_instances(cfg.preset, y)        // eras -> actual dates
      for Hijri rules: for hy in days_to_hijri(Jan1(y)).y - 1 ..= days_to_hijri(Dec31(y)).y + 1:
          emit if actual(after offset/override) is in year y   // handles 2 Eids per year (2000, 2033)
      apply UK one-offs; apply observance (sets inst.date; default date = actual)
  add custom holidays for each y (section 8)
  drop excluded ids (preset scope) and disabled customs
  keep inst if any effective date (per observedMode) is in [start,end]
  sort by (date, sourceOrder, id, dayIndex); dedupe identical (id, dayIndex, date)
```
- Cost is about 15 rules × (years + 2), so 300 years gives roughly 5k instances in under 1 ms.
- `effective_dates(inst, observedMode)`:
  - `observed` (default): `{date}`
  - `actual`: `{actualDate}`
  - `both`: `{date, actualDate}`
- `holiday_set(...)` is a sorted, deduped `Vec<i32>` of effective dates. Lookups use binary search.
- Several holidays on one date (for example 2028 Western and Orthodox Easter Monday) count once.

**Business-day count**, inclusive `[a,b]`:
```
weekdays = full_weeks*(7 - popcount(mask)) + (remainder <= 6 days scanned)
result   = weekdays - |{ h in holiday_set ∩ [a,b] : !mask.has(weekday(h)) }|
```

**Add/subtract N business days:**
- Walk day by day, with holidays expanded lazily per year in a `BTreeMap<i32 /*year*/, Vec<i32>>`.
- `|N| <= 100_000`.
- Error `noWorkingDays` if `mask == 0x7F`. Error `outOfRange` if the walk leaves 1900..=2199 while a preset is active, or the core date range otherwise.
- The start date is excluded and the result is the Nth working day after (or before) it.
- N = 0 returns the start date, with `startIsNonWorking` set when applicable.

---

## 7. Weekend masks

- `u8` bitmask with bit `i` set meaning weekday `i` (Mon=0 … Sun=6) is a weekend day.
- Bit 7 must be 0. `0x00` means no weekend and is allowed. `0x7F` is rejected for business-day operations.

| preset | mask | bits |
|---|---|---|
| satSun | 0x60 (96) | Sat, Sun |
| friSat | 0x30 (48) | Fri, Sat |
| friOnly | 0x10 (16) | Fri |
| custom | any 0x00..=0x7E | user checkboxes Mon..Sun |

- Serde: `{"preset":"satSun","mask":96}`. When `preset != custom`, validation **normalises `mask` to the preset value**. When `preset == custom`, the mask is taken as given.
- Selecting a holiday preset in the UI sets the weekend to `preset.default_weekend`: us/uk → satSun, eg → friSat. The user can change it afterwards.
- Reference counts for 2026, which has 365 days and starts on Thursday: satSun 261 working days, friSat 261, friOnly 313.

---

## 8. Custom holidays, exclusions, persistence

### 8.1 JSON (camelCase, `deny_unknown_fields` on every struct)
```json
{
  "checkUpdatesOnStartup": true,
  "calendar": {
    "schemaVersion": 1,
    "holidayPreset": "us",
    "weekend": { "preset": "satSun", "mask": 96 },
    "observedMode": "observed",
    "excludedHolidays": { "us": ["columbusDay"], "uk": [], "eg": [] },
    "hijriOffsetDays": 0,
    "hijriOverrides": [ { "hijriYear": 1447, "event": "eidAlFitr", "date": "2026-03-20" } ],
    "customHolidays": [
      { "id": "c-3f9a01bc", "name": "Company shutdown", "kind": "date",   "date": "2026-12-24", "enabled": true },
      { "id": "c-77d0e112", "name": "Founders' Day",    "kind": "yearly", "month": 3, "day": 15, "fromYear": 2020, "enabled": true }
    ]
  }
}
```
- `CustomHoliday` is a flat struct with an `Option` for each kind-specific field: `date` for kind `date`; `month`, `day` and an optional `fromYear` for kind `yearly`. Validation enforces exactly the fields each kind needs. This avoids serde's internally-tagged-enum and `deny_unknown_fields` pitfalls.
- A yearly Feb 29 entry fires only in leap years. Custom holidays are **never shifted** for observance in v1. Their source is `custom`, and an excluded preset id never hides a custom entry.

### 8.2 Limits and sanitisation (one `validate_calendar_config` in Rust, mirrored in JS, with golden cases for both)

| field | rule |
|---|---|
| customHolidays | at most **100** entries; ids unique |
| id | `^c-[0-9a-f]{8}$`, generated by the UI (`crypto.getRandomValues` or Rust `getrandom`-free counter+time hash) |
| name | 1..=**60** Unicode scalar values after trim (`chars().count()` = `[...s].length`) |
| date | strict `^\d{4}-\d{2}-\d{2}$`, real calendar date, 1900-01-01..=2199-12-31 |
| month/day | 1..=12 and 1..=days_in_month(month, leap=true) |
| fromYear | 1900..=2199 |
| excludedHolidays.\<preset\> | each id must exist in that preset (including UK one-off ids); deduped; length ≤ rule count |
| hijriOffsetDays | -2..=2 |
| hijriOverrides | ≤ 50; hijriYear 1317..=1627; anchor within ±3 days of the tabular date |
| weekend.mask | 0..=0x7F |

Name rules:
- Reject leading or trailing whitespace; the UI trims and collapses whitespace runs before submit.
- Reject any of these characters:
  - C0/C1 controls: U+0000–U+001F, U+007F–U+009F
  - U+200E, U+200F
  - U+202A–U+202E
  - U+2066–U+2069
  - U+2028, U+2029, U+FEFF
  - in JS, lone surrogates (`!s.isWellFormed()`, with a regex fallback)
- Names are rendered only through `textContent`; `innerHTML` is still banned. History entries record only preset id, weekend label and holiday count, never custom names, to keep the history 256-character field limit safe.

### 8.3 Desktop persistence (`settings.json`, same hardening as the reference)
- `calendar` is a nested field of `AppSettings` with `#[serde(default)]`.
- `SETTINGS_MAX_FILE_BYTES` goes from 4096 to **65536**. The worst case of 100 customs plus 50 overrides is about 20 KB.
- Writes are atomic, symlinks are rejected, the private directory is reused, and a load failure falls back to defaults. Before the first overwrite, a file that failed to parse or validate is copied once to `settings.json.bak` so custom holidays are not silently lost.
- `settings_set` validates strictly and returns `Err` on any violation.
- `calc_*` commands take a `calendar: CalendarConfig` argument, validated per call, so the UI can preview unsaved edits. `date-core` stays pure.

### 8.4 Mobile persistence (localStorage)
- Key `date_tool_settings_v1` holds the same JSON shape.
- Strict sanitiser: any violation returns null, which means defaults. The raw rejected string is kept once under `date_tool_settings_v1_bak`.
- Writes go through `JSON.stringify`, then a length check of ≤ 65536, then `setItem` in try/catch with the reference in-memory fallback.

### 8.5 Output type
```json
{ "id":"independenceDay","name":"Independence Day (observed)","source":"preset",
  "date":"2026-07-03","actualDate":"2026-07-04","shifted":true,
  "approximate":false,"dayIndex":null,"onWeekend":false }
```
`onWeekend` is computed against the user mask, so the UI can say "falls on a weekend, no effect".

---

## 9. Verification vectors (golden anchors)

### 9.1 US federal: `date` is the observed date, with the actual date in brackets when it differs
- **2026** (matches calculator.net): Jan 1 Thu, Jan 19, Feb 16, May 25, Jun 19 Fri, **Jul 3 Fri [Jul 4 Sat]**, Sep 7, Oct 12, Nov 11 Wed, Nov 26 Thu, Dec 25 Fri. That is 11 holidays. Business days over 2026-01-01..=2026-12-31 with satSun: **250**.
- **2027**: Jan 1 Fri, Jan 18, Feb 15, May 31, **Jun 18 Fri [Jun 19 Sat]**, **Jul 5 Mon [Jul 4 Sun]**, Sep 6, Oct 11, Nov 11 Thu, Nov 25, **Dec 24 Fri [Dec 25 Sat]**, **Dec 31 Fri [New Year's Day 2028-01-01 Sat]**. That is 12 in-range instances. Business days over 2027: **249**.
- Edge cases:
  - 2021: 2021-12-31 Fri is observed for 2022-01-01. Juneteenth 2021 is observed Fri Jun 18.
  - 2022: Juneteenth Jun 19 (Sun) → Jun 20. Christmas Dec 25 (Sun) → Dec 26.
  - 2028: Veterans Day Nov 11 (Sat) → Fri Nov 10.
  - Veterans Day 1975 = Mon Oct 27 (era 1971-77).
  - MLK Day 1986 = Jan 20. None before 1986.
- Business-day additions:
  - 2026-12-23 + 3 = **2026-12-29**
  - 2027-12-23 + 2 = **2027-12-28**
  - 2026-07-02 + 1 = **2026-07-06**

### 9.2 UK, England & Wales
- **2026**: Jan 1 Thu, Apr 3 Fri (Good Friday), Apr 6 Mon, May 4, May 25, Aug 31, Dec 25 Fri, **Dec 28 Mon (Boxing Day substitute, actual Sat Dec 26)**. Business days over 2026: **253**.
- **2027**: Jan 1 Fri, Mar 26, Mar 29, May 3, May 31, Aug 30, **Dec 27 Mon (Christmas substitute)**, **Dec 28 Tue (Boxing substitute)**. Business days: **253**.
- **2022**:
  - Jan 3 (New Year substitute)
  - Spring bank holiday moved to Thu Jun 2
  - Platinum Jubilee Jun 3
  - State Funeral Sep 19
  - Dec 26 Mon (Boxing Day)
  - **Dec 27 Tue (Christmas Day substitute)**: Christmas on Sunday
- 2020: Early May moved to Fri May 8. 2028: Jan 3 (substitute). 2032: Dec 27 and Dec 28.
- Business-day additions:
  - 2026-04-02 + 1 = **2026-04-07**
  - 2027-12-24 + 1 = **2027-12-29**

### 9.3 Egypt 2026, fixed and Easter-based
- Jan 7 Wed
- Jan 25 Sun
- **Apr 13 Mon (Sham el-Nessim)**
- Apr 25 Sat
- May 1 Fri
- Jun 30 Tue
- Jul 23 Thu
- Oct 6 Tue

With tabular Islamic dates at offset 0, the full 2026 set has 17 dates:
- Jan 7, Jan 25
- Mar 20–22 (Fitr)
- Apr 13, Apr 25, May 1
- May 26 (Arafat), May 27–29 (Adha)
- Jun 17 (New Year 1448)
- Jun 30, Jul 23
- Aug 26 (Mawlid 1448)
- Oct 6

Business days over 2026 with friSat: **249**.

### 9.4 Easter tables (Sunday dates)

| Year | Western (GF / EM) | Orthodox/Coptic | Sham el-Nessim |
|---|---|---|---|
| 2024 | Mar 31 (Mar 29 / Apr 1) | May 5 | May 6 |
| 2025 | Apr 20 (Apr 18 / Apr 21) | Apr 20 | Apr 21 |
| 2026 | Apr 5 (Apr 3 / Apr 6) | Apr 12 | Apr 13 |
| 2027 | Mar 28 (Mar 26 / Mar 29) | May 2 | May 3 |
| 2028 | Apr 16 (Apr 14 / Apr 17) | Apr 16 | Apr 17 |
| 2029 | Apr 1 (Mar 30 / Apr 2) | Apr 8 | Apr 9 |
| 2030 | Apr 21 (Apr 19 / Apr 22) | Apr 28 | Apr 29 |

Additional anchors:
- Western: 2000 Apr 23, 2038 Apr 25, 2285 Mar 22
- Orthodox: 2010 Apr 4, 2100 May 2
- Coptic Christmas: 2100 → Jan 7, 2101 → Jan 8

### 9.5 Tabular Hijri (type II, civil epoch, offset 0): exact golden values

| Hijri yr | Leap | New Year | Mawlid | Eid al-Fitr (3 d) | Arafat | Eid al-Adha (3 d) |
|---|---|---|---|---|---|---|
| 1446 | no | 2024-07-08 Mon | 2024-09-16 Mon | 2025-03-31 Mon..04-02 | 2025-06-06 Fri | 2025-06-07 Sat..06-09 |
| 1447 | yes | 2025-06-27 Fri | 2025-09-05 Fri | 2026-03-20 Fri..03-22 | 2026-05-26 Tue | 2026-05-27 Wed..05-29 |
| 1448 | no | 2026-06-17 Wed | 2026-08-26 Wed | 2027-03-10 Wed..03-12 | 2027-05-16 Sun | 2027-05-17 Mon..05-19 |
| 1449 | no | 2027-06-06 Sun | 2027-08-15 Sun | 2028-02-27 Sun..02-29 | 2028-05-04 Thu | 2028-05-05 Fri..05-07 |

Other anchors:
- Two Eid al-Fitr in one Gregorian year: 2000 (Jan 8 [1420] and Dec 28 [1421]) and 2033 (Jan 3 [1454] and Dec 23 [1455]).
- Round trips: 2026-11-16 = 5 Jumada al-Akhira 1448. 2025-03-30 = 30 Ramadan 1446.

**Deviation note.** This is for documentation only and is never used in fixtures; the reported dates come from memory of official Egypt/Umm al-Qura announcements and must be re-verified before they are cited.
- **1446 and 1447 New Year and Mawlid ran +1 day late** against the tabular calendar:
  - New Year 1446: reported 2024-07-07
  - Mawlid 1446: reported 2024-09-15
  - Eid al-Fitr 1446: reported 2025-03-30
  - Arafat/Adha 1446: reported 2025-06-05/06
  - New Year 1447: reported 2025-06-26
  - Mawlid 1447: reported 2025-09-04
- 1447 Fitr (2026-03-20) and Adha (2026-05-27) reportedly matched (0).
- New Year 1448 was reportedly 2026-06-16 (+1).
- 2027 dates are not yet known; ±1–2 days is expected.

UI copy must say "estimated (±1–2 days)". The global offset and per-event overrides (section 5) are the correction tools.

---

## 10. Tests and parity

1. **`tests/golden_parity.rs` and the CI node check against the extracted mobile engine** share the `holidays` section of `tests/fixtures/golden.json`. It holds every vector in section 9 plus validator cases (valid and invalid configs with the expected normalised result or error code).
2. **`examples/eval_bridge.rs`** JSON-lines ops:
   - Calendar maths: `easter`, `orthodoxEaster`, `hijriToGregorian`, `gregorianToHijri`.
   - Holiday and business-day queries: `holidaysInRange`, `businessDays`, `addBusinessDays`.
   - Config: `validateCalendarConfig`.
3. **`scripts/safety-eval.mjs`** runs seeded random queries (years 1890–2210, every preset, mask, offset and observedMode) through both engines and diffs the results byte for byte.
4. **`tests/safety_evaluations.rs`** property checks:
   - Observed US dates are never Sat/Sun and lie within ±1 day of the actual date.
   - UK substitute dates are Mon..Fri and lie 1..=3 days after the actual date.
   - Western Easter falls between Mar 22 and Apr 25. Orthodox Easter falls between Apr 4 and May 8 for 1900–2099.
   - Orthodox Easter is never earlier than Western Easter.
   - Hijri round trip covers 1900–2200.
   - `businessDays(start+1, add(start,n)) == n`.
   - Counts are monotonic as the range grows.
   - Mask `0x7F` returns an error.
   - Configs that are oversized, contain bidi characters, have 101 customs, duplicate ids or unknown excluded ids are rejected.
5. **CI greps** in the parity block: no bare `%`/`/` on possibly negative operands, no `Date` usage, no floats except `Math.floor` wrappers.


## Open risks
- Islamic holiday dates are tabular estimates. Against the reported Egypt/Umm al-Qura dates they ran +1 day late through most of 2024-2025, but 1447 Fitr and Adha matched. The default hijriOffsetDays is 0; whether to ship -1 instead is a product decision. The 'reported actual' column comes from memory and needs re-verifying against official announcements before docs cite it.
- Egypt routinely moves national holidays to Thursdays and adds bridge or extra Eid days by cabinet decree. The rule-based preset cannot predict these, so users must exclude the holiday and add a custom one. The UI must say this clearly.
- The UK one-off table (1995-2023) needs a new release for every future proclamation. Years before 1978 are outside the complete-preset floor, and pre-1995 royal one-offs such as 1973, 1977 and 1981 are deliberately not modelled.
- Raising SETTINGS_MAX_FILE_BYTES from 4096 to 65536 and nesting calendar in settings.json means a strict parse failure resets every setting. The spec adds a single settings.json.bak copy to avoid silent loss of custom holidays, which departs from the reference behaviour. A separate holidays.json file is the alternative.
- observedMode 'actual'/'both' and the legal-observance-independent-of-user-weekend rule may confuse users with Fri/Sat weekends. The UI copy needs care.
- Custom holidays are never shifted for weekends in v1. Users may expect US-style observed shifts for recurring custom days.
- US ad-hoc executive-order closures (e.g. Christmas Eve) and Inauguration Day are not included. This matches calculator.net, but some users may expect them.
- Parity hazards: Rust truncating division and JS % with negative operands, and Math.ceil(29.5*x) float use. The spec mandates integer helpers and CI greps; a miss would show up only for pre-1970 dates or negative offsets.
- UK Christmas/Boxing substitution relies on the generic next-free-weekday algorithm. It reproduces all known gov.uk cases (2021, 2022, 2026, 2027, 2032), but any statutory change would need a data or algorithm update.
