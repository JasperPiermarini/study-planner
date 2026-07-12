import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// ---------- Setup guard ----------

if (firebaseConfig.apiKey.startsWith("PASTE")) {
  document.getElementById("setup-notice").classList.remove("hidden");
  document.querySelector(".app-header").classList.add("hidden");
  throw new Error("Firebase config not set — see README.md");
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const plansCol = collection(db, "plans");
const topicsCol = collection(db, "topics");

// ---------- State ----------

let plans = [];
let topics = [];

// ---------- Date helpers (local timezone) ----------

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayStr() {
  return toDateStr(new Date());
}

function parseDateStr(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(str, n) {
  const date = parseDateStr(str);
  date.setDate(date.getDate() + n);
  return toDateStr(date);
}

function daysBetween(a, b) {
  return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000);
}

function formatDate(str) {
  return parseDateStr(str).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function formatDateLong(str) {
  return parseDateStr(str).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ---------- Auto-spread ----------

// Distribute topics evenly across the days from startDate to endDate inclusive.
function spreadDates(count, startDate, endDate) {
  const days = Math.max(daysBetween(startDate, endDate) + 1, 1);
  const dates = [];
  for (let i = 0; i < count; i++) {
    dates.push(addDays(startDate, Math.floor((i * days) / count)));
  }
  return dates;
}

// ---------- Topic line parsing ----------

// A topic entry may end with a URL, e.g. "Trig sub https://openstax.org/..."
// or "Trig sub | https://...". Returns { title, link }.
function parseTopicLine(line) {
  const match = line.match(/^(.*?)[\s|]+((?:https?:\/\/|www\.)\S+)$/i);
  if (!match || !match[1].trim()) return { title: line.trim(), link: "" };
  let link = match[2];
  if (!/^https?:\/\//i.test(link)) link = "https://" + link;
  return { title: match[1].replace(/[\s|]+$/, "").trim(), link };
}

// ---------- Firestore actions ----------

async function createPlan(name, startDate, endDate, topicEntries) {
  const planRef = await addDoc(plansCol, {
    name,
    startDate,
    endDate,
    createdAt: serverTimestamp(),
  });
  const dates = spreadDates(topicEntries.length, startDate, endDate);
  const batch = writeBatch(db);
  topicEntries.forEach((entry, i) => {
    batch.set(doc(topicsCol), {
      planId: planRef.id,
      title: entry.title,
      link: entry.link,
      date: dates[i],
      done: false,
      order: i,
    });
  });
  await batch.commit();
  return planRef.id;
}

async function deletePlan(plan) {
  const planTopics = topics.filter((t) => t.planId === plan.id);
  const batch = writeBatch(db);
  planTopics.forEach((t) => batch.delete(doc(topicsCol, t.id)));
  batch.delete(doc(plansCol, plan.id));
  await batch.commit();

  pushUndo({
    label: `Deleted plan "${plan.name}"`,
    restore: async () => {
      const newPlanRef = await addDoc(plansCol, {
        name: plan.name,
        startDate: plan.startDate,
        endDate: plan.endDate,
        createdAt: serverTimestamp(),
      });
      const restoreBatch = writeBatch(db);
      planTopics.forEach((t) => {
        restoreBatch.set(doc(topicsCol), {
          planId: newPlanRef.id,
          title: t.title,
          link: t.link ?? "",
          date: t.date,
          done: t.done,
          order: t.order ?? 0,
        });
      });
      await restoreBatch.commit();
      location.hash = `#plan/${newPlanRef.id}`;
    },
  });
}

function toggleTopic(topic) {
  updateDoc(doc(topicsCol, topic.id), { done: !topic.done });
}

function moveTopic(topic, days) {
  updateDoc(doc(topicsCol, topic.id), { date: addDays(topic.date, days) });
}

function moveTopicToDate(topicId, date) {
  const topic = topics.find((t) => t.id === topicId);
  if (topic && topic.date !== date) {
    updateDoc(doc(topicsCol, topicId), { date });
  }
}

function moveTopicToToday(topic) {
  updateDoc(doc(topicsCol, topic.id), { date: todayStr() });
}

function deleteTopic(topic) {
  deleteDoc(doc(topicsCol, topic.id));
  pushUndo({
    label: `Deleted "${topic.title}"`,
    restore: () =>
      addDoc(topicsCol, {
        planId: topic.planId,
        title: topic.title,
        link: topic.link ?? "",
        date: topic.date,
        done: topic.done,
        order: topic.order ?? 0,
      }),
  });
}

function editTopicLink(topic) {
  const input = prompt(
    "Link for this topic (leave empty to remove):",
    topic.link ?? ""
  );
  if (input === null) return;
  let link = input.trim();
  if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
  updateDoc(doc(topicsCol, topic.id), { link });
}

async function addTopic(planId, title, link, date) {
  const maxOrder = Math.max(
    -1,
    ...topics.filter((t) => t.planId === planId).map((t) => t.order ?? 0)
  );
  await addDoc(topicsCol, {
    planId,
    title,
    link,
    date,
    done: false,
    order: maxOrder + 1,
  });
}

// Redistribute all undone topics of a plan evenly from today (or the plan
// start, whichever is later) to the plan end date.
async function respreadPlan(plan) {
  const undone = topics
    .filter((t) => t.planId === plan.id && !t.done)
    .sort(byDateAndOrder);
  if (undone.length === 0) return;
  const start =
    todayStr() > plan.startDate ? todayStr() : plan.startDate;
  const end = plan.endDate >= start ? plan.endDate : start;
  const dates = spreadDates(undone.length, start, end);
  const batch = writeBatch(db);
  undone.forEach((t, i) => batch.update(doc(topicsCol, t.id), { date: dates[i] }));
  await batch.commit();
}

function byDateAndOrder(a, b) {
  return a.date.localeCompare(b.date) || (a.order ?? 0) - (b.order ?? 0);
}

// ---------- Undo ----------

let undoEntries = [];
let undoCounter = 0;
const UNDO_TIMEOUT_MS = 8000;

function pushUndo({ label, restore }) {
  const id = ++undoCounter;
  const timeoutId = setTimeout(() => dismissUndo(id), UNDO_TIMEOUT_MS);
  undoEntries.push({ id, label, restore, timeoutId });
  renderUndoToasts();
}

function dismissUndo(id) {
  const entry = undoEntries.find((e) => e.id === id);
  if (!entry) return;
  clearTimeout(entry.timeoutId);
  undoEntries = undoEntries.filter((e) => e.id !== id);
  renderUndoToasts();
}

function triggerUndo(id) {
  const entry = undoEntries.find((e) => e.id === id);
  if (!entry) return;
  clearTimeout(entry.timeoutId);
  undoEntries = undoEntries.filter((e) => e.id !== id);
  renderUndoToasts();
  entry.restore();
}

function renderUndoToasts() {
  let container = document.getElementById("undo-toasts");
  if (!container) {
    container = el("div", { class: "undo-toasts", id: "undo-toasts" });
    document.body.append(container);
  }
  container.replaceChildren(
    ...undoEntries.map((entry) =>
      el(
        "div",
        { class: "undo-toast" },
        el("span", { class: "undo-toast-label" }, entry.label),
        el(
          "button",
          { class: "btn small primary", onclick: () => triggerUndo(entry.id) },
          "Undo"
        )
      )
    )
  );
}

// ---------- Rendering helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

// Inline SVG icons — renders identically on every platform, unlike emoji
// characters which mobile OSes substitute with colorful native glyphs.
const ICON_PATHS = {
  link: '<path d="M9.5 14.5 14.5 9.5" /><path d="M11 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1" /><path d="M13 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1" />',
  "chevron-left": '<polyline points="15 6 9 12 15 18" />',
  "chevron-right": '<polyline points="9 6 15 12 9 18" />',
  x: '<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />',
  "external-link": '<line x1="7" y1="17" x2="17" y2="7" /><polyline points="9 7 17 7 17 15" />',
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("icon");
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}

function planName(planId) {
  return plans.find((p) => p.id === planId)?.name ?? "";
}

// Compact draggable card used in the plan calendar board.
function topicCard(topic) {
  const check = el("input", {
    type: "checkbox",
    class: "topic-check",
    onchange: () => toggleTopic(topic),
  });
  check.checked = topic.done;

  const card = el(
    "div",
    { class: "topic-card" + (topic.done ? " done" : ""), draggable: "true" },
    el(
      "div",
      { class: "topic-card-top" },
      check,
      el("span", { class: "topic-title" }, topic.title),
      topic.link
        ? el(
            "a",
            {
              class: "icon-btn topic-link",
              href: topic.link,
              target: "_blank",
              rel: "noopener",
              title: topic.link,
            },
            icon("external-link")
          )
        : null
    ),
    el(
      "div",
      { class: "topic-card-controls" },
      el("button", { class: "icon-btn small", title: "Add or edit link", onclick: () => editTopicLink(topic) }, icon("link")),
      el("button", { class: "icon-btn small", title: "Move a day earlier", onclick: () => moveTopic(topic, -1) }, icon("chevron-left")),
      el("button", { class: "icon-btn small", title: "Move a day later", onclick: () => moveTopic(topic, 1) }, icon("chevron-right")),
      el("button", { class: "icon-btn small danger", title: "Delete topic", onclick: () => deleteTopic(topic) }, icon("x"))
    )
  );

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", topic.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  return card;
}

function topicRow(topic, { showPlan = false, showToToday = false } = {}) {
  const check = el("input", {
    type: "checkbox",
    class: "topic-check",
    onchange: () => toggleTopic(topic),
  });
  check.checked = topic.done;

  const row = el(
    "div",
    { class: "topic-row" + (topic.done ? " done" : "") },
    check,
    el("span", { class: "topic-title" }, topic.title),
    topic.link
      ? el(
          "a",
          {
            class: "icon-btn topic-link",
            href: topic.link,
            target: "_blank",
            rel: "noopener",
            title: topic.link,
          },
          icon("external-link")
        )
      : null,
    showPlan ? el("span", { class: "topic-plan" }, planName(topic.planId)) : null
  );

  if (showToToday) {
    row.append(
      el("button", { class: "btn small", onclick: () => moveTopicToToday(topic) }, "To today")
    );
  }
  return row;
}

// ---------- Pomodoro ----------

function loadMinutes(key, fallback) {
  const value = parseInt(localStorage.getItem(key), 10);
  return value >= 1 && value <= 180 ? value : fallback;
}

const pomo = {
  mode: "focus", // "focus" | "break"
  focusMinutes: loadMinutes("pomo.focus", 25),
  breakMinutes: loadMinutes("pomo.break", 5),
  remaining: 0,
  running: false,
  intervalId: null,
};
pomo.remaining = pomo.focusMinutes * 60;

function pomoDuration() {
  return (pomo.mode === "focus" ? pomo.focusMinutes : pomo.breakMinutes) * 60;
}

function setPomoMinutes(mode, minutes) {
  minutes = Math.min(Math.max(Math.round(minutes) || 1, 1), 180);
  if (mode === "focus") pomo.focusMinutes = minutes;
  else pomo.breakMinutes = minutes;
  localStorage.setItem(mode === "focus" ? "pomo.focus" : "pomo.break", minutes);
  if (!pomo.running) pomo.remaining = pomoDuration();
  updatePomoDisplay();
  return minutes;
}

function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function pomoTick() {
  pomo.remaining--;
  if (pomo.remaining <= 0) {
    beep();
    pomo.mode = pomo.mode === "focus" ? "break" : "focus";
    pomo.remaining = pomoDuration();
    pomoPause();
  }
  updatePomoDisplay();
}

function pomoStart() {
  if (pomo.running) return;
  pomo.running = true;
  pomo.intervalId = setInterval(pomoTick, 1000);
  updatePomoDisplay();
}

function pomoPause() {
  pomo.running = false;
  clearInterval(pomo.intervalId);
  updatePomoDisplay();
}

function pomoReset() {
  pomoPause();
  pomo.mode = "focus";
  pomo.remaining = pomo.focusMinutes * 60;
  updatePomoDisplay();
}

function updatePomoDisplay() {
  const time = formatTime(pomo.remaining);
  document.title = pomo.running ? `${time} · Study Planner` : "Study Planner";

  const widget = document.getElementById("pomodoro");
  if (!widget) return;
  widget.classList.toggle("break-mode", pomo.mode === "break");
  widget.querySelector(".pomodoro-time").textContent = time;
  widget.querySelector(".pomodoro-mode").textContent =
    pomo.mode === "focus" ? "Focus" : "Break";
  widget.querySelector(".pomodoro-toggle").textContent = pomo.running
    ? "Pause"
    : "Start";
}

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.start();
    osc.stop(ctx.currentTime + 0.8);
  } catch {
    // audio not available — silently skip
  }
}

function minutesInput(mode) {
  const input = el("input", {
    type: "number",
    min: "1",
    max: "180",
    title: `${mode === "focus" ? "Focus" : "Break"} length in minutes`,
    onchange: () => (input.value = setPomoMinutes(mode, Number(input.value))),
  });
  input.value = mode === "focus" ? pomo.focusMinutes : pomo.breakMinutes;
  return input;
}

function pomodoroWidget() {
  const widget = el(
    "div",
    { class: "pomodoro", id: "pomodoro" },
    el(
      "div",
      {},
      el("div", { class: "pomodoro-mode" }, "Focus"),
      el("div", { class: "pomodoro-time" }, formatTime(pomo.remaining))
    ),
    el(
      "div",
      { class: "pomodoro-settings" },
      minutesInput("focus"),
      el("span", {}, "focus ·"),
      minutesInput("break"),
      el("span", {}, "break")
    ),
    el(
      "div",
      { class: "pomodoro-controls" },
      el(
        "button",
        {
          class: "btn primary pomodoro-toggle",
          onclick: () => (pomo.running ? pomoPause() : pomoStart()),
        },
        pomo.running ? "Pause" : "Start"
      ),
      el("button", { class: "btn ghost", onclick: pomoReset }, "Reset")
    )
  );
  return widget;
}

// ---------- Views ----------

const view = document.getElementById("view");

function renderToday() {
  const today = todayStr();
  const dueToday = topics.filter((t) => t.date === today && !t.done).sort(byDateAndOrder);
  const overdue = topics.filter((t) => t.date < today && !t.done).sort(byDateAndOrder);
  const doneToday = topics.filter((t) => t.date === today && t.done).sort(byDateAndOrder);

  view.replaceChildren(
    el(
      "div",
      { class: "view-heading" },
      el("h2", {}, "Today"),
      el("span", { class: "subtle" }, formatDateLong(today))
    ),
    pomodoroWidget()
  );
  updatePomoDisplay();

  if (overdue.length > 0) {
    view.append(el("div", { class: "section-label" }, `Overdue · ${overdue.length}`));
    overdue.forEach((t) => view.append(topicRow(t, { showPlan: true, showToToday: true })));
  }

  view.append(el("div", { class: "section-label" }, `To study · ${dueToday.length}`));
  if (dueToday.length === 0) {
    view.append(
      el(
        "div",
        { class: "empty-state" },
        overdue.length > 0
          ? "Nothing scheduled for today — but there's overdue material above."
          : plans.length > 0
            ? "Nothing scheduled for today. Enjoy the breather ✨"
            : "No plans yet. Create one under Plans."
      )
    );
  } else {
    dueToday.forEach((t) => view.append(topicRow(t, { showPlan: true })));
  }

  if (doneToday.length > 0) {
    view.append(el("div", { class: "section-label" }, `Done today · ${doneToday.length}`));
    doneToday.forEach((t) => view.append(topicRow(t, { showPlan: true })));
  }
}

function renderAllTopics() {
  const today = todayStr();
  const sorted = [...topics].sort(byDateAndOrder);

  view.replaceChildren(
    el(
      "div",
      { class: "view-heading" },
      el("h2", {}, "All topics"),
      el("span", { class: "subtle" }, `${sorted.length} across all plans`)
    )
  );

  if (sorted.length === 0) {
    view.append(
      el("div", { class: "empty-state" }, "No topics yet. Create a plan to get started.")
    );
    return;
  }

  const byDate = new Map();
  for (const t of sorted) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  for (const [date, dayTopics] of byDate) {
    const isToday = date === today;
    view.append(
      el(
        "div",
        { class: "section-label" + (isToday ? " today" : "") },
        isToday ? "Today" : formatDate(date)
      )
    );
    dayTopics.forEach((t) => view.append(topicRow(t, { showPlan: true })));
  }
}

function renderPlans() {
  view.replaceChildren(
    el(
      "div",
      { class: "view-heading" },
      el("h2", {}, "Plans"),
      el("a", { href: "#new-plan", class: "btn primary" }, "+ New plan")
    )
  );

  if (plans.length === 0) {
    view.append(
      el(
        "div",
        { class: "empty-state" },
        "No plans yet. Create your first study plan to get started."
      )
    );
    return;
  }

  const sorted = [...plans].sort((a, b) => a.endDate.localeCompare(b.endDate));
  for (const plan of sorted) {
    const planTopics = topics.filter((t) => t.planId === plan.id);
    const done = planTopics.filter((t) => t.done).length;
    const total = planTopics.length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const daysLeft = daysBetween(todayStr(), plan.endDate);
    const daysLabel =
      daysLeft > 1 ? `${daysLeft} days left`
      : daysLeft === 1 ? "1 day left"
      : daysLeft === 0 ? "Last day"
      : "Ended";

    const fill = el("div", { class: "progress-fill" });
    fill.style.width = `${pct}%`;

    view.append(
      el(
        "a",
        { class: "card plan-card", href: `#plan/${plan.id}` },
        el(
          "div",
          { class: "plan-card-top" },
          el("h3", {}, plan.name),
          el("span", { class: "plan-dates" }, `${formatDate(plan.startDate)} – ${formatDate(plan.endDate)}`)
        ),
        el("div", { class: "progress-track" }, fill),
        el(
          "div",
          { class: "plan-meta" },
          el("span", {}, `${done} / ${total} topics`),
          el("span", {}, daysLabel)
        )
      )
    );
  }
}

function renderNewPlan() {
  const nameInput = el("input", { type: "text", placeholder: "e.g. Statistics exam" });
  const startInput = el("input", { type: "date", value: todayStr() });
  const endInput = el("input", { type: "date", value: addDays(todayStr(), 13) });
  const topicsInput = el("textarea", {
    placeholder: "One topic per line, in the order you want to study them.\nOptionally end a line with a link:\nChapter 1 — Descriptive statistics\nChapter 2 — Probability https://openstax.org/...\nPractice exam 2024",
  });

  const form = el(
    "form",
    {
      class: "card form-card",
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        const entries = topicsInput.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map(parseTopicLine);
        if (!name || entries.length === 0) {
          alert("Give the plan a name and at least one topic.");
          return;
        }
        if (endInput.value < startInput.value) {
          alert("The end date is before the start date.");
          return;
        }
        form.querySelector("button[type=submit]").disabled = true;
        const planId = await createPlan(name, startInput.value, endInput.value, entries);
        location.hash = `#plan/${planId}`;
      },
    },
    el("label", {}, "Plan name"),
    nameInput,
    el(
      "div",
      { class: "form-row" },
      el("div", {}, el("label", {}, "Start date"), startInput),
      el("div", {}, el("label", {}, "End date"), endInput)
    ),
    el("label", {}, "Topics to cover"),
    topicsInput,
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn primary", type: "submit" }, "Create plan"),
      el("a", { class: "btn ghost", href: "#plans" }, "Cancel")
    )
  );

  view.replaceChildren(
    el("div", { class: "view-heading" }, el("h2", {}, "New plan")),
    form
  );
  nameInput.focus();
}

