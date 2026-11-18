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
// Shared UI text (v1.1.0). mobile/index.html carries a byte-identical copy of
// this table (cross-surface-text): change both together.
// ---------------------------------------------------------------------------

const UI_TEXT = Object.freeze({
  calSuffixStart: ", start",
  calSuffixEnd: ", end",
  calSuffixSelected: ", selected",
  calHintStart: "Next click sets the start date.",
  calHintEnd: "Next click sets the end date.",
  cdIdle: "Pick a target date to start the countdown.",
  cdCounting: (when) => `Counting down to ${when}.`,
  cdRestored: (left, when) => `Countdown restored: ${left} left until ${when}.`,
  cdFinished: (when) => `Finished: ${when} has passed. Counting the time since.`,
  cdFinishedClosed: (when) =>
    `Finished while the app was closed: ${when}. Counting the time since.`,
  cdStopped: (message) => `Countdown stopped: ${message}`,
  cdPhaseCounting: "counting down",
  cdPhaseRestored: "restored",
  cdPhaseFinished: "finished",
  cdPhaseFinishedClosed: "finished while closed",
  cdSavedNote: "Saved on this device. It resumes when you reopen the app.",
  cdForget: "Forget",
  cdNewerNote: "Saved countdown is from a newer version.",
  cdUnreadableNote: "The saved countdown could not be read, so it is left untouched.",
  cdWriteFailedNote: "The countdown could not be saved on this device.",
  cdSessionNote: "Kept for this session only. This browser is not saving site data.",
  historyReadOnly: "History could not be read safely. Nothing will be overwritten.",
  historyReasonReadError:
    "The history file could not be read. Another program may be using it.",
  historyReasonTooLarge: "The history file is larger than the size limit.",
  historyReasonCorrupt: "The history file is damaged or has entries that cannot be read.",
  historyReasonNewer: "The history file is from a newer version of the app.",
  historyResetFailed: "A new history could not be started. Try again."
});

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
  biz: { prefix: "bizCal", year: 0, month: 0, rangeStart: null, rangeEnd: null, seq: 0, last: null, focusDate: "" },
  info: { prefix: "infoCal", year: 0, month: 0, rangeStart: null, rangeEnd: null, seq: 0, last: null, focusDate: "" },
  cd: { prefix: "cdCal", year: 0, month: 0, rangeStart: null, rangeEnd: null, seq: 0, last: null, focusDate: "" }
};

// A calendar click moves the Business Days view to the clicked month. It is
// set only by a click and consumed once by updateBusinessLive; typed input
// keeps the v1.0.0 anchoring (the earlier date).
const calAnchorOverride = { biz: null };

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

