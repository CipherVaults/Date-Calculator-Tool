// Frontend controller for the Date Calculator Tool desktop app (Tauri v2).
//
// Mirrors the sibling Percentage Calculator Tool's ui/main.js: the terminal
// DOM look, per-card live recompute guarded by sequence counters, explicit
// Calculate/Enter/Copy history recording, settings commit-on-success, the
// update banner and the in-page smoke test. All date math, holiday rules,
// display text and mini-calendar grids come from the Rust engine through
// Tauri commands. This file only reads the inputs, supplies the local
// "today"/"now", and renders results with textContent, createElement and
// replaceChildren.

const COPY_FEEDBACK_MS = 1200;
const MAX_FIELD_LEN = 256;
const MAX_HISTORY_COPY_LEN = 1024;
const MAX_COPY_LEN = 4096;
const MAX_CUSTOM_HOLIDAYS = 100;
const MAX_HIT_ROWS = 25;
const HOLIDAY_MIN_YEAR = 1900;
const HOLIDAY_MAX_YEAR = 2199;
const HIJRI_OFFSET_MAX = 2;
const HIJRI_YEAR_MIN = 1317;
const HIJRI_YEAR_MAX = 1626;
const ROLLOVER_CHECK_MS = 60000;
const WEB_APP_URL = "https://ciphervaults.github.io/Date-Calculator-Tool/";
const RELEASE_URL =
  "https://github.com/CipherVaults/Date-Calculator-Tool/releases/latest";
let historyLimit = 500;
let allHistoryEntries = [];
let historyFilterValue = "all";

function invoke(cmd, args) {
  const fn =
    window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
  if (!fn) {
    return Promise.reject(new Error(`Tauri invoke unavailable for ${cmd}`));
  }
  return fn(cmd, args);
}

// Every engine command takes one `req` object and answers with the
// `{"ok":"true","result":{...}}` / `{"ok":"false","error":{...}}` envelope.
function engine(cmd, req) {
  return invoke(cmd, { req });
}

function okResult(res) {
  return res &&
    res.ok === "true" &&
    res.result &&
    typeof res.result === "object"
    ? res.result
    : null;
}

function errorMessage(res) {
  const msg = res?.ok === "false" ? res.error?.message : null;
  return typeof msg === "string" && msg.trim() ? msg : "Calculation failed.";
}

function $(id) {
  return document.getElementById(id);
}

function str(value) {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const CARD_KEYS = ["between", "add", "business", "age", "info", "countdown"];

const CARD_META = {
  between: {
    label: "Days Between",
    card: "card-between",
    result: "betweenResult",
    trace: "betweenTrace",
    live: "betweenLiveResult",
    first: "betweenStart",
    buttons: ["calcBetweenBtn", "resetBetweenBtn", "copyBetweenBtn"],
    enterIds: ["betweenStart", "betweenEnd"]
  },
  add: {
    label: "Add / Subtract",
    card: "card-add",
    result: "addResult",
    trace: "addTrace",
    live: "addLiveResult",
    first: "addStart",
    buttons: ["calcAddBtn", "resetAddBtn", "copyAddBtn"],
    enterIds: ["addStart", "addYears", "addMonths", "addWeeks", "addDays"]
  },
  business: {
    label: "Business Days",
    card: "card-business",
    result: "bizResult",
    trace: "bizTrace",
    live: "bizLiveResult",
    first: "bizStart",
    buttons: ["calcBizBtn", "resetBizBtn", "copyBizBtn"],
    enterIds: ["bizStart", "bizEnd"]
  },
  age: {
    label: "Age",
    card: "card-age",
    result: "ageResult",
    trace: "ageTrace",
    live: "ageLiveResult",
    first: "ageBirth",
    buttons: ["calcAgeBtn", "resetAgeBtn", "copyAgeBtn"],
    enterIds: ["ageBirth", "ageAsOf"]
  },
  info: {
    label: "Date Info",
    card: "card-info",
    result: "infoResult",
    trace: "infoTrace",
    live: "infoLiveResult",
    first: "infoDate",
    buttons: ["calcInfoBtn", "resetInfoBtn", "copyInfoBtn"],
    enterIds: ["infoDate"]
  },
  countdown: {
    label: "Countdown",
    card: "card-countdown",
    result: "cdResult",
    trace: "cdTrace",
    live: "cdLiveResult",
    first: "cdTarget",
    buttons: ["calcCdBtn", "resetCdBtn", "copyCdBtn"],
    enterIds: ["cdTarget", "cdTime"]
  }
};

const AMOUNT_IDS = ["addYears", "addMonths", "addWeeks", "addDays"];

// The restorable inputs each calculator stores (the backend allows exactly
// these keys per calculator, all required).
const HISTORY_INPUT_KEYS = {
  between: ["startDate", "endDate", "includeEndDay"],
  add: ["date", "operation", "years", "months", "weeks", "days", "businessDays"],
  business: ["startDate", "endDate", "includeEndDay"],
  age: ["birthDate", "asOfDate", "leapDayRule"],
  info: ["date"],
  countdown: ["targetDate", "targetTime"]
};

// Per-card sequence counters ensure a slower IPC reply can never overwrite
// a newer keystroke or a "clear" click.
const seq = {
  between: 0,
  add: 0,
  business: 0,
  age: 0,
  info: 0,
  countdown: 0,
  preview: 0,
  calendarInfo: 0
};

// Holds the most recent valid calculation per card so explicit actions
// (Calculate, Enter, Copy) can record it to persistent history.
const lastValidCalc = {
  between: null,
  add: null,
  business: null,
  age: null,
  info: null,
  countdown: null
};

const traceHints = {};

let addMode = "add";
let leapRule = "feb28";

// ---------------------------------------------------------------------------
// Local clock (FROZEN §7, BUILD_PLAN §0.3): "today" and "now" come from the
// local components of `new Date()`, never the UTC ISO string. The smoke test
// pins a fixed clock so it never depends on the real date.
// ---------------------------------------------------------------------------

let fixedClock = null;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function localNowParts() {
  if (fixedClock) return { ...fixedClock };
  const d = new Date();
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: d.getHours(),
    mi: d.getMinutes(),
    ss: d.getSeconds(),
    offset: clampOffset(Math.round(-d.getTimezoneOffset()))
  };
}

function clampOffset(minutes) {
  if (!Number.isFinite(minutes)) return 0;
  return Math.max(-1080, Math.min(1080, minutes));
}

function todayIso() {
  const p = localNowParts();
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

function nowMoment() {
  const p = localNowParts();
  return {
    date: `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`,
    time: `${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)}`,
    utcOffsetMinutes: p.offset
  };
}

// The UTC offset in effect at a local date-time (DST-correct per instant).
// `setFullYear` keeps years 0001..0099 from being read as 1900..1999.
function offsetAt(dateIso, timeText) {
  if (fixedClock) return fixedClock.offset;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!dm) return localNowParts().offset;
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeText || "");
  const d = new Date(2000, 0, 1, 0, 0, 0, 0);
  d.setFullYear(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
  d.setHours(
    tm ? Number(tm[1]) : 0,
    tm ? Number(tm[2]) : 0,
    tm && tm[3] ? Number(tm[3]) : 0,
    0
  );
  return clampOffset(Math.round(-d.getTimezoneOffset()));
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseIso(value) {
  if (!isIsoDate(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  if (y < 1 || m < 1 || m > 12) return null;
  return { y, m };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

// Arabic-Indic (U+0660..U+0669) and Extended Arabic-Indic (U+06F0..U+06F9)
// digits become ASCII before anything reaches the engine (FROZEN §6).
function normalizeDigits(text) {
  return String(text ?? "").replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String.fromCharCode(48 + (code >= 0x06f0 ? code - 0x06f0 : code - 0x0660));
  });
}

function normalizeFieldDigits(el) {
  if (!el) return;
  const normalized = normalizeDigits(el.value);
  if (normalized === el.value) return;
  // Each digit is one UTF-16 unit on both sides, so the caret stays put.
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = normalized;
  if (typeof start === "number" && typeof end === "number") {
    try {
      el.setSelectionRange(start, end);
    } catch {
      // Selection is best effort.
    }
  }
}

function readDate(id) {
  const el = $(id);
  return el && typeof el.value === "string" ? el.value.trim() : "";
}

function readAmount(id) {
  const el = $(id);
  return el ? normalizeDigits(el.value).trim() : "";
}

function syncDateEmpty(el) {
  if (!el || (el.type !== "date" && el.type !== "time")) return;
  el.classList.toggle("date-empty", el.value === "");
}

function setField(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = typeof value === "string" ? value : "";
  syncDateEmpty(el);
}

function clearFields(ids) {
  ids.forEach((id) => setField(id, ""));
}

function attachAmountPasteSanitizers() {
  const plainAmountRe = /^[+-]?\d{1,15}$/;
  AMOUNT_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("paste", (event) => {
      const rawText = event.clipboardData?.getData("text");
      if (typeof rawText !== "string") return;
      const trimmed = rawText.trim();
      if (!trimmed || plainAmountRe.test(trimmed)) return;
      const cleaned = normalizeDigits(trimmed).replace(/[\s,_'٬]+/g, "");
      event.preventDefault();
      if (plainAmountRe.test(cleaned)) {
        el.value = cleaned;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  });
}

function setPressed(button, on) {
  if (!button) return;
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
}

// ---------------------------------------------------------------------------
// Text helpers (engine text is used as is; these only format raw numbers)
// ---------------------------------------------------------------------------

function groupInt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const negative = n < 0;
  const digits = String(Math.trunc(Math.abs(n))).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ","
  );
  return negative ? `-${digits}` : digits;
}

function plural(n, word) {
  return `${groupInt(n)} ${word}${n === 1 ? "" : "s"}`;
}

function utf8Length(text) {
  return typeof TextEncoder === "function"
    ? new TextEncoder().encode(text).length
    : text.length;
}

const ISO_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PRESET_LABELS = {
  none: "None",
  us: "US federal",
  uk: "UK (England & Wales)",
  eg: "Egypt"
};
const HIJRI_EVENTS = new Set(["islamicNewYear", "mawlid", "eidAlFitr", "eidAlAdha"]);

function weekendShort(weekend) {
  const days = Array.isArray(weekend)
    ? weekend.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    : [];
  if (days.length === 0) return "no weekend";
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => ISO_SHORT[d])
    .join("/");
}

// ---------------------------------------------------------------------------
// Result, trace and live-result rendering
// ---------------------------------------------------------------------------

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function resultPrefix() {
  return span("result-prefix", "=");
}

function setResultNodes(resultId, nodes) {
  const el = $(resultId);
  if (!el) return;
  el.replaceChildren(resultPrefix(), ...nodes);
}

function setResultIdle(resultId) {
  setResultNodes(resultId, [document.createTextNode("—")]);
}

function setResultError(resultId, message) {
  setResultNodes(resultId, [span("error-text", message)]);
}

function renderResult(resultId, main, subs = [], warnings = [], extra = []) {
  const nodes = [document.createTextNode(main)];
  subs.filter((t) => typeof t === "string" && t).forEach((t) => {
    nodes.push(span("result-sub", t));
  });
  extra.forEach((node) => nodes.push(node));
  warnings.filter((t) => typeof t === "string" && t).forEach((t) => {
    nodes.push(span("result-warning", t));
  });
  setResultNodes(resultId, nodes);
}

function traceItem(text, className = "") {
  const li = document.createElement("li");
  if (className) li.className = className;
  li.textContent = text;
  return li;
}

function setTraceLines(key, lines) {
  const el = $(CARD_META[key].trace);
  if (!el) return;
  const items = (Array.isArray(lines) ? lines : [])
    .filter((line) => typeof line === "string")
    .map((line) =>
      // Indented engine lines (holiday lists) are detail notes.
      line.startsWith("  ") ? traceItem(line.trim(), "trace-note") : traceItem(line)
    );
  if (items.length === 0) {
    setTraceIdle(key);
    return;
  }
  el.replaceChildren(...items);
}

function setTraceIdle(key) {
  const el = $(CARD_META[key].trace);
  if (!el) return;
  el.replaceChildren(traceItem(traceHints[key] || "—", "trace-hint"));
}

function setTraceError(key, message) {
  const el = $(CARD_META[key].trace);
  if (!el) return;
  const errItem = document.createElement("li");
  errItem.appendChild(span("error-text", message));
  el.replaceChildren(traceItem(traceHints[key] || "—", "trace-hint"), errItem);
}

function setLive(key, text) {
  const el = $(CARD_META[key].live);
  if (el) el.textContent = text;
}

function cardIdle(key) {
  lastValidCalc[key] = null;
  setTraceIdle(key);
  setLive(key, "→ —");
  setResultIdle(CARD_META[key].result);
}

function cardError(key, message) {
  lastValidCalc[key] = null;
  setTraceError(key, message);
  setLive(key, "→ invalid");
  setResultError(CARD_META[key].result, message);
}

function warningTexts(result) {
  const out = [];
  if (
    Array.isArray(result?.warnings) &&
    result.warnings.includes("presetYearOutOfRange")
  ) {
    out.push(
      "Part of this range is outside the holiday preset's years (presets cover at most 1900–2199), so only the weekend is skipped there."
    );
  }
  if (result?.usedApproximateHolidays === true) {
    out.push("Includes estimated Islamic holiday dates (they can differ by 1–2 days).");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copy and history plumbing (reference pattern)
// ---------------------------------------------------------------------------

function showCopyFeedback(button) {
  if (!button) return;

  const originalText = button.dataset.label || button.textContent;
  button.dataset.label = originalText;
  button.textContent = "copied";
  button.classList.add("copied");
  window.clearTimeout(Number(button.dataset.copyTimer || 0));

  const timer = window.setTimeout(() => {
    button.textContent = originalText;
    button.classList.remove("copied");
  }, COPY_FEEDBACK_MS);
  button.dataset.copyTimer = String(timer);
}

async function copyText(text, button) {
  if (typeof text !== "string" || text.trim() === "") return false;
  if (utf8Length(text) > MAX_COPY_LEN) return false;
  try {
    await invoke("copy_text", { text });
    showCopyFeedback(button);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      showCopyFeedback(button);
      return true;
    } catch {
      // Clipboard failures should not interrupt the calculator.
      return false;
    }
  }
}

async function copyCardResult(key, button) {
  const calc = lastValidCalc[key];
  if (!calc || !calc.copyText) return false;
  const copied = await copyText(calc.copyText, button);
  if (!copied) return false;
  await recordHistoryFor(key);
  return true;
}

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_EXCEPT_NEWLINE_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

function buildValidHistoryCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !Object.hasOwn(HISTORY_INPUT_KEYS, candidate.calculator)
  ) {
    return null;
  }
  const singleLine = [
    candidate.calculatorLabel,
    candidate.inputsText,
    candidate.resultText
  ];
  const singleLineOk = singleLine.every(
    (v) =>
      typeof v === "string" &&
      v.trim().length > 0 &&
      utf8Length(v) <= MAX_FIELD_LEN &&
      !CONTROL_RE.test(v)
  );
  const copy = candidate.copyText;
  const copyOk =
    typeof copy === "string" &&
    copy.trim().length > 0 &&
    utf8Length(copy) <= MAX_HISTORY_COPY_LEN &&
    !CONTROL_EXCEPT_NEWLINE_RE.test(copy);
  if (!singleLineOk || !copyOk) return null;

  const inputs = candidate.inputs;
  if (!inputs || typeof inputs !== "object") return null;
  const keys = HISTORY_INPUT_KEYS[candidate.calculator];
  const inputKeys = Object.keys(inputs);
  if (
    inputKeys.length !== keys.length ||
    !keys.every(
      (k) =>
        typeof inputs[k] === "string" &&
        utf8Length(inputs[k]) <= MAX_FIELD_LEN &&
        !CONTROL_RE.test(inputs[k])
    )
  ) {
    return null;
  }
  return {
    calculator: candidate.calculator,
    calculatorLabel: candidate.calculatorLabel,
    inputs: { ...inputs },
    inputsText: candidate.inputsText,
    resultText: candidate.resultText,
    copyText: candidate.copyText
  };
}

function swapFields(aId, bId, updateFn) {
  const elA = $(aId);
  const elB = $(bId);
  if (!elA || !elB) return Promise.resolve();
  const tmp = elA.value;
  elA.value = elB.value;
  elB.value = tmp;
  syncDateEmpty(elA);
  syncDateEmpty(elB);
  return updateFn();
}

function attachEnterKey(ids, computeAndRecordFn) {
  ids.forEach((id) => {
    const el = $(id);
    el?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") computeAndRecordFn();
    });
  });
}