// Remembers which day was last clicked as the "add a topic" target, per plan,
// so it survives the full re-render that follows every Firestore update.
const selectedAddDate = {};

// Tracks which plan is currently open so a Firestore-triggered re-render (e.g.
// after a drag-and-drop move) can keep the board's scroll position instead of
// re-running the "scroll to today" logic every time.
let lastRenderedPlanId = null;

function renderPlanDetail(planId) {
  const plan = plans.find((p) => p.id === planId);
  if (!plan) {
    view.replaceChildren(el("div", { class: "empty-state" }, "Plan not found."));
    return;
  }

  const isFreshNavigation = planId !== lastRenderedPlanId;
  const previousScrollLeft = view.querySelector(".day-board")?.scrollLeft;
  lastRenderedPlanId = planId;

  const planTopics = topics.filter((t) => t.planId === planId).sort(byDateAndOrder);
  const today = todayStr();
  const defaultDate = today >= plan.startDate && today <= plan.endDate ? today : plan.startDate;
  const initialSelectedDate = selectedAddDate[planId] ?? defaultDate;

  view.replaceChildren(
    el(
      "div",
      { class: "view-heading" },
      el("h2", {}, plan.name),
      el("span", { class: "subtle" }, `${formatDate(plan.startDate)} – ${formatDate(plan.endDate)}`)
    ),
    el(
      "div",
      { class: "detail-toolbar" },
      el("a", { class: "btn ghost", href: "#plans" }, "← All plans"),
      el(
        "button",
        {
          class: "btn",
          title: "Redistribute unfinished topics evenly from today to the end date",
          onclick: () => respreadPlan(plan),
        },
        "Re-spread remaining"
      ),
      el(
        "button",
        {
          class: "btn ghost danger",
          onclick: () => {
            if (confirm(`Delete "${plan.name}" and all its topics?`)) {
              deletePlan(plan);
              location.hash = "#plans";
            }
          },
        },
        "Delete plan"
      )
    )
  );

  // Calendar board: one column per day, left to right, including empty days.
  // Extend the range to cover topics moved outside the plan's dates.
  let first = plan.startDate;
  let last = plan.endDate;
  for (const t of planTopics) {
    if (t.date < first) first = t.date;
    if (t.date > last) last = t.date;
  }

  const byDate = new Map();
  for (const t of planTopics) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  // Add-topic form fields, created early so day columns can update them.
  const titleInput = el("input", { type: "text", placeholder: "Add a topic… (link at the end is optional)" });
  const dateInput = el("input", { type: "date", value: initialSelectedDate });

  function selectDate(date, colEl) {
    selectedAddDate[planId] = date;
    dateInput.value = date;
    board.querySelectorAll(".day-col.selected").forEach((c) => c.classList.remove("selected"));
    colEl?.classList.add("selected");
  }

  dateInput.addEventListener("change", () => {
    selectedAddDate[planId] = dateInput.value;
    board.querySelectorAll(".day-col.selected").forEach((c) => c.classList.remove("selected"));
    board.querySelector(`[data-date="${dateInput.value}"]`)?.classList.add("selected");
  });

  const board = el("div", { class: "day-board" });
  let todayCol = null;
  for (let date = first, i = 0; date <= last && i < 370; date = addDays(date, 1), i++) {
    const isToday = date === today;
    const outOfRange = date < plan.startDate || date > plan.endDate;
    const dayOfWeek = parseDateStr(date).getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const col = el(
      "div",
      {
        class:
          "day-col" +
          (isToday ? " today" : "") +
          (date < today ? " past-day" : "") +
          (isWeekend ? " weekend" : "") +
          (outOfRange ? " out-of-range" : "") +
          (date === initialSelectedDate ? " selected" : ""),
        "data-date": date,
      },
      el(
        "div",
        { class: "day-col-header" },
        el("div", { class: "day-col-weekday" }, isToday ? "Today" : parseDateStr(date).toLocaleDateString(undefined, { weekday: "short" })),
        el("div", { class: "day-col-date" }, parseDateStr(date).toLocaleDateString(undefined, { day: "numeric", month: "short" }))
      )
    );

    const dropDate = date;
    col.addEventListener("click", (e) => {
      if (e.target.closest(".topic-card")) return;
      selectDate(dropDate, col);
    });
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("drag-over");
    });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      moveTopicToDate(e.dataTransfer.getData("text/plain"), dropDate);
    });

    (byDate.get(date) ?? []).forEach((t) => col.append(topicCard(t)));
    board.append(col);
    if (isToday) todayCol = col;
  }
  view.append(board);

  // On first opening this plan, scroll today into view — horizontally on the
  // desktop board, vertically (page scroll) on the mobile stacked layout. On
  // later re-renders (e.g. after a drag-and-drop move updates Firestore),
  // keep wherever the board was already scrolled to instead of snapping back.
  // Use "instant" explicitly — .day-board has scroll-behavior: smooth for
  // user-driven scrolling, which would otherwise make these programmatic
  // corrections visibly animate from the left edge on every re-render.
  if (isFreshNavigation) {
    if (todayCol) {
      if (window.matchMedia("(max-width: 480px)").matches) {
        todayCol.scrollIntoView({ block: "center", behavior: "instant" });
      } else {
        board.scrollTo({ left: Math.max(0, todayCol.offsetLeft - board.clientWidth / 3), behavior: "instant" });
      }
    }
  } else if (previousScrollLeft) {
    board.scrollTo({ left: previousScrollLeft, behavior: "instant" });
  }

  if (planTopics.length === 0) {
    view.append(el("div", { class: "empty-state" }, "No topics in this plan yet — add one below."));
  }

  view.append(
    el(
      "form",
      {
        class: "add-topic-form",
        onsubmit: (e) => {
          e.preventDefault();
          const entry = parseTopicLine(titleInput.value);
          if (!entry.title) return;
          addTopic(planId, entry.title, entry.link, dateInput.value || initialSelectedDate);
          titleInput.value = "";
        },
      },
      titleInput,
      dateInput,
      el("button", { class: "btn", type: "submit" }, "Add")
    )
  );
}