// The header "today" button changes the view only; it never selects.
function showCalendarToday(key) {
  const view = calViews[key];
  const t = parseIso(todayIso());
  if (!t) return Promise.resolve(null);
  view.year = t.y;
  view.month = t.m;
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

// Selection marks come from the field values, never from the engine range
// flags: the engine range is [earlier, later) and its end can be the day
// before the later date (FROZEN §5).
function calMarks(key) {
  if (key === "biz") return { start: readDate("bizStart"), end: readDate("bizEnd"), selected: "" };
  if (key === "info") return { start: "", end: "", selected: readDate("infoDate") };
  return { start: "", end: "", selected: readDate("cdTarget") };
}

function miniCalCell(cell, marks) {
  const el = document.createElement("button");
  el.type = "button";
  const date = str(cell.date);
  const classes = ["mini-cal-cell"];
  if (!cell.inMonth) classes.push("out");
  if (cell.outOfRange) classes.push("out-of-range");
  if (cell.weekend) classes.push("weekend");
  if (cell.holiday) {
    classes.push("holiday");
    if (cell.approximate) classes.push("approx");
  }
  if (cell.inRange) classes.push("in-range");
  let suffix = "";
  if (date && date === marks.start) {
    classes.push("pick-start");
    suffix += UI_TEXT.calSuffixStart;
  }
  if (date && date === marks.end) {
    classes.push("pick-end");
    suffix += UI_TEXT.calSuffixEnd;
  }
  if (date && date === marks.selected) {
    classes.push("selected");
    suffix += UI_TEXT.calSuffixSelected;
  }
  if (suffix) classes.push("endpoint");
  if (cell.isToday) classes.push("today");
  el.className = classes.join(" ");
  el.textContent = typeof cell.day === "number" ? String(cell.day) : "";
  const label = str(cell.label) || date;
  el.setAttribute("aria-label", `${label}${suffix}`);
  if (suffix) el.setAttribute("aria-pressed", "true");
  if (cell.isToday) el.setAttribute("aria-current", "date");
  if (label) el.title = label;
  el.dataset.date = date;
  el.setAttribute("tabindex", "-1");
  if (cell.outOfRange) el.disabled = true;
  return el;
}

// Exactly one tab stop per grid: the focused date if it is shown, else the
// last focused date, a selected date or endpoint, today, or the 1st.
function rovingDate(view, cells, marks, keep) {
  const shown = (iso, inMonthOnly) =>
    Boolean(iso) &&
    cells.some((c) => c.date === iso && !c.outOfRange && (!inMonthOnly || c.inMonth));
  if (shown(keep, false)) return keep;
  for (const iso of [view.focusDate, marks.start, marks.end, marks.selected]) {
    if (shown(iso, true)) return iso;
  }
  const today = cells.find((c) => c.isToday && c.inMonth && !c.outOfRange);
  if (today) return str(today.date);
  const first = cells.find((c) => c.inMonth && !c.outOfRange);
  return first ? str(first.date) : "";
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
  // Focus survives the repaint: a keyboard move names the new date in
  // view.focusDate; otherwise the focused cell's own date is kept.
  const active = document.activeElement;
  const hadFocus = Boolean(active && active !== body && body.contains(active));
  const keep = hadFocus ? view.focusDate || str(active.dataset?.date) : "";
  const cells = grid.cells.filter((c) => c && typeof c === "object");
  const marks = calMarks(key);
  const nodes = cells.map((c) => miniCalCell(c, marks));
  const stop = rovingDate(view, cells, marks, keep);
  const stopNode = nodes.find((n) => n.dataset.date === stop) || null;
  if (stopNode) stopNode.setAttribute("tabindex", "0");
  body.replaceChildren(...nodes);
  if (hadFocus && stopNode) stopNode.focus({ preventScroll: true });
}

function setRovingStop(body, node) {
  Array.from(body.children).forEach((n) => {
    n.setAttribute("tabindex", n === node ? "0" : "-1");
  });
}

// ± days or months through the engine (month ends clamp), or null at the
// ends of the 0001-01-01..9999-12-31 range.
async function engineShiftDate(iso, { days = 0, months = 0 } = {}) {
  if (!isIsoDate(iso) || (days === 0 && months === 0)) return null;
  try {
    const r = okResult(
      await engine("calc_add_subtract", {
        date: iso,
        operation: days < 0 || months < 0 ? "subtract" : "add",
        years: "",
        months: months ? String(Math.abs(months)) : "",
        weeks: "",
        days: days ? String(Math.abs(days)) : "",
        businessDays: false,
        calendar: currentCalendar()
      })
    );
    return r && isIsoDate(r.resultDate) ? r.resultDate : null;
  } catch {
    return null;
  }
}

// Moving focus never selects. Leaving the shown month moves the view; the
// ends of the range and disabled cells stop the move.
async function moveMiniCalFocus(key, cell, step) {
  const view = calViews[key];
  const body = $(`${view.prefix}Grid`);
  if (!body) return;
  const nodes = Array.from(body.children);
  const from = str(cell.dataset.date);
  let target = "";
  if (!step.months) {
    const j = nodes.indexOf(cell) + step.days;
    if (j >= 0 && j < nodes.length) target = str(nodes[j].dataset.date);
  }
  if (!target) target = (await engineShiftDate(from, step)) || "";
  const t = parseIso(target);
  if (!t) return;
  const node = Array.from(body.children).find((n) => n.dataset.date === target) || null;
  if (node && node.disabled) return;
  view.focusDate = target;
  if (node && t.y === view.year && t.m === view.month) {
    setRovingStop(body, node);
    node.focus();
    return;
  }
  view.year = t.y;
  view.month = t.m;
  await refreshMiniCal(key);
}

function onMiniCalKeydown(key, event) {
  const cell =
    event.target && typeof event.target.closest === "function"
      ? event.target.closest(".mini-cal-cell")
      : null;
  if (!cell || event.altKey || event.ctrlKey || event.metaKey) return;
  const k = event.key;
  if (k === "Enter" || k === " " || k === "Spacebar") {
    // Handled here (not by the native click) so Shift+Enter reaches the pick.
    event.preventDefault();
    if (!cell.disabled) onMiniCalPick(key, str(cell.dataset.date), { shift: event.shiftKey });
    return;
  }
  const body = $(`${calViews[key].prefix}Grid`);
  const col = body ? Array.from(body.children).indexOf(cell) % 7 : 0;
  const year = event.shiftKey ? 12 : 1;
  const steps = {
    ArrowLeft: { days: -1 },
    ArrowRight: { days: 1 },
    ArrowUp: { days: -7 },
    ArrowDown: { days: 7 },
    Home: { days: -col },
    End: { days: 6 - col },
    PageUp: { months: -year },
    PageDown: { months: year }
  };
  if (!Object.hasOwn(steps, k)) return;
  event.preventDefault();
  const step = { days: 0, months: 0, ...steps[k] };
  if (step.days === 0 && step.months === 0) return;
  moveMiniCalFocus(key, cell, step);
}

// ---------------------------------------------------------------------------
// Calendar picks (A1). A pick fills a field and recomputes that card; it
// never writes history (only calculate, Enter and copy do).
// ---------------------------------------------------------------------------

let bizPickTarget = "start";

function setBizPickTarget(target) {
  bizPickTarget = target === "end" ? "end" : "start";
  const start = $("bizPickStart");
  const end = $("bizPickEnd");
  if (start) start.checked = bizPickTarget === "start";
  if (end) end.checked = bizPickTarget === "end";
  const hint = $("bizCalHint");
  const text = bizPickTarget === "end" ? UI_TEXT.calHintEnd : UI_TEXT.calHintStart;
  if (hint && hint.textContent !== text) hint.textContent = text;
}

// Start if the start date is empty, else End if the end date is empty, else Start.
function resetBizPickTarget() {
  setBizPickTarget(readDate("bizStart") && !readDate("bizEnd") ? "end" : "start");
}

async function onMiniCalPick(key, iso, { shift = false } = {}) {
  if (!isIsoDate(iso) || !Object.hasOwn(calViews, key)) return;
  calViews[key].focusDate = iso;
  if (key === "info") {
    setField("infoDate", iso);
    await updateInfoLive();
    return;
  }
  if (key === "cd") {
    // The target time is kept; a past day shows the finished state.
    setField("cdTarget", iso);
    persistCountdown();
    await updateCountdownLive();
    return;
  }
  const target = shift ? "end" : bizPickTarget;
  setField(target === "end" ? "bizEnd" : "bizStart", iso);
  setBizPickTarget(target === "end" ? "start" : "end");
  calAnchorOverride.biz = iso;
  await updateBusinessLive();
}

function bindMiniCalendars() {
  Object.keys(calViews).forEach((key) => {
    const p = calViews[key].prefix;
    $(`${p}PrevBtn`)?.addEventListener("click", () => shiftCalendar(key, -1));
    $(`${p}NextBtn`)?.addEventListener("click", () => shiftCalendar(key, 1));
    $(`${p}TodayBtn`)?.addEventListener("click", () => showCalendarToday(key));
    const body = $(`${p}Grid`);
    if (!body) return;
    body.addEventListener("click", (event) => {
      const cell =
        event.target && typeof event.target.closest === "function"
          ? event.target.closest(".mini-cal-cell")
          : null;
      if (!cell || cell.disabled || !body.contains(cell)) return;
      onMiniCalPick(key, str(cell.dataset.date), { shift: Boolean(event.shiftKey) });
    });
    body.addEventListener("keydown", (event) => onMiniCalKeydown(key, event));
    body.addEventListener("focusin", (event) => {
      const cell =
        event.target && typeof event.target.closest === "function"
          ? event.target.closest(".mini-cal-cell")
          : null;
      if (!cell || !body.contains(cell)) return;
      calViews[key].focusDate = str(cell.dataset.date);
      setRovingStop(body, cell);
    });
  });

  ["bizPickStart", "bizPickEnd"].forEach((id) => {
    $(id)?.addEventListener("change", (event) => {
      const radio = event.currentTarget;
      setBizPickTarget(radio.checked ? radio.value : bizPickTarget);
    });
  });
  $("bizStart")?.addEventListener("focus", () => setBizPickTarget("start"));
  $("bizEnd")?.addEventListener("focus", () => setBizPickTarget("end"));
  // A date committed by typing moves the calendar on to the other, still-empty end,
  // so the next tap fills it instead of overwriting the date just typed.
  $("bizStart")?.addEventListener("change", () => {
    if (readDate("bizStart") && !readDate("bizEnd")) setBizPickTarget("end");
  });
  $("bizEnd")?.addEventListener("change", () => {
    if (readDate("bizEnd") && !readDate("bizStart")) setBizPickTarget("start");
  });
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
  // Consumed once: only the update a calendar click started follows it.
  const clickedAnchor = calAnchorOverride.biz;
  calAnchorOverride.biz = null;

  if (!startDate || !endDate) {
    cardIdle("business");
    renderHolidayHits(null);
    const single = startDate || endDate || null;
    await setCalendarView("biz", {
      anchor: clickedAnchor || single,
      rangeStart: single,
      rangeEnd: single
    });
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

    // FROZEN §5: the count covers [earlier, later), so without "include the
    // later date" the highlight stops the day before the later date. The
    // engine does that date step; the UI does no date arithmetic.
    const earlier = startDate <= endDate ? startDate : endDate;
    const later = startDate <= endDate ? endDate : startDate;
    let rangeEnd = later;
    if (!includeEndDay && earlier !== later) {
      const prev = okResult(
        await engine("calc_add_subtract", {
          date: later,
          operation: "subtract",
          years: "",
          months: "",
          weeks: "",
          days: "1",
          businessDays: false,
          calendar: currentCalendar()
        })
      );
      if (ticket !== seq.business) return;
      rangeEnd = prev && isIsoDate(prev.resultDate) ? prev.resultDate : later;
    }
    await setCalendarView("biz", {
      anchor: clickedAnchor || earlier,
      rangeStart: earlier,
      rangeEnd
    });
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
      [
        "Leap year",
        `${r.isLeapYear ? "yes" : "no"} (${Number.isInteger(r.year) ? pad(r.year, 4) : "—"})`
      ],
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

// ---------------------------------------------------------------------------
// Countdown persistence (A2): countdown.json through countdown_load / _save /
// _clear. Saved on commit only (change, pills, today, calendar click, history
// restore, and a flush when the page is hidden), never on input or a tick.
// An empty or invalid field never clears the record; only Forget and Clear do.
// ---------------------------------------------------------------------------

const CD_SCHEMA_VERSION = 1;
const CD_STATE_KEYS = ["schemaVersion", "targetDate", "targetTime", "savedAtMs", "finishedSeenAtMs"];
const CD_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

let cdStored = null; // the record known to be saved, or null
let cdLoadStatus = "empty"; // countdown_load status: ok|empty|newer|corrupt|unreadable
let cdStoreBlocked = false; // newer or unreadable record: never write over it
let cdForgottenPair = ""; // the pair Forget removed; a page-hide flush skips it
let cdRestoredPair = ""; // the pair restored at launch ("date|time")
let cdRestorePending = false; // the first render after a restore is still due
let cdClosedFinish = false; // that render found it finished, never seen
let cdWriteFailed = false; // the last countdown save or clear failed
let cdWriteChain = Promise.resolve();

function cdPair(date, time) {
  return `${date}|${time}`;
}

function isSafeMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCountdownState(s) {
  return (
    Boolean(s) &&
    typeof s === "object" &&
    !Array.isArray(s) &&
    Object.keys(s).length === CD_STATE_KEYS.length &&
    CD_STATE_KEYS.every((k) => Object.hasOwn(s, k)) &&
    s.schemaVersion === CD_SCHEMA_VERSION &&
    isIsoDate(s.targetDate) &&
    parseIso(s.targetDate) !== null &&
    typeof s.targetTime === "string" &&
    (s.targetTime === "" || CD_TIME_RE.test(s.targetTime)) &&
    isSafeMs(s.savedAtMs) &&
    (s.finishedSeenAtMs === null || isSafeMs(s.finishedSeenAtMs))
  );
}

// A field mid-edit (one segment cleared) reads "" with validity.badInput.
function countdownFieldsPair() {
  const dateEl = $("cdTarget");
  const timeEl = $("cdTime");
  if (dateEl?.validity?.badInput || timeEl?.validity?.badInput) return null;
  const targetDate = readDate("cdTarget");
  const targetTime = readDate("cdTime");
  if (!isIsoDate(targetDate) || parseIso(targetDate) === null) return null;
  if (targetTime !== "" && !CD_TIME_RE.test(targetTime)) return null;
  return { targetDate, targetTime };
}

// Writes run one at a time, in order, so the last commit wins. The returned
// promise settles with this write's own outcome; the chain never rejects.
function queueCountdownWrite(run) {
  const result = cdWriteChain.then(run, run);
  cdWriteChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// A refusal from the store itself (a newer-version or unreadable record
// appeared after launch) blocks further writes; any other failure says the
// countdown is not saved, so the note never claims it is.
function onCountdownWriteFailed(err) {
  const reason = String(err ?? "");
  if (reason.includes("countdown_newer_schema")) {
    cdStored = null;
    cdLoadStatus = "newer";
    cdStoreBlocked = true;
  } else if (reason.includes("countdown_unreadable")) {
    cdStored = null;
    cdLoadStatus = "unreadable";
    cdStoreBlocked = true;
  }
  cdWriteFailed = !cdStoreBlocked;
  renderCountdownNote();
}

// The desktop always saves to a file; only the mobile/web build can fall
// back to a session-only store.
function countdownSessionOnly() {
  return false;
}

function renderCountdownNote() {
  const note = $("cdSavedNote");
  const text = $("cdSavedNoteText");
  const forget = $("cdForgetBtn");
  if (!note || !text || !forget) return;
  let message = "";
  let canForget = false;
  if (cdLoadStatus === "newer") {
    message = UI_TEXT.cdNewerNote;
  } else if (cdLoadStatus === "unreadable") {
    message = UI_TEXT.cdUnreadableNote;
  } else if (cdWriteFailed) {
    // Forget stays available: it retries removing whatever is stored.
    message = UI_TEXT.cdWriteFailedNote;
    canForget = true;
  } else if (cdStored) {
    message = countdownSessionOnly() ? UI_TEXT.cdSessionNote : UI_TEXT.cdSavedNote;
    canForget = true;
  }
  // Never an input: focusing one inside a tap opens the phone's picker.
  if (!canForget && document.activeElement === forget) $("calcCdBtn")?.focus();
  if (text.textContent !== message) text.textContent = message;
  forget.classList.toggle("hidden", !canForget);
  note.classList.toggle("hidden", message === "");
}

// `explicit` is a user commit; the page-hide flush passes false so it never
// re-saves a countdown the user just told the app to forget.
function persistCountdown({ explicit = true } = {}) {
  if (cdStoreBlocked) return cdWriteChain;
  const pair = countdownFieldsPair();
  if (!pair) return cdWriteChain;
  const key = cdPair(pair.targetDate, pair.targetTime);
  if (explicit) cdForgottenPair = "";
  else if (key === cdForgottenPair) return cdWriteChain;
  if (cdStored && cdPair(cdStored.targetDate, cdStored.targetTime) === key) return cdWriteChain;
  const state = {
    schemaVersion: CD_SCHEMA_VERSION,
    targetDate: pair.targetDate,
    targetTime: pair.targetTime,
    savedAtMs: Date.now(),
    finishedSeenAtMs: null
  };
  // Set now so a repeat commit of the same pair is not queued twice; the
  // saved note waits for the write, and a failed write rolls this back so
  // the next commit retries.
  const previous = { stored: cdStored, status: cdLoadStatus };
  cdStored = state;
  cdLoadStatus = "ok";
  if (cdRestoredPair !== key) {
    cdRestoredPair = "";
    cdRestorePending = false;
    cdClosedFinish = false;
  }
  return queueCountdownWrite(() => invoke("countdown_save", { state: { ...state } })).then(
    () => {
      if (cdStored !== state) return;
      cdWriteFailed = false;
      renderCountdownNote();
    },
    (err) => {
      if (cdStored === state) {
        cdStored = previous.stored;
        cdLoadStatus = previous.status;
      }
      onCountdownWriteFailed(err);
    }
  );
}

// Always asks the store to clear (it is idempotent), so a record another
// window saved meanwhile is removed too.
function forgetCountdown() {
  if (cdStoreBlocked) return cdWriteChain;
  const pair = countdownFieldsPair();
  cdForgottenPair = pair ? cdPair(pair.targetDate, pair.targetTime) : "";
  cdStored = null;
  cdLoadStatus = "empty";
  cdWriteFailed = false;
  cdRestoredPair = "";
  cdRestorePending = false;
  cdClosedFinish = false;
  renderCountdownNote();
  return queueCountdownWrite(() => invoke("countdown_clear")).then(
    () => undefined,
    (err) => {
      if (cdStored === null) onCountdownWriteFailed(err);
    }
  );
}

// The one tick-time write: the first visible render of a finished target
// records when it was seen, at most once per target.
function markCountdownSeen(targetDate, targetTime) {
  if (cdStoreBlocked || !cdStored || cdStored.finishedSeenAtMs !== null) return;
  if (document.visibilityState !== "visible") return;
  if (cdPair(cdStored.targetDate, cdStored.targetTime) !== cdPair(targetDate, targetTime)) return;
  const state = { ...cdStored, finishedSeenAtMs: Date.now() };
  cdStored = state;
  // Not rolled back on failure: a retry on every tick would write per tick.
  queueCountdownWrite(() => invoke("countdown_save", { state: { ...state } })).catch((err) => {
    if (cdStored === state) onCountdownWriteFailed(err);
  });
}

// Launch restore: before the first render, and only into an empty card.
async function restoreSavedCountdown() {
  let load = null;
  try {
    load = await invoke("countdown_load");
  } catch {
    load = null;
  }
  const status = load && typeof load.status === "string" ? load.status : "";
  cdRestoredPair = "";
  cdRestorePending = false;
  cdClosedFinish = false;
  cdStored = null;
  cdWriteFailed = false;
  if (status === "newer" || status === "unreadable") {
    cdLoadStatus = status;
    cdStoreBlocked = true;
  } else if (!status) {
    // No store on this backend: run without persistence, write nothing.
    cdLoadStatus = "empty";
    cdStoreBlocked = true;
  } else {
    cdStoreBlocked = false;
    cdLoadStatus = status === "ok" || status === "corrupt" ? status : "empty";
    if (status === "ok" && isCountdownState(load.state)) {
      cdStored = { ...load.state };
      if (readDate("cdTarget") === "") {
        setField("cdTarget", cdStored.targetDate);
        setField("cdTime", cdStored.targetTime);
        cdRestoredPair = cdPair(cdStored.targetDate, cdStored.targetTime);
        cdRestorePending = true;
      }
    } else if (status === "ok") {
      cdLoadStatus = "empty";
    }
  }
  renderCountdownNote();
}

function setCountdownPhase(phase) {
  const chip = $("cdPhase");
  if (!chip) return;
  const labels = {
    counting: UI_TEXT.cdPhaseCounting,
    restored: UI_TEXT.cdPhaseRestored,
    finished: UI_TEXT.cdPhaseFinished,
    finishedClosed: UI_TEXT.cdPhaseFinishedClosed
  };
  const text = Object.hasOwn(labels, phase) ? labels[phase] : "";
  if (chip.textContent !== text) chip.textContent = text;
  chip.classList.toggle("hidden", text === "");
  chip.classList.toggle("is-finished", phase === "finished" || phase === "finishedClosed");
}

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

// Set by every non-tick update and cleared only once a full render (result
// box + mini calendar) has finished, so a tick that supersedes an edit
// still renders the new target in full.
let cdFullRenderPending = false;

// "business days left" (BUILD_PLAN §6.6): calc_countdown has no calendar,
// so the count comes from calc_business_days over [today, target) with the
// saved calendar. Recomputed on input, settings and day changes, never per tick.
async function countdownBusinessLine(today, targetDate) {
  try {
    const b = okResult(
      await engine("calc_business_days", {
        startDate: today,
        endDate: targetDate,
        includeEndDay: false,
        calendar: currentCalendar()
      })
    );
    if (!b || typeof b.businessDays !== "number") return "";
    const label = b.direction === "backward" ? "business days since" : "business days left";
    return `${label}: ${groupInt(b.businessDays)} (${calendarShortText()}${
      b.usedApproximateHolidays === true ? " · estimated holidays" : ""
    })`;
  } catch {
    return "";
  }
}

async function updateCountdownLive({ fromTick = false } = {}) {
  const ticket = ++seq.countdown;
  if (!fromTick) {
    // Like the other cards: no stale timer or copy target during an edit.
    clearCountdownTimer();
    lastValidCalc.countdown = null;
    cdFullRenderPending = true;
  }
  const full = cdFullRenderPending;
  const targetDate = readDate("cdTarget");
  const targetTime = readDate("cdTime");

  if (!targetDate) {
    stopCountdown();
    lastValidCalc.countdown = null;
    cardIdle("countdown");
    setClockIdle();
    setCountdownPhase("");
    setCountdownStatus("idle", UI_TEXT.cdIdle);
    if (full) {
      await setCalendarView("cd", { anchor: null });
      if (ticket === seq.countdown) cdFullRenderPending = false;
    }
    return;
  }

  const now = nowMoment();
  const target = {
    date: targetDate,
    time: targetTime,
    utcOffsetMinutes: offsetAt(targetDate, targetTime)
  };

  try {
    const [res, businessLine] = await Promise.all([
      engine("calc_countdown", { now, target }),
      full ? countdownBusinessLine(now.date, targetDate) : Promise.resolve("")
    ]);
    if (ticket !== seq.countdown) return;
    const r = okResult(res);
    if (!r) {
      stopCountdown();
      lastValidCalc.countdown = null;
      const message = errorMessage(res);
      cardError("countdown", message);
      setClockIdle();
      setCountdownPhase("");
      setCountdownStatus(`error|${message}`, UI_TEXT.cdStopped(message));
      if (full) {
        await setCalendarView("cd", { anchor: targetDate });
        if (ticket === seq.countdown) cdFullRenderPending = false;
      }
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
    // No engine change: `past|now` is the finished signal. The first render
    // after a launch restore decides "finished while closed" from
    // finishedSeenAtMs (null = never seen finished on a visible screen).
    const finished = r.status === "past" || r.status === "now";
    // "restored" is the first render only; the next tick says counting down
    // (one status rewrite, not a stale time left repeated every second).
    const restoredNow = cdRestoredPair !== "" && cdRestoredPair === cdPair(targetDate, targetTime);
    const restoreRender = restoredNow && cdRestorePending;
    if (restoreRender) {
      cdRestorePending = false;
      cdClosedFinish = finished && Boolean(cdStored) && cdStored.finishedSeenAtMs === null;
    }
    let phase = "counting";
    if (finished) phase = restoredNow && cdClosedFinish ? "finishedClosed" : "finished";
    else if (restoreRender) phase = "restored";
    if (finished) markCountdownSeen(targetDate, targetTime);
    setCountdownPhase(phase);
    const statusKey = `${targetDate}|${str(r.targetTime)}|${phase}`;
    if (phase === "finishedClosed") {
      setCountdownStatus(statusKey, UI_TEXT.cdFinishedClosed(when));
    } else if (phase === "finished") {
      setCountdownStatus(statusKey, UI_TEXT.cdFinished(when));
    } else if (phase === "restored") {
      setCountdownStatus(statusKey, UI_TEXT.cdRestored(str(r.text), when));
    } else {
      setCountdownStatus(statusKey, UI_TEXT.cdCounting(when));
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
    // calculate, never on a plain tick; the clock itself is not live.
    if (full) {
      renderResult("cdResult", str(r.summaryText), [
        businessLine,
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
      cdFullRenderPending = false;
    }

    cdActive = true;
    scheduleCountdownTick();
  } catch {
    if (ticket !== seq.countdown) return;
    stopCountdown();
    lastValidCalc.countdown = null;
    cardError("countdown", "Calculation failed.");
    setClockIdle();
    setCountdownPhase("");
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
  persistCountdown();
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
    updateCountdownLive()
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
      resetBizPickTarget();
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
      persistCountdown();
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
    deleteBtn.disabled = historyReadOnly;
    deleteBtn.addEventListener("click", () => {
      deleteHistoryEntry(entry.id);
    });

    actions.append(copyBtn, restoreBtn, deleteBtn);
    item.append(main, actions);
    listEl.appendChild(item);
  });
}

async function deleteHistoryEntry(id) {
  if (historyReadOnly) return;
  try {
    const updated = await invoke("history_delete", { id });
    renderHistory(updated);
  } catch (err) {
    // History delete errors should not interrupt calculator usage.
    await onHistoryWriteError(err);
  }
}

async function recordHistoryFor(key) {
  if (historyReadOnly) return;
  const entry = buildValidHistoryCandidate(lastValidCalc[key]);
  if (!entry) return;
  try {
    const updated = await invoke("history_add", { entry });
    renderHistory(updated);
  } catch (err) {
    // History write errors should not interrupt calculator usage.
    await onHistoryWriteError(err);
  }
}

async function loadHistory() {
  await refreshHistoryState();
  try {
    const entries = await invoke("history_list");
    renderHistory(entries);
  } catch {
    renderHistory([]);
  }
}

// ---------------------------------------------------------------------------
// History read-only mode (A3): a history file that could not be read safely
// is never overwritten. Add, delete and clear are refused until Retry reads
// it or the user explicitly starts a new history.
// ---------------------------------------------------------------------------

let historyReadOnly = false;
let historyReadOnlyReason = null;

const HISTORY_REASON_TEXT = {
  read_error: UI_TEXT.historyReasonReadError,
  too_large: UI_TEXT.historyReasonTooLarge,
  corrupt: UI_TEXT.historyReasonCorrupt,
  newer_schema: UI_TEXT.historyReasonNewer
};

function hideHistoryResetConfirm() {
  $("historyResetConfirm")?.classList.add("hidden");
  $("historyResetBtn")?.classList.remove("hidden");
}

function hideClearHistoryConfirm() {
  $("clearHistoryConfirm")?.classList.add("hidden");
  $("clearHistoryBtn")?.classList.remove("hidden");
}

function applyHistoryState(st, detailOverride = "") {
  const wasReadOnly = historyReadOnly;
  historyReadOnly = Boolean(st && typeof st === "object" && st.readOnly === true);
  const reason = historyReadOnly && st && typeof st.reason === "string" ? st.reason : null;
  historyReadOnlyReason = reason && Object.hasOwn(HISTORY_REASON_TEXT, reason) ? reason : null;
  const banner = $("historyReadOnlyBanner");
  const detail = $("historyReadOnlyDetail");
  const text =
    detailOverride || (historyReadOnlyReason ? HISTORY_REASON_TEXT[historyReadOnlyReason] : "");
  // The banner is shown before its live message changes, so the change is
  // announced; the buttons sit outside the live region.
  banner?.classList.toggle("hidden", !historyReadOnly);
  if (detail && detail.textContent !== text) detail.textContent = text;
  const clearBtn = $("clearHistoryBtn");
  if (clearBtn) clearBtn.disabled = historyReadOnly;
  if (historyReadOnly) {
    hideClearHistoryConfirm();
  } else {
    hideHistoryResetConfirm();
    const active = document.activeElement;
    if (wasReadOnly && banner && active && banner.contains(active)) clearBtn?.focus();
  }
  document.querySelectorAll(".history-delete-btn").forEach((btn) => {
    btn.disabled = historyReadOnly;
  });
}

// An older backend without history_state is treated as writable (v1.0.0).
async function refreshHistoryState() {
  try {
    applyHistoryState(await invoke("history_state"));
  } catch {
    applyHistoryState(null);
  }
}

async function onHistoryWriteError(err) {
  if (String(err ?? "").includes("history_read_only")) {
    await refreshHistoryState();
    await loadHistoryEntriesOnly();
  }
}

async function loadHistoryEntriesOnly() {
  try {
    renderHistory(await invoke("history_list"));
  } catch {
    renderHistory([]);
  }
}

async function retryHistory() {
  try {
    applyHistoryState(await invoke("history_retry"));
  } catch {
    await refreshHistoryState();
  }
  await loadHistoryEntriesOnly();
}

async function resetHistoryFile() {
  let failed = false;
  try {
    await invoke("history_reset");
  } catch {
    failed = true;
  }
  hideHistoryResetConfirm();
  try {
    const st = await invoke("history_state");
    applyHistoryState(st, failed && st && st.readOnly === true ? UI_TEXT.historyResetFailed : "");
  } catch {
    applyHistoryState(null);
  }
  await loadHistoryEntriesOnly();
  if (!historyReadOnly) $("clearHistoryBtn")?.focus();
  else $("historyResetBtn")?.focus();
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

// `forget` is the countdown card's own Clear; clear all passes false, so a
// mis-tap in the header row only empties fields and never deletes the saved
// countdown (Forget and the card's Clear stay the explicit actions).
function resetCard(key, { forget = true } = {}) {
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
      resetBizPickTarget();
      break;
    case "age":
      clearFields(["ageBirth", "ageAsOf"]);
      break;
    case "info":
      clearFields(["infoDate"]);
      break;
    case "countdown":
      stopCountdown();
      // The card's Clear is an explicit action: it also forgets the saved
      // countdown.
      if (forget) forgetCountdown();
      clearFields(["cdTarget", "cdTime"]);
      break;
    default:
      return Promise.resolve();
  }
  setResultIdle(CARD_META[key].result);
  return UPDATERS[key]();
}

function clearAllCalculators() {
  const done = Promise.all(CARD_KEYS.map((key) => resetCard(key, { forget: false })));
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
    updateCountdownLive(),
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

// Owner decision (FROZEN): choosing Egypt switches the weekend to Fri/Sat
// (the user may change it back). Leaving Egypt does not touch the weekend:
// the rule covers selecting Egypt only, and a reverse switch could overwrite
// a weekend the user chose.
function onPresetChange(event) {
  const value = event.currentTarget.value;
  if (!Object.hasOwn(PRESET_LABELS, value)) return Promise.resolve(false);
  if (value === "eg") weekendUiCustom = false;
  return commitSettings((next) => {
    next.calendar.preset = value;
    if (value === "eg") next.calendar.weekend = WEEKEND_PRESETS.friSat.slice();
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
  box.dataset.focusKey = `${str(instance.id)}|${str(instance.date)}|check`;
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
    input.dataset.focusKey = `${str(instance.id)}|${str(instance.date)}|override`;
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
  // Rebuilding the rows destroys the focused control; keep keyboard focus on
  // the matching control of the new row (FROZEN §15).
  const active = document.activeElement;
  const focusKey =
    active && list.contains(active) && active.dataset ? active.dataset.focusKey || "" : "";
  if (instances.length === 0) {
    list.replaceChildren(holidayPreviewEmpty(`No ${calendarPresetText(cal)} holidays in ${holidayYear}.`));
  } else {
    list.replaceChildren(
      ...instances.map((inst, i) => renderHolidayRow(inst, i, excludedIds, overrides))
    );
  }
  if (focusKey) {
    const target = Array.from(list.querySelectorAll("[data-focus-key]")).find(
      (el) => el.dataset.focusKey === focusKey
    );
    if (target) target.focus();
    else $("holidayPresetSelect")?.focus();
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
    if (historyReadOnly) return;
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
    if (!historyReadOnly) {
      try {
        const entries = await invoke("history_clear");
        renderHistory(entries);
      } catch (err) {
        if (String(err ?? "").includes("history_read_only")) await onHistoryWriteError(err);
        else renderHistory([]);
      }
    }
    clearConfirmGroup.classList.add("hidden");
    clearHistoryBtn.classList.remove("hidden");
  });

  // History read-only banner: Retry, and a two-step "start a new history".
  $("historyRetryBtn")?.addEventListener("click", () => retryHistory());
  $("historyResetBtn")?.addEventListener("click", () => {
    if (!historyReadOnly) return;
    $("historyResetBtn").classList.add("hidden");
    $("historyResetConfirm")?.classList.remove("hidden");
    $("cancelHistoryResetBtn")?.focus();
  });
  $("cancelHistoryResetBtn")?.addEventListener("click", () => {
    hideHistoryResetConfirm();
    $("historyResetBtn")?.focus();
  });
  $("confirmHistoryResetBtn")?.addEventListener("click", () => resetHistoryFile());
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

  // Commit listeners first, so a render that follows sees the saved record.
  ["cdTarget", "cdTime"].forEach((id) => {
    $(id)?.addEventListener("change", () => persistCountdown());
  });
  live(["cdTarget", "cdTime"], () => updateCountdownLive());
  $("cdForgetBtn")?.addEventListener("click", () => forgetCountdown());
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
      if (target.id === "cdTarget") persistCountdown();
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  // Mini calendars: month navigation, "today" view, click and keyboard picks.
  bindMiniCalendars();

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
    check("app-version", appInfo.version === "1.1.0");
    check(
      "app-credits",
      appInfo.credits.includes("Mohamed Sayed") &&
        appInfo.credits.includes("Ahmed Emara") &&
        appInfo.credits.includes("Claude")
    );
    check("footer-version", txt("appVersion").includes("Desktop v1.1.0"));
    check(
      "countdown-store-empty-at-launch",
      $("cdTarget").value === "" && $("cdSavedNote").classList.contains("hidden")
    );

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
        $("bizCalGrid").querySelectorAll(".mini-cal-cell.in-range").length === 30 &&
        !$("bizCalGrid").querySelector('.mini-cal-cell.in-range[data-date="2024-01-31"]')
    );
    await setChecked("bizIncludeEnd", true, updateBusinessLive);
    check(
      "biz-mini-calendar-inclusive",
      $("bizCalGrid").querySelectorAll(".mini-cal-cell.in-range").length === 31 &&
        Boolean($("bizCalGrid").querySelector('.mini-cal-cell.in-range[data-date="2024-01-31"]'))
    );
    await setChecked("bizIncludeEnd", false, updateBusinessLive);
    check("biz-calendar-summary", txt("bizCalendarSummaryText") === "Sat/Sun · US federal");

    // Holiday preview year picker and exclusion round trip
    await shiftHolidayYear(-1);
    await shiftHolidayYear(-1);
    check(
      "holiday-preview-2024",
      txt("holidayYearValue") === "2024" &&
        txt("holidayPreviewList").includes("Birthday of Martin Luther King, Jr.")
    );
    // The modal is opened so that the row checkbox can take keyboard focus.
    openModal("settingsModal", "closeSettingsBtn", null);
    await refreshHolidayPreview();
    const mlkIndex = previewInstances.findIndex((h) => h.id === "mlkDay");
    const mlkBox = $(`holidayRow${mlkIndex}`);
    check("holiday-preview-row", mlkIndex >= 0 && Boolean(mlkBox) && mlkBox.checked);
    let mlkFocused = false;
    if (mlkBox) {
      mlkBox.focus();
      mlkFocused = document.activeElement === mlkBox;
      mlkBox.checked = false;
      mlkBox.dispatchEvent(new Event("change", { bubbles: true }));
      await settled();
    }
    check(
      "holiday-exclusion-saved",
      savedSettings.calendar.excludedHolidays.us.includes("mlkDay") &&
        txt("bizResult").startsWith("=21 business days")
    );
    check(
      "holiday-row-keeps-focus",
      mlkFocused &&
        document.activeElement !== mlkBox &&
        document.activeElement?.dataset?.focusKey === mlkBox?.dataset.focusKey &&
        document.activeElement?.checked === false
    );
    closeModal("settingsModal", "settingsBtn");
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
    await clickAndSettle("weekendFriSatBtn");
    await selectValue("holidayPresetSelect", "none");
    check(
      "leaving-egypt-keeps-weekend",
      savedSettings.calendar.preset === "none" &&
        sameDays(savedSettings.calendar.weekend, [5, 6])
    );
    await clickAndSettle("weekendSatSunBtn");
    check(
      "preset-none-saved",
      savedSettings.calendar.preset === "none" &&
        sameDays(savedSettings.calendar.weekend, [6, 7])
    );

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
        txt("infoResult").includes("Today") &&
        txt("infoResult").includes("no (2026)")
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

    // 5b. Clickable mini calendars (A1)
    const cellOf = (gridId, iso) =>
      Array.from($(gridId).children).find((c) => c.dataset.date === iso) || null;
    const tabStops = (gridId) =>
      Array.from($(gridId).children).filter((c) => c.getAttribute("tabindex") === "0");
    const keyOn = (el, key, shiftKey = false) =>
      el?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    check(
      "calendar-cells-are-buttons",
      ["bizCalGrid", "infoCalGrid", "cdCalGrid"].every(
        (id) =>
          $(id).children.length === 42 &&
          Array.from($(id).children).every((c) => c.tagName === "BUTTON" && c.type === "button")
      ) &&
        tabStops("infoCalGrid").length === 1 &&
        tabStops("infoCalGrid")[0].dataset.date === "2026-11-16" &&
        cellOf("infoCalGrid", "2026-11-16")?.getAttribute("aria-current") === "date"
    );
    cellOf("infoCalGrid", "2026-11-20")?.click();
    check(
      "calendar-click-info",
      await waitUntil(
        () =>
          $("infoDate").value === "2026-11-20" &&
          txt("infoResult").includes("November 20, 2026") &&
          Boolean(cellOf("infoCalGrid", "2026-11-20")?.classList.contains("selected")) &&
          cellOf("infoCalGrid", "2026-11-20")?.getAttribute("aria-pressed") === "true" &&
          (cellOf("infoCalGrid", "2026-11-20")?.getAttribute("aria-label") || "").endsWith(
            UI_TEXT.calSuffixSelected
          )
      )
    );
    check("calendar-click-no-history", allHistoryEntries.length === 2);
    cellOf("infoCalGrid", "2026-12-03")?.click();
    check(
      "calendar-out-cell-moves-view",
      await waitUntil(
        () => $("infoDate").value === "2026-12-03" && txt("infoCalTitle") === "December 2026"
      )
    );
    cellOf("infoCalGrid", "2026-12-03")?.focus();
    keyOn(cellOf("infoCalGrid", "2026-12-03"), "ArrowRight");
    check(
      "calendar-keyboard-arrow",
      await waitUntil(() => document.activeElement?.dataset?.date === "2026-12-04") &&
        $("infoDate").value === "2026-12-03" &&
        tabStops("infoCalGrid").length === 1
    );
    keyOn(document.activeElement, "PageDown");
    check(
      "calendar-keyboard-page-down",
      await waitUntil(
        () =>
          txt("infoCalTitle") === "January 2027" &&
          document.activeElement?.dataset?.date === "2027-01-04" &&
          tabStops("infoCalGrid").length === 1 &&
          tabStops("infoCalGrid")[0] === document.activeElement
      )
    );
    keyOn(document.activeElement, "Enter");
    check(
      "calendar-keyboard-enter-selects-and-keeps-focus",
      await waitUntil(
        () =>
          $("infoDate").value === "2027-01-04" &&
          document.activeElement?.dataset?.date === "2027-01-04" &&
          Boolean(document.activeElement?.classList.contains("selected"))
      )
    );
    $("infoCalTodayBtn").click();
    check(
      "calendar-today-button-view-only",
      await waitUntil(() => txt("infoCalTitle") === "November 2026") &&
        $("infoDate").value === "2027-01-04"
    );
    await setCalendarView("info", { anchor: "9999-12-15" });
    const outOfRangeCell = Array.from($("infoCalGrid").children).find((c) =>
      c.classList.contains("out-of-range")
    );
    check(
      "calendar-out-of-range-disabled",
      Boolean(outOfRangeCell) && outOfRangeCell.disabled === true
    );
    await resetCard("info");

    await resetCard("business");
    check(
      "biz-pick-initial-start",
      $("bizPickStart").checked && !$("bizPickEnd").checked && txt("bizCalHint") === UI_TEXT.calHintStart
    );
    cellOf("bizCalGrid", "2026-11-03")?.click();
    check(
      "biz-pick-start",
      await waitUntil(
        () =>
          $("bizStart").value === "2026-11-03" &&
          $("bizPickEnd").checked &&
          txt("bizCalHint") === UI_TEXT.calHintEnd
      )
    );
    cellOf("bizCalGrid", "2026-11-10")?.click();
    check(
      "biz-pick-end",
      await waitUntil(
        () =>
          $("bizEnd").value === "2026-11-10" &&
          txt("bizResult").startsWith("=5 business days") &&
          $("bizPickStart").checked
      )
    );
    check(
      "biz-marks-from-fields",
      Boolean(cellOf("bizCalGrid", "2026-11-03")?.classList.contains("pick-start")) &&
        Boolean(cellOf("bizCalGrid", "2026-11-10")?.classList.contains("pick-end")) &&
        !cellOf("bizCalGrid", "2026-11-10")?.classList.contains("in-range") &&
        !cellOf("bizCalGrid", "2026-11-09")?.classList.contains("pick-end") &&
        (cellOf("bizCalGrid", "2026-11-10")?.getAttribute("aria-label") || "").endsWith(
          UI_TEXT.calSuffixEnd
        )
    );
    cellOf("bizCalGrid", "2026-11-13")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })
    );
    check(
      "biz-shift-click-sets-end",
      await waitUntil(
        () =>
          $("bizEnd").value === "2026-11-13" &&
          $("bizStart").value === "2026-11-03" &&
          $("bizPickStart").checked
      )
    );
    $("bizEnd").dispatchEvent(new Event("focus"));
    check("biz-focus-end-selects-end", $("bizPickEnd").checked && txt("bizCalHint") === UI_TEXT.calHintEnd);
    $("bizStart").dispatchEvent(new Event("focus"));
    check("biz-focus-start-selects-start", $("bizPickStart").checked);
    cellOf("bizCalGrid", "2026-12-02")?.click();
    check(
      "biz-view-follows-click",
      await waitUntil(
        () => $("bizStart").value === "2026-12-02" && txt("bizCalTitle") === "December 2026"
      )
    );
    await resetCard("business");

    // 6. Countdown (fixed now: 2026-11-16 10:00:00 UTC+02:00)
    await setInput("cdTarget", "2027-01-01", () => updateCountdownLive());
    check(
      "countdown-clock",
      txt("cdClock") === "45d 14h 00m 00s" &&
        cdRegex.test(txt("cdClock")) &&
        txt("cdResult").includes("45 days, 14 hours until 2027-01-01") &&
        txt("cdStatus").includes("Counting down")
    );
    // [2026-11-16, 2027-01-01) on Sat/Sun with no preset: 34 weekdays.
    check("countdown-business-days-left", txt("cdResult").includes("business days left: 34"));
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

    // 6b. Countdown persistence (A2) through the in-memory store
    const commit = async (id, value) => {
      setField(id, value);
      $(id).dispatchEvent(new Event("input", { bubbles: true }));
      $(id).dispatchEvent(new Event("change", { bubbles: true }));
      await cdWriteChain;
      await updateCountdownLive();
      await cdWriteChain;
    };
    let cdLoad = await invoke("countdown_load");
    check(
      "countdown-reset-clears-store",
      cdLoad.status === "empty" && cdLoad.state === null && $("cdSavedNote").classList.contains("hidden")
    );
    await commit("cdTarget", "2027-01-01");
    await commit("cdTime", "09:30");
    cdLoad = await invoke("countdown_load");
    check(
      "countdown-save-load-round-trip",
      cdLoad.status === "ok" &&
        cdLoad.state?.schemaVersion === 1 &&
        cdLoad.state?.targetDate === "2027-01-01" &&
        cdLoad.state?.targetTime === "09:30" &&
        Number.isSafeInteger(cdLoad.state?.savedAtMs) &&
        cdLoad.state?.finishedSeenAtMs === null &&
        !$("cdSavedNote").classList.contains("hidden") &&
        txt("cdSavedNoteText") === UI_TEXT.cdSavedNote &&
        txt("cdPhase") === UI_TEXT.cdPhaseCounting &&
        txt("cdStatus").startsWith("Counting down to 2027-01-01 09:30:00")
    );
    await setInput("cdTarget", "", () => updateCountdownLive());
    $("cdTarget").dispatchEvent(new Event("change", { bubbles: true }));
    window.dispatchEvent(new Event("pagehide"));
    await cdWriteChain;
    cdLoad = await invoke("countdown_load");
    check(
      "countdown-empty-field-keeps-record",
      cdLoad.state?.targetDate === "2027-01-01" && cdLoad.state?.targetTime === "09:30"
    );
    setField("cdTime", "");
    await restoreSavedCountdown();
    await updateCountdownLive();
    check(
      "countdown-restore-future",
      $("cdTarget").value === "2027-01-01" &&
        $("cdTime").value === "09:30" &&
        txt("cdClock") === "45d 23h 30m 00s" &&
        txt("cdPhase") === UI_TEXT.cdPhaseRestored &&
        txt("cdStatus").startsWith("Countdown restored: 45 days, 23 hours, 30 minutes left until 2027-01-01")
    );
    cellOf("cdCalGrid", "2027-01-15")?.click();
    check(
      "calendar-click-countdown-saves",
      await waitUntil(async () => {
        await cdWriteChain;
        const l = await invoke("countdown_load");
        return (
          $("cdTarget").value === "2027-01-15" &&
          $("cdTime").value === "09:30" &&
          l.state?.targetDate === "2027-01-15" &&
          l.state?.targetTime === "09:30" &&
          txt("cdPhase") === UI_TEXT.cdPhaseCounting
        );
      })
    );
    await commit("cdTime", "");
    await commit("cdTarget", "2026-01-01");
    cdLoad = await invoke("countdown_load");
    const seenWhileOpen = document.visibilityState === "visible";
    check(
      "countdown-finished-while-open",
      txt("cdPhase") === UI_TEXT.cdPhaseFinished &&
        $("cdPhase").classList.contains("is-finished") &&
        txt("cdStatus").startsWith("Finished: 2026-01-01 00:00:00") &&
        cdLoad.state?.targetDate === "2026-01-01" &&
        (!seenWhileOpen || Number.isSafeInteger(cdLoad.state?.finishedSeenAtMs))
    );
    if (seenWhileOpen) {
      setField("cdTarget", "");
      await restoreSavedCountdown();
      await updateCountdownLive();
      check(
        "countdown-finished-while-open-then-closed",
        txt("cdPhase") === UI_TEXT.cdPhaseFinished && txt("cdStatus").startsWith("Finished: ")
      );
    }
    await invoke("countdown_save", {
      state: {
        schemaVersion: 1,
        targetDate: "2026-11-16",
        targetTime: "09:58",
        savedAtMs: 1,
        finishedSeenAtMs: null
      }
    });
    setField("cdTarget", "");
    setField("cdTime", "");
    await restoreSavedCountdown();
    await updateCountdownLive();
    await cdWriteChain;
    cdLoad = await invoke("countdown_load");
    check(
      "countdown-finished-while-closed",
      txt("cdPhase") === UI_TEXT.cdPhaseFinishedClosed &&
        txt("cdStatus").startsWith("Finished while the app was closed: 2026-11-16 09:58:00") &&
        (document.visibilityState !== "visible" || Number.isSafeInteger(cdLoad.state?.finishedSeenAtMs))
    );
    $("cdForgetBtn").click();
    window.dispatchEvent(new Event("pagehide"));
    await cdWriteChain;
    cdLoad = await invoke("countdown_load");
    check(
      "countdown-forget-clears",
      cdLoad.status === "empty" &&
        cdLoad.state === null &&
        $("cdSavedNote").classList.contains("hidden") &&
        $("cdTarget").value === "2026-11-16"
    );
    await applyCountdownQuick("plus30");
    await cdWriteChain;
    cdLoad = await invoke("countdown_load");
    check("countdown-quick-pill-saves", cdLoad.state?.targetDate === "2026-12-16");
    await resetCard("countdown");
    await cdWriteChain;
    cdLoad = await invoke("countdown_load");
    check(
      "countdown-reset-clears",
      cdLoad.status === "empty" && $("cdTarget").value === "" && txt("cdPhase") === ""
    );

    // History: read-only state, then clear, add, filter, restore, delete, clear
    const historyState = await invoke("history_state");
    check(
      "history-state-writable",
      historyState?.readOnly === false &&
        historyState?.reason === null &&
        $("historyReadOnlyBanner").classList.contains("hidden") &&
        !$("clearHistoryBtn").disabled
    );
    applyHistoryState({ readOnly: true, reason: "corrupt" });
    renderHistory();
    check(
      "history-read-only-banner",
      !$("historyReadOnlyBanner").classList.contains("hidden") &&
        txt("historyReadOnlyText") === UI_TEXT.historyReadOnly &&
        txt("historyReadOnlyDetail") === UI_TEXT.historyReasonCorrupt &&
        $("clearHistoryBtn").disabled === true &&
        Array.from(document.querySelectorAll(".history-delete-btn")).every((b) => b.disabled)
    );
    $("historyResetBtn").click();
    check(
      "history-reset-two-step",
      !$("historyResetConfirm").classList.contains("hidden") &&
        $("historyResetBtn").classList.contains("hidden")
    );
    $("cancelHistoryResetBtn").click();
    $("historyRetryBtn").click();
    check(
      "history-retry-writable",
      await waitUntil(
        () =>
          historyReadOnly === false &&
          $("historyReadOnlyBanner").classList.contains("hidden") &&
          !$("clearHistoryBtn").disabled
      )
    );
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
  // A2: the saved countdown fills the empty card before the first render, so
  // the exact time left shows at once (smoke mode reads the in-memory store).
  await restoreSavedCountdown();
  resetBizPickTarget();

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
  const resumeVisible = () => {
    checkDayRollover();
    if (cdActive) updateCountdownLive({ fromTick: true });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearCountdownTimer();
      persistCountdown({ explicit: false });
      return;
    }
    resumeVisible();
  });
  window.addEventListener("pagehide", () => {
    persistCountdown({ explicit: false });
  });
  // Back/forward cache: the page returns without a visibilitychange.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resumeVisible();
  });

  $("betweenStart").focus();
  await runSmokeTestIfRequested(smokeEnabled === true);
}

initialize();