// ---------------------------------------------------------------------------
// Settings state (loaded early because every calendar request uses it)
// ---------------------------------------------------------------------------

const DEFAULT_CALENDAR = Object.freeze({
  weekend: [6, 7],
  preset: "none",
  hijriOffsetDays: 0,
  hijriOverrides: [],
  excludedHolidays: { us: [], uk: [], eg: [] },
  customHolidays: [],
  observedMode: "observed",
  schemaVersion: 1
});

const DEFAULT_SETTINGS = Object.freeze({
  checkUpdatesOnStartup: true,
  firstDayOfWeek: "monday",
  calendar: DEFAULT_CALENDAR,
  schemaVersion: 1
});

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function isSettingsShape(s) {
  return (
    Boolean(s) &&
    typeof s === "object" &&
    typeof s.checkUpdatesOnStartup === "boolean" &&
    Boolean(s.calendar) &&
    typeof s.calendar === "object" &&
    Array.isArray(s.calendar.weekend) &&
    typeof s.calendar.preset === "string"
  );
}

function normalizeLoadedSettings(s) {
  const out = cloneSettings(s);
  const cal = out.calendar;
  if (!Array.isArray(cal.hijriOverrides)) cal.hijriOverrides = [];
  if (!Array.isArray(cal.customHolidays)) cal.customHolidays = [];
  if (!cal.excludedHolidays || typeof cal.excludedHolidays !== "object") {
    cal.excludedHolidays = { us: [], uk: [], eg: [] };
  }
  ["us", "uk", "eg"].forEach((p) => {
    if (!Array.isArray(cal.excludedHolidays[p])) cal.excludedHolidays[p] = [];
  });
  if (typeof cal.hijriOffsetDays !== "number") cal.hijriOffsetDays = 0;
  if (out.firstDayOfWeek !== "sunday") out.firstDayOfWeek = "monday";
  return out;
}

let savedSettings = cloneSettings(DEFAULT_SETTINGS);
let calendarInfo = null;

// The calendar every calculation request sends (FROZEN §2): the saved one.
function currentCalendar() {
  return savedSettings.calendar;
}

function calendarPresetText(cal = currentCalendar()) {
  if (cal.preset === "none") return "no holidays";
  if (calendarInfo && calendarInfo.calendar?.preset === cal.preset) {
    return str(calendarInfo.presetLabel) || PRESET_LABELS[cal.preset] || cal.preset;
  }
  return PRESET_LABELS[cal.preset] || cal.preset;
}

// Short calendar description for cards and history. It never contains a
// custom holiday name (FROZEN §11), only their count.
function calendarShortText(cal = currentCalendar()) {
  const customCount = (cal.customHolidays || []).filter(
    (c) => c && c.enabled !== false
  ).length;
  const parts = [weekendShort(cal.weekend), calendarPresetText(cal)];
  if (customCount > 0) parts.push(plural(customCount, "custom holiday"));
  return parts.join(" · ");
}

function updateCalendarSummaries() {
  const text = calendarShortText();
  const addEl = $("addCalendarSummaryText");
  const bizEl = $("bizCalendarSummaryText");
  if (addEl) addEl.textContent = text;
  if (bizEl) bizEl.textContent = text;
}

// ---------------------------------------------------------------------------
// Mini calendars (month_grid from the engine)
// ---------------------------------------------------------------------------

const calViews = {
  biz: { prefix: "bizCal", year: 0, month: 0, rangeStart: null, rangeEnd: null, seq: 0, last: null },
  info: { prefix: "infoCal", year: 0, month: 0, rangeStart: null, rangeEnd: null, seq: 0, last: null },
  cd: { prefix: "cdCal", year: 0, month: 0, rangeStart: null, rangeEnd: null, seq: 0, last: null }
};

function setCalendarView(key, { anchor = null, rangeStart = null, rangeEnd = null } = {}) {
  const view = calViews[key];
  const a = parseIso(anchor) || parseIso(todayIso()) || { y: 2026, m: 1 };
  view.year = a.y;
  view.month = a.m;
  view.rangeStart = parseIso(rangeStart) ? rangeStart : null;
  view.rangeEnd = parseIso(rangeEnd) ? rangeEnd : null;
  return refreshMiniCal(key);
}

function shiftCalendar(key, delta) {
  const view = calViews[key];
  if (!view.year) return Promise.resolve(null);
  const minIdx = 12 * 1;
  const maxIdx = 12 * 9999 + 11;
  const idx = Math.max(
    minIdx,
    Math.min(maxIdx, view.year * 12 + (view.month - 1) + delta)
  );
  view.year = Math.floor(idx / 12);
  view.month = (idx % 12) + 1;
  return refreshMiniCal(key);
}

async function refreshMiniCal(key) {
  const view = calViews[key];
  if (!view.year) return null;
  const ticket = ++view.seq;
  const req = {
    year: view.year,
    month: view.month,
    firstDayOfWeek: savedSettings.firstDayOfWeek,
    today: todayIso(),
    calendar: currentCalendar()
  };
  if (view.rangeStart) req.rangeStart = view.rangeStart;
  if (view.rangeEnd) req.rangeEnd = view.rangeEnd;
  let grid = null;
  try {
    grid = okResult(await engine("month_grid", req));
  } catch {
    grid = null;
  }
  if (ticket !== view.seq) return null;
  view.last = grid;
  paintMiniCal(key, grid);
  return grid;
}

function miniCalCell(cell) {
  const el = document.createElement("span");
  const classes = ["mini-cal-cell"];
  if (!cell.inMonth) classes.push("out");
  if (cell.outOfRange) classes.push("out-of-range");
  if (cell.weekend) classes.push("weekend");
  if (cell.holiday) {
    classes.push("holiday");
    if (cell.approximate) classes.push("approx");
  }
  if (cell.inRange) classes.push("in-range");
  if (cell.isRangeStart || cell.isRangeEnd) classes.push("endpoint");
  if (cell.isToday) classes.push("today");
  el.className = classes.join(" ");
  el.textContent = typeof cell.day === "number" ? String(cell.day) : "";
  const label = str(cell.label);
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label || str(cell.date));
  if (label) el.title = label;
  el.dataset.date = str(cell.date);
  return el;
}

function paintMiniCal(key, grid) {
  const view = calViews[key];
  const p = view.prefix;
  const title = $(`${p}Title`);
  const head = $(`${p}Weekdays`);
  const body = $(`${p}Grid`);
  const prev = $(`${p}PrevBtn`);
  const next = $(`${p}NextBtn`);
  if (prev) prev.disabled = view.year <= 1 && view.month <= 1;
  if (next) next.disabled = view.year >= 9999 && view.month >= 12;
  if (!title || !head || !body) return;
  if (!grid || !Array.isArray(grid.cells)) {
    title.textContent = "—";
    body.replaceChildren();
    return;
  }
  title.textContent = str(grid.title) || "—";
  const headers = Array.isArray(grid.weekdayHeaders) ? grid.weekdayHeaders : [];
  head.replaceChildren(
    ...headers.map((h, i) => {
      const cell = grid.cells[i];
      return span(cell && cell.weekend ? "mini-cal-dow weekend" : "mini-cal-dow", str(h));
    })
  );
  body.replaceChildren(
    ...grid.cells.filter((c) => c && typeof c === "object").map(miniCalCell)
  );
}

// ---------------------------------------------------------------------------
// Card 1: Days Between
// ---------------------------------------------------------------------------

async function updateBetweenLive() {
  const ticket = ++seq.between;
  const startDate = readDate("betweenStart");
  const endDate = readDate("betweenEnd");
  const includeEndDay = Boolean($("betweenIncludeEnd")?.checked);

  if (!startDate || !endDate) {
    cardIdle("between");
    return;
  }

  lastValidCalc.between = null;
  try {
    const res = await engine("calc_days_between", {
      startDate,
      endDate,
      includeEndDay
    });
    if (ticket !== seq.between) return;
    const r = okResult(res);
    if (!r) {
      cardError("between", errorMessage(res));
      return;
    }

    renderResult("betweenResult", str(r.breakdownText), [
      `${str(r.summaryText)} · ${str(r.weeksText)}`,
      `${groupInt(r.totalHours)} hours · ${groupInt(r.totalMinutes)} minutes · ${groupInt(r.totalSeconds)} seconds`,
      `${str(r.startWeekday)} → ${str(r.endWeekday)}${
        r.direction === "backward" ? " (the end date is before the start date)" : ""
      }`
    ]);
    setTraceLines("between", r.traceLines);
    setLive("between", `→ ${str(r.summaryText)}`);

    lastValidCalc.between = {
      calculator: "between",
      calculatorLabel: CARD_META.between.label,
      inputs: { startDate, endDate, includeEndDay: String(includeEndDay) },
      inputsText: `${startDate} → ${endDate}${includeEndDay ? " (+1 day)" : ""}`,
      resultText: `${str(r.summaryText)} · ${str(r.breakdownText)}`,
      copyText: str(r.copyText)
    };
  } catch {
    if (ticket !== seq.between) return;
    cardError("between", "Calculation failed.");
  }
}

// ---------------------------------------------------------------------------
// Card 2: Add / Subtract
// ---------------------------------------------------------------------------

function setAddMode(newMode, triggerUpdate = true) {
  addMode = newMode === "subtract" ? "subtract" : "add";
  setPressed($("addModeAddBtn"), addMode === "add");
  setPressed($("addModeSubtractBtn"), addMode === "subtract");
  return triggerUpdate ? updateAddLive() : Promise.resolve();
}

function syncAddBusinessUi() {
  const business = Boolean($("addBusiness")?.checked);
  $("addBusinessNote")?.classList.toggle("hidden", !business);
  $("addCalendarSummary")?.classList.toggle("hidden", !business);
  const weeksLabel = $("addWeeksLabel");
  const daysLabel = $("addDaysLabel");
  if (weeksLabel) weeksLabel.textContent = business ? "Business weeks" : "Weeks";
  if (daysLabel) daysLabel.textContent = business ? "Business days" : "Days";
}