// ---------- Router ----------

function currentRoute() {
  return location.hash.replace(/^#/, "") || "today";
}

function render() {
  const route = currentRoute();
  const tabName = route.startsWith("plan") || route === "new-plan" ? "plans" : route === "all-topics" ? null : "today";
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  view.classList.toggle("wide", route.startsWith("plan/"));

  if (!route.startsWith("plan/")) lastRenderedPlanId = null;

  if (route === "today") renderToday();
  else if (route === "plans") renderPlans();
  else if (route === "new-plan") renderNewPlan();
  else if (route === "all-topics") renderAllTopics();
  else if (route.startsWith("plan/")) renderPlanDetail(route.slice(5));
  else renderToday();
}

window.addEventListener("hashchange", render);

// ---------- Live data ----------

function showDbError(error) {
  let banner = document.getElementById("db-error");
  if (!banner) {
    banner = el("div", { class: "db-error", id: "db-error" });
    document.querySelector(".app-header").after(banner);
  }
  banner.textContent =
    error.code === "permission-denied"
      ? "Can't reach the database: permission denied. Publish the Firestore rules from the README in the Firebase console."
      : `Database error: ${error.message}`;
}

onSnapshot(plansCol, (snap) => {
  plans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, showDbError);

onSnapshot(topicsCol, (snap) => {
  topics = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, showDbError);

render();