async function updateAddLive() {
  const ticket = ++seq.add;
  const date = readDate("addStart");
  const amounts = {
    years: readAmount("addYears"),
    months: readAmount("addMonths"),
    weeks: readAmount("addWeeks"),
    days: readAmount("addDays")
  };
  const operation = addMode;
  const businessDays = Boolean($("addBusiness")?.checked);

  if (!date) {
    cardIdle("add");
    return;
  }

  lastValidCalc.add = null;
  try {
    const res = await engine("calc_add_subtract", {
      date,
      operation,
      ...amounts,
      businessDays,
      calendar: currentCalendar()
    });
    if (ticket !== seq.add) return;
    const r = okResult(res);
    if (!r) {
      cardError("add", errorMessage(res));
      return;
    }

    const subs = [
      str(r.expressionText),
      `Calendar days moved: ${groupInt(r.calendarDaysDelta)}`
    ];
    if (businessDays && typeof r.businessDayCount === "number") {
      subs.push(
        `Business days: ${groupInt(r.businessDayCount)} (skipped ${plural(
          r.skippedWeekendDays,
          "weekend day"
        )}, ${plural(r.skippedHolidays, "holiday")}) · ${calendarShortText()}`
      );
    }
    if (r.monthClamped === true) {
      subs.push("The day was moved to the last day of the month.");
    }
    renderResult("addResult", str(r.summaryText), subs, warningTexts(r));
    setTraceLines("add", r.traceLines);
    setLive("add", `→ ${str(r.resultDate)} (${str(r.resultWeekday)})`);

    const sign = operation === "subtract" ? "−" : "+";
    const parts = [
      ["years", "y"],
      ["months", "m"],
      ["weeks", businessDays ? " business weeks" : "w"],
      ["days", businessDays ? " business days" : "d"]
    ]
      .filter(([k]) => amounts[k] !== "")
      .map(([k, suffix]) => `${amounts[k]}${suffix}`);
    lastValidCalc.add = {
      calculator: "add",
      calculatorLabel: CARD_META.add.label,
      inputs: {
        date,
        operation,
        years: amounts.years,
        months: amounts.months,
        weeks: amounts.weeks,
        days: amounts.days,
        businessDays: String(businessDays)
      },
      inputsText: `${date} ${sign} ${parts.length ? parts.join(" ") : "0d"}${
        businessDays ? ` · ${calendarShortText()}` : ""
      }`,
      resultText: `${str(r.resultDate)} (${str(r.resultWeekday)})`,
      copyText: str(r.copyText)
    };
  } catch {
    if (ticket !== seq.add) return;
    cardError("add", "Calculation failed.");
  }
}

// ---------------------------------------------------------------------------
// Card 3: Business Days
// ---------------------------------------------------------------------------

function renderHolidayHits(result) {
  const box = $("bizHolidayHits");
  const list = $("bizHolidayList");
  const more = $("bizHolidayMore");
  if (!box || !list || !more) return;
  const hits = Array.isArray(result?.holidays)
    ? result.holidays.filter((h) => h && typeof h === "object")
    : [];
  if (hits.length === 0) {
    box.classList.add("hidden");
    list.replaceChildren();
    more.textContent = "";
    more.classList.add("hidden");
    return;
  }
  const shown = hits.slice(0, MAX_HIT_ROWS);
  list.replaceChildren(
    ...shown.map((hit) => {
      const li = document.createElement("li");
      const name = span("holiday-hit-name", str(hit.name));
      if (hit.approximate === true) {
        name.append(" ", span("approx-tag", "estimated"));
      }
      li.append(name, span("holiday-hit-date", str(hit.date)));
      return li;
    })
  );
  const total =
    typeof result.holidayDays === "number" ? result.holidayDays : hits.length;
  const rest = total - shown.length;
  more.textContent = rest > 0 ? `and ${groupInt(rest)} more` : "";
  more.classList.toggle("hidden", rest <= 0);
  box.classList.remove("hidden");
}

async function updateBusinessLive() {
  const ticket = ++seq.business;
  const startDate = readDate("bizStart");
  const endDate = readDate("bizEnd");
  const includeEndDay = Boolean($("bizIncludeEnd")?.checked);

  if (!startDate || !endDate) {
    cardIdle("business");
    renderHolidayHits(null);
    const single = startDate || endDate || null;
    await setCalendarView("biz", { anchor: single, rangeStart: single, rangeEnd: single });
    return;
  }

  lastValidCalc.business = null;
  try {
    const res = await engine("calc_business_days", {
      startDate,
      endDate,
      includeEndDay,
      calendar: currentCalendar()
    });
    if (ticket !== seq.business) return;
    const r = okResult(res);
    if (!r) {
      cardError("business", errorMessage(res));
      renderHolidayHits(null);
      return;
    }

    renderResult(
      "bizResult",
      str(r.summaryText),
      [
        `${plural(r.calendarDays, "calendar day")} · ${plural(
          r.weekendDays,
          "weekend day"
        )} · ${plural(r.holidayDays, "holiday")}`,
        `${calendarShortText()} · ${
          includeEndDay ? "later date included" : "later date not counted"
        }${r.direction === "backward" ? " · end date is before the start date" : ""}`
      ],
      warningTexts(r)
    );
    setTraceLines("business", r.traceLines);
    setLive("business", `→ ${str(r.summaryText)}`);
    renderHolidayHits(r);

    lastValidCalc.business = {
      calculator: "business",
      calculatorLabel: CARD_META.business.label,
      inputs: { startDate, endDate, includeEndDay: String(includeEndDay) },
      inputsText: `${startDate} → ${endDate}${
        includeEndDay ? " (incl. later date)" : ""
      } · ${calendarShortText()}`,
      resultText: str(r.breakdownText),
      copyText: str(r.copyText)
    };

    const earlier = startDate <= endDate ? startDate : endDate;
    await setCalendarView("biz", { anchor: earlier, rangeStart: startDate, rangeEnd: endDate });
  } catch {
    if (ticket !== seq.business) return;
    cardError("business", "Calculation failed.");
    renderHolidayHits(null);
  }
}

// ---------------------------------------------------------------------------
// Card 4: Age
// ---------------------------------------------------------------------------

function setLeapRule(rule, triggerUpdate = true) {
  leapRule = rule === "mar1" ? "mar1" : "feb28";
  setPressed($("ageLeapFeb28Btn"), leapRule === "feb28");
  setPressed($("ageLeapMar1Btn"), leapRule === "mar1");
  return triggerUpdate ? updateAgeLive() : Promise.resolve();
}

function updateAgeHint() {
  const hint = $("ageAsOfHint");
  if (hint) hint.textContent = `empty = today (${todayIso()})`;
}

async function updateAgeLive() {
  const ticket = ++seq.age;
  const birthDate = readDate("ageBirth");
  const asOfRaw = readDate("ageAsOf");
  // FROZEN §8: an empty as-of field means local today, shown in the hint.
  const asOfDate = asOfRaw || todayIso();
  const rule = leapRule;
  updateAgeHint();

  if (!birthDate) {
    cardIdle("age");
    return;
  }

  lastValidCalc.age = null;
  try {
    const res = await engine("calc_age", { birthDate, asOfDate, leapDayRule: rule });
    if (ticket !== seq.age) return;
    const r = okResult(res);
    if (!r) {
      cardError("age", errorMessage(res));
      return;
    }

    const nb = r.nextBirthday && typeof r.nextBirthday === "object" ? r.nextBirthday : null;
    let nextLine = "No next birthday before 9999-12-31.";
    if (nb && nb.isToday === true) {
      nextLine = `Birthday today (${str(nb.date)}): turns ${groupInt(nb.turningAge)}`;
    } else if (nb) {
      nextLine = `next birthday ${str(nb.weekday).slice(0, 3)} ${str(nb.date)} · in ${plural(
        nb.daysUntil,
        "day"
      )} (turns ${groupInt(nb.turningAge)})`;
    }
    renderResult("ageResult", str(r.ageText), [
      nextLine,
      `${plural(r.totalMonths, "month")} · ${plural(r.totalWeeks, "week")} · ${plural(
        r.totalDays,
        "day"
      )}`,
      `${str(r.summaryText)} · born on a ${str(r.bornWeekday)} · as of ${asOfDate}${
        asOfRaw ? "" : " (today)"
      }`
    ]);
    setTraceLines("age", r.traceLines);
    setLive("age", `→ ${str(r.ageText)}`);

    lastValidCalc.age = {
      calculator: "age",
      calculatorLabel: CARD_META.age.label,
      inputs: { birthDate, asOfDate: asOfRaw, leapDayRule: rule },
      inputsText: `born ${birthDate} · as of ${asOfDate}${asOfRaw ? "" : " (today)"}${
        rule === "mar1" ? " · Feb 29 → Mar 1" : ""
      }`,
      resultText: str(r.ageText),
      copyText: str(r.copyText)
    };
  } catch {
    if (ticket !== seq.age) return;
    cardError("age", "Calculation failed.");
  }
}

// ---------------------------------------------------------------------------
// Card 5: Date Info
// ---------------------------------------------------------------------------

function infoRows(rows) {
  const wrap = document.createElement("div");
  wrap.className = "info-rows";
  rows.forEach(([key, value]) => {
    wrap.append(span("info-key", key), span("info-val", value));
  });
  return wrap;
}

function calendarDayText(grid, date) {
  const cells = Array.isArray(grid?.cells) ? grid.cells : [];
  const cell = cells.find((c) => c && c.inMonth && c.date === date);
  if (!cell) return null;
  if (cell.holiday) {
    const names = Array.isArray(cell.holidayNames) ? cell.holidayNames.join(" / ") : "";
    return `holiday: ${names}${cell.approximate ? " (estimated)" : ""}${
      cell.weekend ? " · weekend" : ""
    }`;
  }
  return cell.weekend ? "weekend" : "working day";
}

async function updateInfoLive() {
  const ticket = ++seq.info;
  const date = readDate("infoDate");

  if (!date) {
    cardIdle("info");
    await setCalendarView("info", { anchor: null });
    return;
  }

  lastValidCalc.info = null;
  try {
    const [res, grid] = await Promise.all([
      engine("calc_date_info", { date, today: todayIso() }),
      setCalendarView("info", { anchor: date, rangeStart: date, rangeEnd: date })
    ]);
    if (ticket !== seq.info) return;
    const r = okResult(res);
    if (!r) {
      cardError("info", errorMessage(res));
      return;
    }

    const rows = [
      ["Weekday", str(r.weekday)],
      [
        "ISO week",
        `${str(r.isoWeekText)} (week ${groupInt(r.isoWeek)} of ${groupInt(r.isoWeeksInYear)})`
      ],
      ["Day of year", `${groupInt(r.dayOfYear)} of ${groupInt(r.daysInYear)} · ${str(r.ordinalText)}`],
      ["Quarter", `Q${groupInt(r.quarter)}`],
      ["Leap year", `${r.isLeapYear ? "yes" : "no"} (${groupInt(r.year)})`],
      [
        "Days left",
        `${groupInt(r.daysRemainingInYear)} in the year · ${groupInt(
          r.daysRemainingInMonth
        )} in the month`
      ],
      ["Relative", str(r.relativeText) || "—"]
    ];
    const dayText = calendarDayText(grid, date);
    if (dayText) rows.push(["Calendar", `${dayText} (${calendarShortText()})`]);
    rows.push(["Unix day", groupInt(r.epochDay)]);
    rows.push(["Julian Day", groupInt(r.julianDayNumber)]);

    renderResult("infoResult", str(r.longText), [], [], [infoRows(rows)]);
    setTraceLines("info", r.traceLines);
    setLive("info", `→ ${str(r.weekday)} · ${str(r.isoWeekText)}`);

    lastValidCalc.info = {
      calculator: "info",
      calculatorLabel: CARD_META.info.label,
      inputs: { date },
      inputsText: date,
      resultText: `${str(r.longText)} · ${str(r.isoWeekText)}`,
      copyText: str(r.copyText)
    };
  } catch {
    if (ticket !== seq.info) return;
    cardError("info", "Calculation failed.");
  }
}

// ---------------------------------------------------------------------------
// Card 6: Countdown (FROZEN §7)
// ---------------------------------------------------------------------------

let cdActive = false;
let cdTimer = 0;
let cdStatusKey = "";

function clearCountdownTimer() {
  if (cdTimer) window.clearTimeout(cdTimer);
  cdTimer = 0;
}

function stopCountdown() {
  cdActive = false;
  clearCountdownTimer();
}

// Ticks land just after each whole second and pause while the window is
// hidden; the smoke test's fixed clock never ticks.
function scheduleCountdownTick() {
  clearCountdownTimer();
  if (!cdActive || fixedClock || document.visibilityState === "hidden") return;
  const delay = 1000 - (Date.now() % 1000) + 10;
  cdTimer = window.setTimeout(onCountdownTick, delay);
}

function onCountdownTick() {
  cdTimer = 0;
  checkDayRollover();
  updateCountdownLive({ fromTick: true });
}

function setCountdownStatus(key, text) {
  if (key === cdStatusKey) return;
  cdStatusKey = key;
  const el = $("cdStatus");
  if (el) el.textContent = text;
}

function setClockIdle() {
  const clock = $("cdClock");
  if (!clock) return;
  clock.textContent = "—";
  clock.classList.add("is-idle");
  clock.classList.remove("is-past");
}

async function updateCountdownLive({ fromTick = false } = {}) {
  const ticket = ++seq.countdown;
  const targetDate = readDate("cdTarget");
  const targetTime = readDate("cdTime");

  if (!targetDate) {
    stopCountdown();
    cardIdle("countdown");
    setClockIdle();
    setCountdownStatus("idle", "Pick a target date to start the countdown.");
    if (!fromTick) await setCalendarView("cd", { anchor: null });
    return;
  }

  const now = nowMoment();
  const target = {
    date: targetDate,
    time: targetTime,
    utcOffsetMinutes: offsetAt(targetDate, targetTime)
  };

  try {
    const res = await engine("calc_countdown", { now, target });
    if (ticket !== seq.countdown) return;
    const r = okResult(res);
    if (!r) {
      stopCountdown();
      const message = errorMessage(res);
      cardError("countdown", message);
      setClockIdle();
      setCountdownStatus(`error|${message}`, `Countdown stopped: ${message}`);
      if (!fromTick) await setCalendarView("cd", { anchor: targetDate });
      return;
    }

    const clock = $("cdClock");
    if (clock) {
      clock.textContent = str(r.clockText);
      clock.classList.remove("is-idle");
      clock.classList.toggle("is-past", r.status === "past");
    }
    setTraceLines("countdown", r.traceLines);
    setLive("countdown", `→ ${str(r.text)}`);

    const when = `${str(r.targetDate)} ${str(r.targetTime)} (${str(r.targetWeekday)})`;
    if (r.status === "past") {
      setCountdownStatus(
        `${targetDate}|${r.targetTime}|past`,
        `Target passed: counting the time since ${when}.`
      );
    } else if (r.status === "now") {
      setCountdownStatus(`${targetDate}|${r.targetTime}|now`, `The target time is now: ${when}.`);
    } else {
      setCountdownStatus(`${targetDate}|${r.targetTime}|future`, `Counting down to ${when}.`);
    }

    lastValidCalc.countdown = {
      calculator: "countdown",
      calculatorLabel: CARD_META.countdown.label,
      inputs: { targetDate, targetTime },
      inputsText: `${r.status === "past" ? "since" : "until"} ${targetDate}${
        targetTime ? ` ${targetTime}` : ""
      }`,
      resultText: str(r.summaryText),
      copyText: str(r.copyText)
    };

    // The polite result region changes only on an input change or a
    // calculate, never on a tick; the clock itself is not live.
    if (!fromTick) {
      renderResult("cdResult", str(r.summaryText), [
        `${groupInt(Math.abs(r.totalSeconds))} seconds · ${groupInt(
          Math.abs(r.totalMinutes)
        )} minutes · ${groupInt(Math.abs(r.totalHours))} hours`,
        `Target: ${when}, this device's local time.`
      ]);
      await setCalendarView("cd", {
        anchor: targetDate,
        rangeStart: targetDate,
        rangeEnd: targetDate
      });
      if (ticket !== seq.countdown) return;
    }

    cdActive = true;
    scheduleCountdownTick();
  } catch {
    if (ticket !== seq.countdown) return;
    stopCountdown();
    cardError("countdown", "Calculation failed.");
    setClockIdle();
  }
}

async function applyCountdownQuick(kind) {
  const today = todayIso();
  let target = null;
  if (kind === "newYear") {
    const year = Number(today.slice(0, 4)) + 1;
    if (year <= 9999) target = `${pad(year, 4)}-01-01`;
  } else {
    try {
      const r = okResult(
        await engine("calc_add_subtract", {
          date: today,
          operation: "add",
          years: "",
          months: "",
          weeks: "",
          days: kind === "plus100" ? "100" : "30",
          businessDays: false,
          calendar: currentCalendar()
        })
      );
      if (r && isIsoDate(r.resultDate)) target = r.resultDate;
    } catch {
      target = null;
    }
  }
  if (!target) return;
  setField("cdTarget", target);
  await updateCountdownLive();
}

const UPDATERS = {
  between: updateBetweenLive,
  add: updateAddLive,
  business: updateBusinessLive,
  age: updateAgeLive,
  info: updateInfoLive,
  countdown: () => updateCountdownLive()
};

async function calculateAndRecord(key) {
  await UPDATERS[key]();
  await recordHistoryFor(key);
}

// ---------------------------------------------------------------------------
// Midnight rollover: today-dependent cards refresh when the local date
// changes (checked every minute, on each countdown tick and on refocus).
// ---------------------------------------------------------------------------

let lastToday = "";

function checkDayRollover() {
  const today = todayIso();
  if (today === lastToday) return Promise.resolve();
  lastToday = today;
  return Promise.all([
    updateAgeLive(),
    updateInfoLive(),
    refreshMiniCal("biz"),
    refreshMiniCal("cd")
  ]);
}

// ---------------------------------------------------------------------------
// History (reference flows; inputs are the engine request fields)
// ---------------------------------------------------------------------------

function formatHistoryTime(timestampMs) {
  if (!timestampMs) return "---- --:--:--";
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "---- --:--:--";
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

function flashRestoredCard(cardId) {
  const cardEl = $(cardId);
  if (!cardEl) return;
  cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  cardEl.classList.remove("card-restored");
  void cardEl.offsetWidth;
  cardEl.classList.add("card-restored");
  window.clearTimeout(Number(cardEl.dataset.restoreTimer || 0));
  const timer = window.setTimeout(() => {
    cardEl.classList.remove("card-restored");
  }, 900);
  cardEl.dataset.restoreTimer = String(timer);
}

async function restoreHistoryEntry(entry) {
  if (!entry || !Object.hasOwn(CARD_META, entry.calculator)) return;
  const key = entry.calculator;
  const inputs = entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {};
  const val = (k) => (typeof inputs[k] === "string" ? inputs[k] : "");

  switch (key) {
    case "between":
      setField("betweenStart", val("startDate"));
      setField("betweenEnd", val("endDate"));
      $("betweenIncludeEnd").checked = val("includeEndDay") === "true";
      break;
    case "add":
      await setAddMode(val("operation"), false);
      setField("addStart", val("date"));
      setField("addYears", val("years"));
      setField("addMonths", val("months"));
      setField("addWeeks", val("weeks"));
      setField("addDays", val("days"));
      $("addBusiness").checked = val("businessDays") === "true";
      syncAddBusinessUi();
      break;
    case "business":
      setField("bizStart", val("startDate"));
      setField("bizEnd", val("endDate"));
      $("bizIncludeEnd").checked = val("includeEndDay") === "true";
      break;
    case "age":
      await setLeapRule(val("leapDayRule"), false);
      setField("ageBirth", val("birthDate"));
      setField("ageAsOf", val("asOfDate"));
      break;
    case "info":
      setField("infoDate", val("date"));
      break;
    case "countdown":
      setField("cdTarget", val("targetDate"));
      setField("cdTime", val("targetTime"));
      break;
    default:
      return;
  }

  await UPDATERS[key]();
  flashRestoredCard(CARD_META[key].card);
  $(CARD_META[key].first)?.focus({ preventScroll: true });
}

function renderHistory(entries) {
  const countEl = $("historyCount");
  const listEl = $("historyList");
  if (!countEl || !listEl) return;

  if (Array.isArray(entries)) {
    allHistoryEntries = entries;
  }

  countEl.textContent = `(${allHistoryEntries.length} / ${historyLimit})`;
  listEl.replaceChildren();

  const filterEl = $("historyFilter");
  if (filterEl) {
    historyFilterValue = filterEl.value || "all";
  }
  const visibleList =
    historyFilterValue === "all"
      ? allHistoryEntries
      : allHistoryEntries.filter((entry) => entry.calculator === historyFilterValue);

  if (visibleList.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "history-empty";
    emptyDiv.textContent =
      allHistoryEntries.length === 0
        ? "No calculations recorded yet. Press calculate, Enter, or copy on any card to save to history."
        : "No matching calculations for this filter.";
    listEl.appendChild(emptyDiv);
    return;
  }

  visibleList.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";
    main.append(
      span("history-time", formatHistoryTime(entry.timestampMs)),
      span("history-calc", str(entry.calculatorLabel)),
      span("history-inputs", str(entry.inputsText)),
      span("history-arrow", "→"),
      span("history-result", str(entry.resultText))
    );

    const actions = document.createElement("div");
    actions.className = "history-row-actions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn history-copy-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "copy";
    copyBtn.addEventListener("click", (event) => {
      copyText(str(entry.copyText) || str(entry.resultText), event.currentTarget);
    });

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "reset-btn history-restore-btn";
    restoreBtn.type = "button";
    restoreBtn.textContent = "↺ restore";
    restoreBtn.addEventListener("click", () => {
      restoreHistoryEntry(entry);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "reset-btn history-delete-btn";
    deleteBtn.type = "button";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete history entry";
    deleteBtn.setAttribute("aria-label", "Delete history entry");
    deleteBtn.addEventListener("click", () => {
      deleteHistoryEntry(entry.id);
    });

    actions.append(copyBtn, restoreBtn, deleteBtn);
    item.append(main, actions);
    listEl.appendChild(item);
  });
}

async function deleteHistoryEntry(id) {
  try {
    const updated = await invoke("history_delete", { id });
    renderHistory(updated);
  } catch {
    // History delete errors should not interrupt calculator usage.
  }
}

async function recordHistoryFor(key) {
  const entry = buildValidHistoryCandidate(lastValidCalc[key]);
  if (!entry) return;
  try {
    const updated = await invoke("history_add", { entry });
    renderHistory(updated);
  } catch {
    // History write errors should not interrupt calculator usage.
  }
}

async function loadHistory() {
  try {
    const entries = await invoke("history_list");
    renderHistory(entries);
  } catch {
    renderHistory([]);
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

function resetCard(key) {
  switch (key) {
    case "between":
      clearFields(["betweenStart", "betweenEnd"]);
      $("betweenIncludeEnd").checked = false;
      break;
    case "add":
      clearFields(["addStart", ...AMOUNT_IDS]);
      break;
    case "business":
      clearFields(["bizStart", "bizEnd"]);
      $("bizIncludeEnd").checked = false;
      break;
    case "age":
      clearFields(["ageBirth", "ageAsOf"]);
      break;
    case "info":
      clearFields(["infoDate"]);
      break;
    case "countdown":
      stopCountdown();
      clearFields(["cdTarget", "cdTime"]);
      break;
    default:
      return Promise.resolve();
  }
  setResultIdle(CARD_META[key].result);
  return UPDATERS[key]();
}

function clearAllCalculators() {
  const done = Promise.all(CARD_KEYS.map((key) => resetCard(key)));
  $("betweenStart")?.focus();
  return done;
}

// ---------------------------------------------------------------------------
// About modal, app info, focus return
// ---------------------------------------------------------------------------

const modalReturnFocus = { aboutModal: null, settingsModal: null };

function openModal(modalId, focusId, opener) {
  const modal = $(modalId);
  if (!modal) return;
  modalReturnFocus[modalId] =
    opener && typeof opener.focus === "function" ? opener : document.activeElement;
  modal.classList.remove("hidden");
  $(focusId)?.focus();
}

function closeModal(modalId, fallbackId) {
  const modal = $(modalId);
  if (!modal) return;
  modal.classList.add("hidden");
  const back = modalReturnFocus[modalId];
  modalReturnFocus[modalId] = null;
  const target =
    back && back !== document.body && document.contains(back) && typeof back.focus === "function"
      ? back
      : $(fallbackId);
  target?.focus();
}

function isModalOpen(modalId) {
  const modal = $(modalId);
  return Boolean(modal) && !modal.classList.contains("hidden");
}

function openAboutModal(event) {
  openModal("aboutModal", "closeAboutBtn", event?.currentTarget);
}

function closeAboutModal() {
  closeModal("aboutModal", "aboutBtn");
}

function openSettingsModal(event) {
  openModal("settingsModal", "closeSettingsBtn", event?.currentTarget);
  refreshHolidayPreview();
}

function closeSettingsModal() {
  closeModal("settingsModal", "settingsBtn");
}

function renderCreditPills(containerId, names, pillClass, prefix = "") {
  const container = $(containerId);
  if (!container || !Array.isArray(names) || names.length === 0) return;
  container.replaceChildren();
  names.forEach((name, idx) => {
    if (typeof name !== "string") return;
    if (idx > 0) container.appendChild(span("credit-dot", "·"));
    container.appendChild(span(`credit-pill ${pillClass}`, `${prefix}${name}`));
  });
}

async function syncAppInfo() {
  try {
    const appInfo = await invoke("get_app_info");
    $("appVersion").textContent = `Desktop v${appInfo.version}`;
    $("aboutAppName").textContent = appInfo.name;
    $("aboutVersionPill").textContent = `Desktop v${appInfo.version} · Tauri v2 + Rust`;
    $("aboutPrivacyText").textContent = appInfo.privacy;
    const webAppEl = $("webAppUrlText");
    if (webAppEl) webAppEl.textContent = WEB_APP_URL;
    if (typeof appInfo.historyLimit === "number") {
      historyLimit = appInfo.historyLimit;
      renderHistory();
    }
    renderCreditPills("aboutCreatorsRow", appInfo.creators, "credit-pill-gold");
    renderCreditPills("aboutAiRow", appInfo.aiBuilders, "credit-pill-slate", "built with ");
    return appInfo;
  } catch {
    // Keep the static fallback version in index.html if outside Tauri.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Updates (reference)
// ---------------------------------------------------------------------------

let latestReleaseUrl = RELEASE_URL;

function setUpdateStatus(text, isError = false) {
  const statusEl = $("updateStatusText");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", isError);
}

function showUpdateBanner(latestVersion, releaseUrl) {
  const banner = $("updateBanner");
  const textEl = $("updateBannerText");
  if (!banner || !textEl) return;
  latestReleaseUrl = releaseUrl || RELEASE_URL;
  textEl.textContent = `Update available: v${latestVersion} is now released on GitHub.`;
  banner.classList.remove("hidden");
}

function hideUpdateBanner() {
  $("updateBanner")?.classList.add("hidden");
}

function applyUpdateResult(result, showNoUpdateMessage = true) {
  if (!result) return;
  if (result.releaseUrl) {
    latestReleaseUrl = result.releaseUrl;
  }

  if (!result.ok) {
    if (showNoUpdateMessage) {
      setUpdateStatus(result.error || "Unable to reach GitHub Releases right now.", true);
    }
    return;
  }

  if (result.updateAvailable && result.latestVersion) {
    showUpdateBanner(result.latestVersion, result.releaseUrl);
    setUpdateStatus(
      `New version available: v${result.latestVersion} (current: v${result.currentVersion}).`,
      false
    );
  } else {
    hideUpdateBanner();
    if (showNoUpdateMessage) {
      const tag = result.currentVersion || result.latestVersion;
      setUpdateStatus(
        tag
          ? `Up to date — running Desktop v${tag}.`
          : "Up to date — running the latest Desktop build.",
        false
      );
    }
  }
}

async function runUpdateCheck(manual = false) {
  const checkBtn = $("checkUpdatesNowBtn");
  if (checkBtn) checkBtn.disabled = true;
  if (manual) {
    setUpdateStatus("Checking GitHub Releases for updates...", false);
  }
  try {
    const result = await invoke("check_for_updates");
    applyUpdateResult(result, manual || result?.updateAvailable);
    return result;
  } catch (err) {
    if (manual) {
      setUpdateStatus(String(err || "Update check failed."), true);
    }
    return null;
  } finally {
    if (checkBtn) checkBtn.disabled = false;
  }
}

async function openReleasePage() {
  try {
    await invoke("open_release_page");
  } catch {
    // Opening external URLs may fail in restricted environments.
  }
}

// ---------------------------------------------------------------------------
// Settings: commit-on-success, one set_settings per change, queued and
// seq-guarded; the UI re-renders from the last saved settings on error.
// ---------------------------------------------------------------------------

let settingsSeq = 0;
let settingsQueue = Promise.resolve();
let lastSettingsCommit = Promise.resolve(true);
let weekendUiCustom = false;
let holidayYear = 2026;
let previewInstances = [];

const WEEKEND_PRESETS = {
  satSun: [6, 7],
  friSat: [5, 6],
  friOnly: [5]
};
const WEEKEND_BUTTON_IDS = [
  "weekendSatSunBtn",
  "weekendFriSatBtn",
  "weekendFriOnlyBtn",
  "weekendCustomBtn"
];

function sameDays(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = a.slice().sort((x, y) => x - y);
  const sb = b.slice().sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function weekendModeOf(weekend) {
  for (const [mode, days] of Object.entries(WEEKEND_PRESETS)) {
    if (sameDays(weekend, days)) return mode;
  }
  return "custom";
}

function cleanSettingsError(err) {
  let msg =
    typeof err === "string"
      ? err
      : err && typeof err.message === "string"
        ? err.message
        : String(err ?? "");
  msg = msg
    .replace(/^invalid calendar settings:\s*/, "")
    .replace(/^[a-z_]+ \([^)]*\):\s*/, "")
    .replace(/^[a-z_]+:\s*/, "");
  return msg.slice(0, 240) || "The setting could not be saved.";
}

const SETTINGS_ERROR_TARGETS = {
  weekend: "weekendError",
  custom: "customHolidayError",
  holidays: "holidayWarning",
  calendar: "calendarStatusText"
};

function clearSettingsErrors() {
  ["weekendError", "customHolidayError"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.textContent = "";
    el.classList.add("hidden");
  });
  const warn = $("holidayWarning");
  if (warn && warn.classList.contains("settings-error")) {
    warn.classList.remove("settings-error");
    warn.textContent = "";
    warn.classList.add("hidden");
  }
  $("calendarStatusText")?.classList.remove("is-error");
}

function showSettingsError(target, message) {
  if (target === "update") {
    setUpdateStatus("Failed to save update setting.", true);
    return;
  }
  const el = $(SETTINGS_ERROR_TARGETS[target] || "calendarStatusText");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  if (el.id === "holidayWarning") el.classList.add("settings-error");
  if (el.id === "calendarStatusText") el.classList.add("is-error");
}

function renderSettingsUi() {
  const s = savedSettings;
  const cal = s.calendar;

  const toggle = $("autoUpdateToggle");
  if (toggle) toggle.checked = Boolean(s.checkUpdatesOnStartup);

  const mode = weekendUiCustom ? "custom" : weekendModeOf(cal.weekend);
  WEEKEND_BUTTON_IDS.forEach((id) => {
    const btn = $(id);
    setPressed(btn, btn?.dataset.weekend === mode);
  });
  $("weekendCustomFieldset")?.classList.toggle("hidden", mode !== "custom");
  for (let iso = 1; iso <= 7; iso++) {
    const box = $(`weekendDay${iso}`);
    if (box) box.checked = cal.weekend.includes(iso);
  }
  const workdays = 7 - cal.weekend.length;
  const note = $("weekendNote");
  if (note) {
    note.textContent = `${workdays} working day${workdays === 1 ? "" : "s"} per week.`;
  }

  const presetSelect = $("holidayPresetSelect");
  if (presetSelect) presetSelect.value = cal.preset;
  const isEgypt = cal.preset === "eg";
  $("egyptWeekendNote")?.classList.toggle("hidden", !isEgypt);
  $("hijriBlock")?.classList.toggle("hidden", !isEgypt);
  const offset = Number(cal.hijriOffsetDays) || 0;
  const offsetEl = $("hijriOffsetValue");
  if (offsetEl) offsetEl.textContent = offset > 0 ? `+${offset}` : String(offset);
  const minus = $("hijriOffsetMinusBtn");
  const plus = $("hijriOffsetPlusBtn");
  if (minus) minus.disabled = offset <= -HIJRI_OFFSET_MAX;
  if (plus) plus.disabled = offset >= HIJRI_OFFSET_MAX;

  renderCustomHolidays();

  const fdw = $("firstDayOfWeekSelect");
  if (fdw) fdw.value = s.firstDayOfWeek === "sunday" ? "sunday" : "monday";

  updateCalendarSummaries();
}

async function refreshCalendarInfo() {
  const ticket = ++seq.calendarInfo;
  let info = null;
  try {
    info = okResult(await engine("validate_calendar", { calendar: currentCalendar() }));
  } catch {
    info = null;
  }
  if (ticket !== seq.calendarInfo) return;
  calendarInfo = info;
  const status = $("calendarStatusText");
  if (status) {
    status.textContent = info ? str(info.summaryText) : calendarShortText();
    status.classList.remove("is-error");
  }
  updateCalendarSummaries();
}

async function refreshCalendarDependents() {
  await Promise.all([
    refreshCalendarInfo(),
    updateAddLive(),
    updateBusinessLive(),
    updateInfoLive(),
    refreshMiniCal("cd"),
    refreshHolidayPreview()
  ]);
}

function commitSettings(mutate, errorTarget = "calendar", calendarChanged = true) {
  const run = async () => {
    const ticket = ++settingsSeq;
    const next = cloneSettings(savedSettings);
    if (mutate(next) === false) return false;
    clearSettingsErrors();
    try {
      const saved = await invoke("set_settings", { settings: next });
      if (ticket !== settingsSeq) return false;
      savedSettings = normalizeLoadedSettings(isSettingsShape(saved) ? saved : next);
      renderSettingsUi();
      if (calendarChanged) await refreshCalendarDependents();
      return true;
    } catch (err) {
      if (ticket !== settingsSeq) return false;
      renderSettingsUi();
      showSettingsError(errorTarget, cleanSettingsError(err));
      if (calendarChanged) await refreshHolidayPreview();
      return false;
    }
  };
  const p = settingsQueue.then(run, run);
  settingsQueue = p.catch(() => false);
  return p;
}

function trackSettings(promise) {
  lastSettingsCommit = promise;
  return promise;
}

async function loadSettingsAndMaybeCheckUpdates(isSmokeMode = false) {
  const ticket = ++settingsSeq;
  let loaded = cloneSettings(DEFAULT_SETTINGS);
  try {
    const s = await invoke("get_settings");
    if (isSettingsShape(s)) loaded = s;
  } catch {
    loaded.checkUpdatesOnStartup = false;
  }

  if (ticket === settingsSeq) {
    savedSettings = normalizeLoadedSettings(loaded);
    renderSettingsUi();
  }

  if (savedSettings.checkUpdatesOnStartup && !isSmokeMode) {
    runUpdateCheck(false);
  }
}

function setWeekendPreset(mode) {
  weekendUiCustom = false;
  const days = WEEKEND_PRESETS[mode];
  if (!days) return Promise.resolve(false);
  return commitSettings((next) => {
    next.calendar.weekend = days.slice();
  }, "weekend");
}

function showCustomWeekend() {
  weekendUiCustom = true;
  renderSettingsUi();
  $("weekendDay1")?.focus();
}

function onCustomWeekendChange(event) {
  const box = event.currentTarget;
  const days = [];
  for (let iso = 1; iso <= 7; iso++) {
    if ($(`weekendDay${iso}`)?.checked) days.push(iso);
  }
  if (days.length === 7) {
    // The weekend cannot cover all seven days: nothing is saved.
    box.checked = false;
    showSettingsError("weekend", "The weekend cannot cover all seven days.");
    return Promise.resolve(false);
  }
  weekendUiCustom = true;
  return commitSettings((next) => {
    next.calendar.weekend = days;
  }, "weekend");
}

// Owner decision: choosing Egypt switches the weekend to Fri/Sat (the user
// may change it back). Leaving Egypt while still on Fri/Sat returns to the
// Sat/Sun default of the other presets.
function onPresetChange(event) {
  const value = event.currentTarget.value;
  if (!Object.hasOwn(PRESET_LABELS, value)) return Promise.resolve(false);
  weekendUiCustom = false;
  return commitSettings((next) => {
    const previous = next.calendar.preset;
    next.calendar.preset = value;
    if (value === "eg") {
      next.calendar.weekend = WEEKEND_PRESETS.friSat.slice();
    } else if (previous === "eg" && sameDays(next.calendar.weekend, WEEKEND_PRESETS.friSat)) {
      next.calendar.weekend = WEEKEND_PRESETS.satSun.slice();
    }
  }, "holidays");
}

function stepHijriOffset(delta) {
  return commitSettings((next) => {
    const current = Number(next.calendar.hijriOffsetDays) || 0;
    const value = Math.max(-HIJRI_OFFSET_MAX, Math.min(HIJRI_OFFSET_MAX, current + delta));
    if (value === current) return false;
    next.calendar.hijriOffsetDays = value;
    return true;
  }, "holidays");
}

function setHolidayIncluded(id, included) {
  const preset = savedSettings.calendar.preset;
  if (!["us", "uk", "eg"].includes(preset)) return Promise.resolve(false);
  return commitSettings((next) => {
    const ex = next.calendar.excludedHolidays;
    const list = (Array.isArray(ex[preset]) ? ex[preset] : []).filter((x) => x !== id);
    if (!included) list.push(id);
    ex[preset] = list;
  }, "holidays");
}

// An override needs the Hijri year of the instance. The engine is the only
// Hijri arithmetic here: the instance's own date is within ±2 days of the
// tabular date, so exactly one candidate year validates.
async function findHijriYear(event, instanceDate) {
  const gy = Number(instanceDate.slice(0, 4));
  const estimate = Math.floor((gy - 622) * 1.030684);
  for (const hy of [estimate, estimate + 1, estimate - 1, estimate + 2, estimate - 2]) {
    if (hy < HIJRI_YEAR_MIN || hy > HIJRI_YEAR_MAX) continue;
    const calendar = cloneSettings(savedSettings).calendar;
    calendar.hijriOverrides = calendar.hijriOverrides.filter(
      (o) => !(o.hijriYear === hy && o.event === event)
    );
    calendar.hijriOverrides.push({ hijriYear: hy, event, date: instanceDate });
    try {
      if (okResult(await engine("validate_calendar", { calendar }))) return hy;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function setHijriOverride(instance, newDate) {
  const event = instance.id;
  const existing = savedSettings.calendar.hijriOverrides.find(
    (o) => o.event === event && o.date === instance.date
  );
  if (!newDate) {
    if (!existing) return true;
    return commitSettings((next) => {
      next.calendar.hijriOverrides = next.calendar.hijriOverrides.filter(
        (o) => !(o.event === event && o.hijriYear === existing.hijriYear)
      );
    }, "holidays");
  }
  if (!isIsoDate(newDate)) return false;
  const hijriYear = existing ? existing.hijriYear : await findHijriYear(event, instance.date);
  if (hijriYear === null) {
    showSettingsError("holidays", "This date could not be matched to an Islamic year.");
    await refreshHolidayPreview();
    return false;
  }
  return commitSettings((next) => {
    next.calendar.hijriOverrides = next.calendar.hijriOverrides.filter(
      (o) => !(o.event === event && o.hijriYear === hijriYear)
    );
    next.calendar.hijriOverrides.push({ hijriYear, event, date: newDate });
  }, "holidays");
}

function holidayPreviewEmpty(text) {
  const li = document.createElement("li");
  li.className = "holiday-empty";
  li.textContent = text;
  return li;
}

function renderHolidayRow(instance, index, excludedIds, overrides) {
  const li = document.createElement("li");
  const excluded = excludedIds.includes(instance.id);
  li.className = excluded ? "holiday-row is-excluded" : "holiday-row";

  const check = document.createElement("label");
  check.className = "holiday-check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "settings-checkbox";
  box.checked = !excluded;
  box.id = `holidayRow${index}`;
  box.addEventListener("change", (event) => {
    trackSettings(setHolidayIncluded(instance.id, event.currentTarget.checked));
  });
  check.htmlFor = box.id;
  const dayIndex = typeof instance.dayIndex === "number" ? ` (day ${instance.dayIndex})` : "";
  check.append(box, span("holiday-name", `${str(instance.name)}${dayIndex}`));

  const meta = document.createElement("div");
  meta.className = "holiday-meta";
  meta.appendChild(span("holiday-date", str(instance.date)));
  if (instance.shifted === true) {
    meta.appendChild(span("holiday-observed", `actual ${str(instance.actualDate)}`));
  }
  if (instance.onWeekend === true) {
    meta.appendChild(span("holiday-observed", "on the weekend"));
  }
  if (instance.approximate === true) {
    meta.appendChild(span("approx-tag", "estimated"));
  }
  li.append(check, meta);

  const overridable =
    instance.approximate === true &&
    HIJRI_EVENTS.has(instance.id) &&
    (instance.dayIndex === null || instance.dayIndex === undefined || instance.dayIndex === 1);
  if (overridable) {
    const wrap = document.createElement("div");
    wrap.className = "holiday-override";
    const input = document.createElement("input");
    input.type = "date";
    input.className = "settings-input date-input";
    input.id = `holidayOverride${index}`;
    input.min = "1900-01-01";
    input.max = "2199-12-31";
    input.dataset.event = instance.id;
    const current = overrides.find((o) => o.event === instance.id && o.date === instance.date);
    input.value = current ? current.date : "";
    syncDateEmpty(input);
    input.addEventListener("input", () => syncDateEmpty(input));
    input.addEventListener("change", () => {
      syncDateEmpty(input);
      trackSettings(setHijriOverride(instance, input.value.trim()));
    });
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = current ? "announced date (set)" : "set announced date";
    wrap.append(label, input);
    li.appendChild(wrap);
  }
  return li;
}

async function refreshHolidayPreview() {
  const ticket = ++seq.preview;
  const cal = currentCalendar();
  const list = $("holidayPreviewList");
  const yearEl = $("holidayYearValue");
  const warn = $("holidayWarning");
  if (yearEl) yearEl.textContent = String(holidayYear);
  const prev = $("holidayYearPrevBtn");
  const next = $("holidayYearNextBtn");
  if (prev) prev.disabled = holidayYear <= HOLIDAY_MIN_YEAR;
  if (next) next.disabled = holidayYear >= HOLIDAY_MAX_YEAR;
  if (!list) return;

  const keepError = warn?.classList.contains("settings-error");
  if (cal.preset === "none") {
    previewInstances = [];
    list.replaceChildren(holidayPreviewEmpty("No holiday preset selected."));
    if (warn && !keepError) {
      warn.textContent = "";
      warn.classList.add("hidden");
    }
    return;
  }

  // The preview is an unsaved variant of the calendar: exclusions and custom
  // holidays are dropped so that every preset holiday is listed and can be
  // switched back on.
  const previewCalendar = cloneSettings(cal);
  previewCalendar.excludedHolidays = { us: [], uk: [], eg: [] };
  previewCalendar.customHolidays = [];
  let result = null;
  try {
    result = okResult(
      await engine("holidays_in_range", {
        startDate: `${pad(holidayYear, 4)}-01-01`,
        endDate: `${pad(holidayYear, 4)}-12-31`,
        calendar: previewCalendar
      })
    );
  } catch {
    result = null;
  }
  if (ticket !== seq.preview) return;

  if (!result) {
    previewInstances = [];
    list.replaceChildren(holidayPreviewEmpty("Holidays could not be listed."));
    return;
  }
  const instances = Array.isArray(result.holidays)
    ? result.holidays.filter((h) => h && typeof h === "object" && h.source !== "custom")
    : [];
  previewInstances = instances;
  const excludedIds = Array.isArray(cal.excludedHolidays?.[cal.preset])
    ? cal.excludedHolidays[cal.preset]
    : [];
  const overrides = Array.isArray(cal.hijriOverrides) ? cal.hijriOverrides : [];
  if (instances.length === 0) {
    list.replaceChildren(holidayPreviewEmpty(`No ${calendarPresetText(cal)} holidays in ${holidayYear}.`));
  } else {
    list.replaceChildren(
      ...instances.map((inst, i) => renderHolidayRow(inst, i, excludedIds, overrides))
    );
  }

  if (warn && !keepError) {
    const outOfRange =
      Array.isArray(result.warnings) && result.warnings.includes("presetYearOutOfRange");
    const first = calendarInfo?.presetFirstYear;
    const last = calendarInfo?.presetLastYear;
    warn.textContent = outOfRange
      ? `The ${calendarPresetText(cal)} preset has no holidays for ${holidayYear}${
          typeof first === "number" && typeof last === "number"
            ? ` (it covers ${first}–${last})`
            : ""
        }; only the weekend counts in that year.`
      : "";
    warn.classList.toggle("hidden", !outOfRange);
  }
}

function shiftHolidayYear(delta) {
  holidayYear = Math.max(HOLIDAY_MIN_YEAR, Math.min(HOLIDAY_MAX_YEAR, holidayYear + delta));
  return refreshHolidayPreview();
}

function renderCustomHolidays() {
  const list = $("customHolidayList");
  const countEl = $("customHolidayCount");
  const addBtn = $("addCustomHolidayBtn");
  const customs = Array.isArray(savedSettings.calendar.customHolidays)
    ? savedSettings.calendar.customHolidays
    : [];
  if (countEl) countEl.textContent = `(${customs.length} / ${MAX_CUSTOM_HOLIDAYS})`;
  if (addBtn) addBtn.disabled = customs.length >= MAX_CUSTOM_HOLIDAYS;
  if (!list) return;
  if (customs.length === 0) {
    list.replaceChildren(holidayPreviewEmpty("No custom holidays yet."));
    return;
  }
  list.replaceChildren(
    ...customs.map((c) => {
      const li = document.createElement("li");
      li.className = "custom-holiday-row";
      const main = document.createElement("div");
      main.className = "custom-holiday-main";
      const name = str(c.name);
      main.appendChild(span("holiday-name", name));
      if (c.kind === "yearly") {
        const md = `${pad(Number(c.month) || 0)}-${pad(Number(c.day) || 0)}`;
        const from = typeof c.fromYear === "number" ? ` from ${c.fromYear}` : "";
        main.append(span("holiday-date", `every ${md}${from}`), span("yearly-tag", "yearly"));
      } else {
        main.appendChild(span("holiday-date", str(c.date)));
      }
      if (c.enabled === false) main.appendChild(span("holiday-observed", "disabled"));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "reset-btn";
      del.textContent = "×";
      del.title = "Delete custom holiday";
      del.setAttribute("aria-label", `Delete custom holiday ${name}`);
      del.addEventListener("click", () => {
        trackSettings(deleteCustomHoliday(c.id));
      });
      li.append(main, del);
      return li;
    })
  );
}

function newCustomHolidayId(existing) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let n;
    if (window.crypto?.getRandomValues) {
      n = window.crypto.getRandomValues(new Uint32Array(1))[0];
    } else {
      n = Math.floor(Math.random() * 0x100000000);
    }
    const id = `c-${n.toString(16).padStart(8, "0")}`;
    if (!existing.has(id)) return id;
  }
  return null;
}

async function addCustomHoliday() {
  const nameEl = $("customHolidayName");
  const dateEl = $("customHolidayDate");
  const yearlyEl = $("customHolidayYearly");
  clearSettingsErrors();
  const name = (nameEl?.value ?? "").trim();
  const date = (dateEl?.value ?? "").trim();
  const customs = savedSettings.calendar.customHolidays;
  if (!name) {
    showSettingsError("custom", "Enter a name for the holiday.");
    return false;
  }
  if (!isIsoDate(date)) {
    showSettingsError("custom", "Pick a date for the holiday.");
    return false;
  }
  if (customs.length >= MAX_CUSTOM_HOLIDAYS) {
    showSettingsError("custom", `At most ${MAX_CUSTOM_HOLIDAYS} custom holidays are allowed.`);
    return false;
  }
  const id = newCustomHolidayId(new Set(customs.map((c) => c.id)));
  if (!id) return false;
  const year = Number(date.slice(0, 4));
  const entry = yearlyEl?.checked
    ? {
        id,
        name,
        kind: "yearly",
        month: Number(date.slice(5, 7)),
        day: Number(date.slice(8, 10)),
        fromYear: year,
        enabled: true
      }
    : { id, name, kind: "date", date, enabled: true };
  const ok = await commitSettings((next) => {
    next.calendar.customHolidays = [...next.calendar.customHolidays, entry];
  }, "custom");
  if (ok) {
    if (nameEl) nameEl.value = "";
    setField("customHolidayDate", "");
    if (yearlyEl) yearlyEl.checked = false;
  }
  return ok;
}

function deleteCustomHoliday(id) {
  return commitSettings((next) => {
    next.calendar.customHolidays = next.calendar.customHolidays.filter((c) => c.id !== id);
  }, "custom");
}

function onFirstDayChange(event) {
  const value = event.currentTarget.value === "sunday" ? "sunday" : "monday";
  return commitSettings((next) => {
    next.firstDayOfWeek = value;
  }, "calendar");
}

function onAutoUpdateChange(event) {
  const toggle = event.currentTarget;
  const value = Boolean(toggle.checked);
  return commitSettings(
    (next) => {
      next.checkUpdatesOnStartup = value;
    },
    "update",
    false
  );
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

function bindControls() {
  $("clearAllBtn").addEventListener("click", () => {
    clearAllCalculators();
  });
  $("settingsBtn")?.addEventListener("click", openSettingsModal);
  $("aboutBtn").addEventListener("click", openAboutModal);
  $("copyWebUrlBtn")?.addEventListener("click", (event) => {
    copyText(WEB_APP_URL, event.currentTarget);
  });

  $("closeAboutBtn").addEventListener("click", closeAboutModal);
  $("closeAboutXBtn").addEventListener("click", closeAboutModal);
  $("aboutModal").addEventListener("click", (event) => {
    if (event.target.id === "aboutModal") closeAboutModal();
  });

  $("closeSettingsBtn")?.addEventListener("click", closeSettingsModal);
  $("closeSettingsXBtn")?.addEventListener("click", closeSettingsModal);
  $("settingsModal")?.addEventListener("click", (event) => {
    if (event.target.id === "settingsModal") closeSettingsModal();
  });
  $("addCalendarEditBtn")?.addEventListener("click", openSettingsModal);
  $("bizCalendarEditBtn")?.addEventListener("click", openSettingsModal);

  $("autoUpdateToggle")?.addEventListener("change", (event) => {
    trackSettings(onAutoUpdateChange(event));
  });
  $("checkUpdatesNowBtn")?.addEventListener("click", () => runUpdateCheck(true));
  $("openReleasePageBtn")?.addEventListener("click", openReleasePage);
  $("copyReleaseUrlBtn")?.addEventListener("click", (event) => {
    copyText(latestReleaseUrl, event.currentTarget);
  });

  $("openUpdateBannerBtn")?.addEventListener("click", openReleasePage);
  $("copyUpdateBannerBtn")?.addEventListener("click", (event) => {
    copyText(latestReleaseUrl, event.currentTarget);
  });
  $("dismissUpdateBannerBtn")?.addEventListener("click", hideUpdateBanner);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isModalOpen("aboutModal")) closeAboutModal();
    if (isModalOpen("settingsModal")) closeSettingsModal();
  });

  // History filter & clear confirmation flow
  $("historyFilter")?.addEventListener("change", (event) => {
    historyFilterValue = event.currentTarget.value || "all";
    renderHistory();
  });

  const clearHistoryBtn = $("clearHistoryBtn");
  const clearConfirmGroup = $("clearHistoryConfirm");
  clearHistoryBtn.addEventListener("click", () => {
    clearHistoryBtn.classList.add("hidden");
    clearConfirmGroup.classList.remove("hidden");
    $("cancelClearHistoryBtn")?.focus();
  });
  $("cancelClearHistoryBtn").addEventListener("click", () => {
    clearConfirmGroup.classList.add("hidden");
    clearHistoryBtn.classList.remove("hidden");
    clearHistoryBtn.focus();
  });
  $("confirmClearHistoryBtn").addEventListener("click", async () => {
    try {
      const entries = await invoke("history_clear");
      renderHistory(entries);
    } catch {
      renderHistory([]);
    }
    clearConfirmGroup.classList.add("hidden");
    clearHistoryBtn.classList.remove("hidden");
  });
}

function bindSettingsControls() {
  WEEKEND_BUTTON_IDS.forEach((id) => {
    const btn = $(id);
    btn?.addEventListener("click", () => {
      const mode = btn.dataset.weekend;
      if (mode === "custom") {
        showCustomWeekend();
      } else {
        trackSettings(setWeekendPreset(mode));
      }
    });
  });
  for (let iso = 1; iso <= 7; iso++) {
    $(`weekendDay${iso}`)?.addEventListener("change", (event) => {
      trackSettings(onCustomWeekendChange(event));
    });
  }
  $("holidayPresetSelect")?.addEventListener("change", (event) => {
    trackSettings(onPresetChange(event));
  });
  $("hijriOffsetMinusBtn")?.addEventListener("click", () => {
    trackSettings(stepHijriOffset(-1));
  });
  $("hijriOffsetPlusBtn")?.addEventListener("click", () => {
    trackSettings(stepHijriOffset(1));
  });
  $("holidayYearPrevBtn")?.addEventListener("click", () => shiftHolidayYear(-1));
  $("holidayYearNextBtn")?.addEventListener("click", () => shiftHolidayYear(1));
  $("addCustomHolidayBtn")?.addEventListener("click", () => {
    trackSettings(addCustomHoliday());
  });
  $("customHolidayName")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") trackSettings(addCustomHoliday());
  });
  $("firstDayOfWeekSelect")?.addEventListener("change", (event) => {
    trackSettings(onFirstDayChange(event));
  });
}

function bindCards() {
  // Calculate / clear / copy for every card.
  CARD_KEYS.forEach((key) => {
    const [calcId, resetId, copyId] = CARD_META[key].buttons;
    $(calcId).addEventListener("click", () => calculateAndRecord(key));
    $(resetId).addEventListener("click", () => resetCard(key));
    $(copyId).addEventListener("click", async (event) => {
      await copyCardResult(key, event.currentTarget);
    });
    attachEnterKey(CARD_META[key].enterIds, () => calculateAndRecord(key));
  });

  // Every native date/time input keeps its empty-state hint class in sync.
  document.querySelectorAll('input[type="date"], input[type="time"]').forEach((el) => {
    syncDateEmpty(el);
    el.addEventListener("input", () => syncDateEmpty(el));
    el.addEventListener("change", () => syncDateEmpty(el));
  });

  const live = (ids, fn, events = ["input", "change"]) => {
    ids.forEach((id) => {
      const el = $(id);
      events.forEach((type) => el?.addEventListener(type, () => fn()));
    });
  };

  live(["betweenStart", "betweenEnd"], updateBetweenLive);
  live(["betweenIncludeEnd"], updateBetweenLive, ["change"]);
  $("swapBetweenBtn").addEventListener("click", () =>
    swapFields("betweenStart", "betweenEnd", updateBetweenLive)
  );

  live(["addStart"], updateAddLive);
  AMOUNT_IDS.forEach((id) => {
    const el = $(id);
    el?.addEventListener("input", () => {
      normalizeFieldDigits(el);
      updateAddLive();
    });
  });
  $("addBusiness")?.addEventListener("change", () => {
    syncAddBusinessUi();
    updateAddLive();
  });
  $("addModeAddBtn").addEventListener("click", () => setAddMode("add"));
  $("addModeSubtractBtn").addEventListener("click", () => setAddMode("subtract"));

  live(["bizStart", "bizEnd"], updateBusinessLive);
  live(["bizIncludeEnd"], updateBusinessLive, ["change"]);
  $("swapBizBtn").addEventListener("click", () =>
    swapFields("bizStart", "bizEnd", updateBusinessLive)
  );

  live(["ageBirth", "ageAsOf"], updateAgeLive);
  $("ageLeapFeb28Btn").addEventListener("click", () => setLeapRule("feb28"));
  $("ageLeapMar1Btn").addEventListener("click", () => setLeapRule("mar1"));

  live(["infoDate"], updateInfoLive);

  live(["cdTarget", "cdTime"], () => updateCountdownLive());
  document.querySelectorAll(".quick-pill[data-quick]").forEach((btn) => {
    btn.addEventListener("click", () => applyCountdownQuick(btn.dataset.quick));
  });

  // "today" buttons fill their target from the local date.
  document.querySelectorAll(".today-btn[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = $(btn.dataset.target);
      if (!target) return;
      target.value = todayIso();
      syncDateEmpty(target);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  // Mini calendar month navigation.
  Object.keys(calViews).forEach((key) => {
    const p = calViews[key].prefix;
    $(`${p}PrevBtn`)?.addEventListener("click", () => shiftCalendar(key, -1));
    $(`${p}NextBtn`)?.addEventListener("click", () => shiftCalendar(key, 1));
  });

  attachAmountPasteSanitizers();
}

// ---------------------------------------------------------------------------
// Smoke test (BUILD_PLAN §12 as amended by FROZEN §14). Runs inside the real
// Tauri webview when launched with `--smoke-test`, with a fixed clock and
// fixed inputs only. History and settings are in memory in that mode.
// ---------------------------------------------------------------------------

async function runSmokeTestIfRequested(smokeEnabledArg) {
  let enabled = smokeEnabledArg;
  if (typeof enabled !== "boolean") {
    try {
      enabled = await invoke("is_smoke_test");
    } catch {
      return;
    }
  }
  if (!enabled) return;

  const failures = [];
  const check = (name, ok) => {
    if (!ok) failures.push(name);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (pred) => {
    for (let i = 0; i < 40; i++) {
      if (await pred()) return true;
      await sleep(25);
    }
    return Boolean(await pred());
  };
  const txt = (id) => ($(id)?.textContent ?? "").trim();
  const setInput = async (id, value, waitFn) => {
    const el = $(id);
    el.value = value;
    syncDateEmpty(el);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFn();
  };
  const setChecked = async (id, value, waitFn) => {
    const el = $(id);
    el.checked = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFn();
  };
  const settled = async () => {
    await lastSettingsCommit;
    await settingsQueue;
  };
  const selectValue = async (id, value) => {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await settled();
  };
  const clickAndSettle = async (id) => {
    $(id).click();
    await settled();
  };
  const waitUntilCopied = (btnId) => waitUntil(() => $(btnId)?.textContent === "copied");
  const cdRegex = /^\d{1,3}(?:,\d{3})*d \d{2}h \d{2}m \d{2}s$/;

  try {
    check("initial-focus", document.activeElement?.id === "betweenStart");
    check("fixed-clock", todayIso() === "2026-11-16");

    const appInfo = await invoke("get_app_info");
    check("app-name", appInfo.name === "Date Calculator Tool");
    check("app-version", appInfo.version === "1.0.0");
    check(
      "app-credits",
      appInfo.credits.includes("Mohamed Sayed") &&
        appInfo.credits.includes("Ahmed Emara") &&
        appInfo.credits.includes("Claude")
    );
    check("footer-version", txt("appVersion").includes("Desktop v1.0.0"));

    const quickLinks = Array.from(document.querySelectorAll(".quick-nav .quick-link"));
    check(
      "quick-nav-links",
      quickLinks.length === 7 &&
        quickLinks.every((link) => {
          const targetId = link.getAttribute("href")?.replace(/^#/, "");
          return Boolean(targetId && $(targetId));
        })
    );
    quickLinks.find((link) => link.getAttribute("href") === "#card-countdown")?.click();
    check("quick-nav-hash", window.location.hash === "#card-countdown");
    window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo(0, 0);

    // 1. Days between
    await setInput("betweenStart", "2024-01-01", updateBetweenLive);
    await setInput("betweenEnd", "2024-12-31", updateBetweenLive);
    check(
      "between-365",
      txt("betweenResult").includes("365 days") &&
        txt("betweenResult").includes("11 months, 30 days") &&
        txt("betweenLiveResult") === "→ 365 days"
    );
    check(
      "between-trace",
      $("betweenTrace").querySelectorAll("li").length >= 3 &&
        txt("betweenTrace").includes("2024-12-31 - 2024-01-01 = 365 days")
    );
    await setChecked("betweenIncludeEnd", true, updateBetweenLive);
    check("between-include-end-366", txt("betweenResult").includes("366 days"));
    await swapFields("betweenStart", "betweenEnd", updateBetweenLive);
    check(
      "swap-between",
      $("betweenStart").value === "2024-12-31" &&
        $("betweenEnd").value === "2024-01-01" &&
        txt("betweenResult").includes("366 days") &&
        txt("betweenTrace").includes("swapped")
    );
    await setInput("betweenEnd", "", updateBetweenLive);
    check(
      "between-idle-when-empty",
      txt("betweenLiveResult") === "→ —" &&
        lastValidCalc.between === null &&
        $("betweenEnd").classList.contains("date-empty")
    );
    $("betweenEndTodayBtn").click();
    await updateBetweenLive();
    check("today-button-fixed-clock", $("betweenEnd").value === "2026-11-16");

    // 2. Add / subtract
    await setAddMode("add");
    await setInput("addStart", "2024-01-31", updateAddLive);
    await setInput("addMonths", "1", updateAddLive);
    check(
      "add-month-clamp",
      txt("addResult").includes("Thursday, February 29, 2024") &&
        txt("addTrace").includes("clamped") &&
        txt("addLiveResult") === "→ 2024-02-29 (Thursday)"
    );
    await setInput("addMonths", "١", updateAddLive);
    check(
      "add-arabic-indic-digits",
      $("addMonths").value === "1" && txt("addResult").includes("February 29, 2024")
    );
    await setAddMode("subtract");
    await setInput("addStart", "2024-03-31", updateAddLive);
    check(
      "subtract-mode",
      $("addModeSubtractBtn").classList.contains("active") &&
        $("addModeSubtractBtn").getAttribute("aria-pressed") === "true" &&
        $("addModeAddBtn").getAttribute("aria-pressed") === "false" &&
        txt("addResult").includes("Thursday, February 29, 2024")
    );
    await setInput("addYears", "x", updateAddLive);
    check(
      "add-invalid-amount",
      txt("addResult").includes("Years must be a whole number.") &&
        txt("addLiveResult") === "→ invalid"
    );
    $("copyAddBtn").click();
    await sleep(60);
    check("copy-blocked-on-error", $("copyAddBtn").textContent !== "copied");
    await setInput("addYears", "", updateAddLive);
    $("copyAddBtn").click();
    check("copy-feedback", await waitUntilCopied("copyAddBtn"));
    check("copy-records-history", await waitUntil(() => allHistoryEntries.length === 1));

    // 3. Business days (settings changes go through the in-memory backend)
    await setInput("bizStart", "2024-01-01", updateBusinessLive);
    await setInput("bizEnd", "2024-01-05", updateBusinessLive);
    check("biz-satsun-exclusive-4", txt("bizResult").startsWith("=4 business days"));
    await setChecked("bizIncludeEnd", true, updateBusinessLive);
    check("biz-satsun-inclusive-5", txt("bizResult").startsWith("=5 business days"));
    await clickAndSettle("weekendFriSatBtn");
    check(
      "weekend-frisat-saved",
      sameDays(savedSettings.calendar.weekend, [5, 6]) &&
        $("weekendFriSatBtn").getAttribute("aria-pressed") === "true"
    );
    check("biz-frisat-inclusive-4", txt("bizResult").startsWith("=4 business days"));
    await setChecked("bizIncludeEnd", false, updateBusinessLive);
    check("biz-frisat-exclusive-4", txt("bizResult").startsWith("=4 business days"));
    await clickAndSettle("weekendSatSunBtn");
    check("weekend-satsun-saved", sameDays(savedSettings.calendar.weekend, [6, 7]));

    await selectValue("holidayPresetSelect", "us");
    check("preset-us-saved", savedSettings.calendar.preset === "us");
    await setInput("bizEnd", "2024-01-31", updateBusinessLive);
    check(
      "biz-us-jan-2024-exclusive-20",
      txt("bizResult").startsWith("=20 business days") &&
        txt("bizHolidayList").includes("Martin Luther King") &&
        !$("bizHolidayHits").classList.contains("hidden")
    );
    await setChecked("bizIncludeEnd", true, updateBusinessLive);
    check("biz-us-jan-2024-inclusive-21", txt("bizResult").startsWith("=21 business days"));
    await setChecked("bizIncludeEnd", false, updateBusinessLive);
    check(
      "biz-mini-calendar",
      $("bizCalGrid").children.length === 42 &&
        txt("bizCalTitle") === "January 2024" &&
        $("bizCalGrid").querySelectorAll(".mini-cal-cell.holiday").length >= 2 &&
        $("bizCalGrid").querySelectorAll(".mini-cal-cell.in-range").length === 31
    );
    check("biz-calendar-summary", txt("bizCalendarSummaryText") === "Sat/Sun · US federal");

    // Holiday preview year picker and exclusion round trip
    await shiftHolidayYear(-1);
    await shiftHolidayYear(-1);
    check(
      "holiday-preview-2024",
      txt("holidayYearValue") === "2024" &&
        txt("holidayPreviewList").includes("Birthday of Martin Luther King, Jr.")
    );
    const mlkIndex = previewInstances.findIndex((h) => h.id === "mlkDay");
    const mlkBox = $(`holidayRow${mlkIndex}`);
    check("holiday-preview-row", mlkIndex >= 0 && Boolean(mlkBox) && mlkBox.checked);
    if (mlkBox) {
      mlkBox.checked = false;
      mlkBox.dispatchEvent(new Event("change", { bubbles: true }));
      await settled();
    }
    check(
      "holiday-exclusion-saved",
      savedSettings.calendar.excludedHolidays.us.includes("mlkDay") &&
        txt("bizResult").startsWith("=21 business days")
    );
    const mlkBoxAgain = $(`holidayRow${previewInstances.findIndex((h) => h.id === "mlkDay")}`);
    if (mlkBoxAgain) {
      mlkBoxAgain.checked = true;
      mlkBoxAgain.dispatchEvent(new Event("change", { bubbles: true }));
      await settled();
    }
    check(
      "holiday-exclusion-restored",
      savedSettings.calendar.excludedHolidays.us.length === 0 &&
        txt("bizResult").startsWith("=20 business days")
    );

    // Custom holiday named <b>x</b> renders literally (DOM safety)
    setField("customHolidayName", "");
    $("customHolidayName").value = "<b>x</b>";
    setField("customHolidayDate", "2024-01-10");
    await clickAndSettle("addCustomHolidayBtn");
    check(
      "custom-holiday-saved",
      savedSettings.calendar.customHolidays.length === 1 &&
        savedSettings.calendar.customHolidays[0].name === "<b>x</b>" &&
        txt("customHolidayCount") === "(1 / 100)"
    );
    check(
      "custom-holiday-literal",
      txt("customHolidayList").includes("<b>x</b>") &&
        txt("bizHolidayList").includes("<b>x</b>") &&
        txt("bizResult").startsWith("=19 business days") &&
        Boolean(
          Array.from($("bizCalGrid").children).find(
            (c) => c.dataset.date === "2024-01-10" && c.getAttribute("aria-label").includes("<b>x</b>")
          )
        ) &&
        document.querySelector("b") === null
    );
    check(
      "custom-name-not-in-copy-or-history-text",
      Boolean(lastValidCalc.business) &&
        lastValidCalc.business.copyText.includes("Custom holiday") &&
        !lastValidCalc.business.copyText.includes("<b>") &&
        !lastValidCalc.business.inputsText.includes("<b>")
    );
    await recordHistoryFor("business");
    check(
      "business-history-without-custom-name",
      allHistoryEntries.length === 2 && !txt("historyList").includes("<b>x</b>")
    );
    const customId = savedSettings.calendar.customHolidays[0]?.id;
    await trackSettings(deleteCustomHoliday(customId));
    await settled();
    check(
      "custom-holiday-deleted",
      savedSettings.calendar.customHolidays.length === 0 &&
        txt("bizResult").startsWith("=20 business days")
    );

    // Egypt preset: weekend switches to Fri/Sat, Hijri offset and override
    await selectValue("holidayPresetSelect", "eg");
    check(
      "egypt-switches-weekend",
      savedSettings.calendar.preset === "eg" &&
        sameDays(savedSettings.calendar.weekend, [5, 6]) &&
        $("weekendFriSatBtn").classList.contains("active") &&
        !$("egyptWeekendNote").classList.contains("hidden") &&
        !$("hijriBlock").classList.contains("hidden")
    );
    await clickAndSettle("hijriOffsetPlusBtn");
    check(
      "hijri-offset-saved",
      savedSettings.calendar.hijriOffsetDays === 1 && txt("hijriOffsetValue") === "+1"
    );
    await clickAndSettle("hijriOffsetMinusBtn");
    check("hijri-offset-reset", savedSettings.calendar.hijriOffsetDays === 0);
    await shiftHolidayYear(1);
    await shiftHolidayYear(1);
    const eidIndex = previewInstances.findIndex((h) => h.id === "eidAlFitr" && h.dayIndex === 1);
    const eidInput = $(`holidayOverride${eidIndex}`);
    check(
      "egypt-preview-estimated",
      txt("holidayYearValue") === "2026" &&
        eidIndex >= 0 &&
        Boolean(eidInput) &&
        txt("holidayPreviewList").includes("estimated")
    );
    if (eidInput) {
      eidInput.value = "2026-03-21";
      eidInput.dispatchEvent(new Event("change", { bubbles: true }));
      await settled();
    }
    const override = savedSettings.calendar.hijriOverrides[0];
    check(
      "hijri-override-saved",
      savedSettings.calendar.hijriOverrides.length === 1 &&
        override?.hijriYear === 1447 &&
        override?.event === "eidAlFitr" &&
        override?.date === "2026-03-21"
    );
    const eidInputAgain = $(
      `holidayOverride${previewInstances.findIndex((h) => h.id === "eidAlFitr" && h.dayIndex === 1)}`
    );
    if (eidInputAgain) {
      eidInputAgain.value = "";
      eidInputAgain.dispatchEvent(new Event("change", { bubbles: true }));
      await settled();
    }
    check("hijri-override-removed", savedSettings.calendar.hijriOverrides.length === 0);
    await clickAndSettle("weekendSatSunBtn");
    check(
      "egypt-weekend-changed-back",
      savedSettings.calendar.preset === "eg" && sameDays(savedSettings.calendar.weekend, [6, 7])
    );
    await selectValue("holidayPresetSelect", "none");
    check("preset-none-saved", savedSettings.calendar.preset === "none");

    // 4. Age
    await setInput("ageBirth", "1990-05-17", updateAgeLive);
    await setInput("ageAsOf", "2026-11-16", updateAgeLive);
    check(
      "age",
      txt("ageResult").includes("36 years, 5 months, 30 days") &&
        txt("ageResult").includes("2027-05-17") &&
        txt("ageResult").includes("turns 37")
    );
    await setInput("ageAsOf", "", updateAgeLive);
    check(
      "age-empty-as-of-is-today",
      txt("ageResult").includes("36 years, 5 months, 30 days") &&
        txt("ageAsOfHint").includes("2026-11-16")
    );
    await setInput("ageBirth", "2000-02-29", updateAgeLive);
    await setInput("ageAsOf", "2001-02-28", updateAgeLive);
    await setLeapRule("feb28");
    check("age-leap-feb28", txt("ageResult").startsWith("=1 year"));
    await setLeapRule("mar1");
    check(
      "age-leap-mar1",
      txt("ageResult").startsWith("=11 months, 30 days") &&
        $("ageLeapMar1Btn").getAttribute("aria-pressed") === "true"
    );
    await setLeapRule("feb28");

    // 5. Date info and mini calendar
    await setInput("infoDate", "2026-11-16", updateInfoLive);
    check(
      "info",
      txt("infoResult").includes("Monday, November 16, 2026") &&
        txt("infoResult").includes("2026-W47") &&
        txt("infoResult").includes("Today")
    );
    const infoCell = Array.from($("infoCalGrid").children).find(
      (c) => c.dataset.date === "2026-11-16"
    );
    check(
      "info-mini-calendar",
      $("infoCalGrid").children.length === 42 &&
        Boolean(infoCell) &&
        infoCell.classList.contains("endpoint") &&
        infoCell.classList.contains("today") &&
        $("infoCalWeekdays").firstElementChild?.textContent === "Mon"
    );
    await selectValue("firstDayOfWeekSelect", "sunday");
    check(
      "first-day-sunday",
      savedSettings.firstDayOfWeek === "sunday" &&
        $("infoCalWeekdays").firstElementChild?.textContent === "Sun"
    );
    await selectValue("firstDayOfWeekSelect", "monday");
    check("first-day-monday", savedSettings.firstDayOfWeek === "monday");

    // 6. Countdown (fixed now: 2026-11-16 10:00:00 UTC+02:00)
    await setInput("cdTarget", "2027-01-01", () => updateCountdownLive());
    check(
      "countdown-clock",
      txt("cdClock") === "45d 14h 00m 00s" &&
        cdRegex.test(txt("cdClock")) &&
        txt("cdResult").includes("45 days, 14 hours until 2027-01-01") &&
        txt("cdStatus").includes("Counting down")
    );
    check("countdown-mini-calendar", $("cdCalGrid").children.length === 42);
    await setInput("cdTarget", "9026-01-01", () => updateCountdownLive());
    check(
      "countdown-comma-days",
      txt("cdClock") === "2,556,377d 14h 00m 00s" && cdRegex.test(txt("cdClock"))
    );
    await setInput("cdTarget", "2026-01-01", () => updateCountdownLive());
    check(
      "countdown-past",
      $("cdClock").classList.contains("is-past") &&
        txt("cdResult").includes("since") &&
        txt("cdStatus").includes("since")
    );
    await applyCountdownQuick("plus30");
    check("countdown-quick-30", $("cdTarget").value === "2026-12-16");
    await applyCountdownQuick("newYear");
    check("countdown-quick-new-year", $("cdTarget").value === "2027-01-01");
    // A six-digit year is a valid <input type=date> value but out of range.
    await setInput("cdTarget", "10000-01-01", () => updateCountdownLive());
    check(
      "countdown-out-of-range-stops",
      cdActive === false && txt("cdLiveResult") === "→ invalid" && txt("cdClock") === "—"
    );
    await setInput("cdTarget", "2027-01-01", () => updateCountdownLive());
    check("countdown-active", cdActive === true);
    await resetCard("countdown");
    check(
      "countdown-reset-clears-ticker",
      cdActive === false && cdTimer === 0 && txt("cdClock") === "—" && $("cdTarget").value === ""
    );

    // History: clear, add, filter, restore, delete, clear
    $("clearHistoryBtn").click();
    $("confirmClearHistoryBtn").click();
    check("history-cleared-start", await waitUntil(() => txt("historyCount") === "(0 / 500)"));
    await setInput("betweenStart", "2024-01-01", updateBetweenLive);
    await setInput("betweenEnd", "2024-12-31", updateBetweenLive);
    await calculateAndRecord("between");
    check("history-count-1", txt("historyCount") === "(1 / 500)");
    await setAddMode("subtract", false);
    setField("addStart", "2024-03-31");
    setField("addMonths", "1");
    await calculateAndRecord("add");
    check("history-count-2", txt("historyCount") === "(2 / 500)");
    const firstTimeText = document.querySelector(".history-time")?.textContent || "";
    check("history-timestamp-datetime", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(firstTimeText));
    check(
      "history-entry-rendered",
      txt("historyList").includes("Add / Subtract") &&
        txt("historyList").includes("2024-02-29 (Thursday)")
    );
    await setAddMode("add", false);
    await resetCard("add");
    const historyFilterEl = $("historyFilter");
    historyFilterEl.value = "add";
    historyFilterEl.dispatchEvent(new Event("change"));
    check(
      "history-filter",
      txt("historyCount") === "(2 / 500)" &&
        document.querySelectorAll(".history-item").length === 1
    );
    document.querySelector(".history-restore-btn").click();
    check(
      "history-restore",
      await waitUntil(
        () =>
          $("addStart").value === "2024-03-31" &&
          $("addMonths").value === "1" &&
          $("addModeSubtractBtn").classList.contains("active") &&
          txt("addResult").includes("February 29, 2024") &&
          $("card-add").classList.contains("card-restored")
      )
    );
    historyFilterEl.value = "all";
    historyFilterEl.dispatchEvent(new Event("change"));
    check("history-filter-all", document.querySelectorAll(".history-item").length === 2);
    document.querySelector(".history-delete-btn").click();
    check("history-single-delete", await waitUntil(() => txt("historyCount") === "(1 / 500)"));
    $("clearHistoryBtn").click();
    $("confirmClearHistoryBtn").click();
    check("history-cleared", await waitUntil(() => txt("historyCount") === "(0 / 500)"));

    // Clear all
    await setInput("infoDate", "2026-11-16", updateInfoLive);
    await setInput("cdTarget", "2027-01-01", () => updateCountdownLive());
    await clearAllCalculators();
    check(
      "clear-all-inputs",
      ["betweenStart", "betweenEnd", "addStart", "addMonths", "bizStart", "bizEnd", "ageBirth", "ageAsOf", "infoDate", "cdTarget", "cdTime"].every(
        (id) => $(id).value === ""
      )
    );
    check(
      "clear-all-results",
      CARD_KEYS.every((key) => txt(CARD_META[key].result) === "=—") &&
        txt("cdClock") === "—" &&
        cdActive === false
    );
    check("clear-all-keeps-history", txt("historyCount") === "(0 / 500)");

    // About modal
    $("aboutBtn").focus();
    $("aboutBtn").click();
    check("about-modal-open", isModalOpen("aboutModal"));
    check(
      "about-modal-credits",
      txt("aboutModal").includes("CREDITS") &&
        txt("aboutModal").includes("Mohamed Sayed") &&
        txt("aboutModal").includes("Ahmed Emara") &&
        txt("aboutModal").includes("Claude (Anthropic)")
    );
    check("about-modal-web-url", txt("webAppUrlText") === WEB_APP_URL);
    $("copyWebUrlBtn").click();
    check("about-copy-web-url", await waitUntilCopied("copyWebUrlBtn"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(
      "about-modal-escape-and-focus",
      !isModalOpen("aboutModal") && document.activeElement?.id === "aboutBtn"
    );

    // Settings modal: open from a card, update toggle round trip, mocked check
    $("bizCalendarEditBtn").focus();
    $("bizCalendarEditBtn").click();
    check("settings-modal-open", isModalOpen("settingsModal"));
    const autoToggle = $("autoUpdateToggle");
    check("settings-default-auto-update", autoToggle.checked === true);
    autoToggle.checked = false;
    autoToggle.dispatchEvent(new Event("change"));
    await settled();
    const afterOff = await invoke("get_settings");
    check("settings-toggle-persisted-in-memory", afterOff.checkUpdatesOnStartup === false);
    autoToggle.checked = true;
    autoToggle.dispatchEvent(new Event("change"));
    await settled();
    const roundTrip = await invoke("get_settings");
    check(
      "settings-round-trip",
      roundTrip.checkUpdatesOnStartup === true &&
        JSON.stringify(roundTrip) === JSON.stringify(savedSettings)
    );
    $("checkUpdatesNowBtn").click();
    check(
      "settings-manual-update-check",
      await waitUntil(() => txt("updateStatusText").includes("Up to date"))
    );
    $("openReleasePageBtn").click();
    $("settingsModal").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    check(
      "settings-backdrop-close-and-focus",
      !isModalOpen("settingsModal") && document.activeElement?.id === "bizCalendarEditBtn"
    );

    check("no-markup-from-data", document.querySelector("b") === null);

    await invoke("copy_text", { text: "date-tool-smoke-test" });
  } catch (err) {
    failures.push(`exception: ${err}`);
  }

  await invoke("report_smoke_result", {
    passed: failures.length === 0,
    details: failures.join(", ")
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function initialize() {
  CARD_KEYS.forEach((key) => {
    traceHints[key] = $(CARD_META[key].trace)?.textContent.trim() || "—";
  });
  bindControls();
  bindSettingsControls();
  bindCards();
  syncAddBusinessUi();

  let smokeEnabled = false;
  try {
    smokeEnabled = await invoke("is_smoke_test");
  } catch {
    smokeEnabled = false;
  }
  if (smokeEnabled === true) {
    // Fixed inputs only, never the real date.
    fixedClock = { y: 2026, m: 11, d: 16, hh: 10, mi: 0, ss: 0, offset: 120 };
  }

  lastToday = todayIso();
  holidayYear = Math.max(
    HOLIDAY_MIN_YEAR,
    Math.min(HOLIDAY_MAX_YEAR, Number(lastToday.slice(0, 4)) || 2026)
  );

  await loadSettingsAndMaybeCheckUpdates(smokeEnabled === true);
  await refreshCalendarInfo();

  await Promise.all([
    updateBetweenLive(),
    updateAddLive(),
    updateBusinessLive(),
    updateAgeLive(),
    updateInfoLive(),
    updateCountdownLive(),
    syncAppInfo(),
    loadHistory(),
    refreshHolidayPreview()
  ]);

  window.setInterval(checkDayRollover, ROLLOVER_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearCountdownTimer();
      return;
    }
    checkDayRollover();
    if (cdActive) updateCountdownLive({ fromTick: true });
  });

  $("betweenStart").focus();
  await runSmokeTestIfRequested(smokeEnabled === true);
}

initialize();
