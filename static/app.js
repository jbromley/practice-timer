const $ = (id) => document.getElementById(id);
const sessionForm = $("session-form");
const nameDialog = $("name-dialog");
const deleteDialog = $("delete-dialog");
const descriptionDialog = $("description-dialog");
const addIntervalDialog = $("add-interval-dialog");
const runIntervals = $("run-intervals");
const practiceDate = $("practice-date");
const timerButtons = [...document.querySelectorAll("[data-action]")];
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
let templates = [];
let selectedTemplate = null;
let run = null;
let clockOffset = 0;
let pendingName = null;
let busy = false;
let historyRequest = 0;

async function api(path, body) {
  const response = await fetch("/api/" + path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

function message(text = "", id = "notice") {
  $(id).textContent = text;
  $(id).hidden = !text;
}

async function report(error) {
  if (error.status === 409) {
    try {
      applyRun(await api("active"));
      await loadTemplates();
    } catch {
      // Keep the action's original error visible if refresh fails.
    }
  }
  message(error.message);
}

function today() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value) => String(value).padStart(2, "0")).join("-");
}

function duration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = String(seconds % 60).padStart(2, "0");
  return hours ? hours + ":" + String(minutes).padStart(2, "0") + ":" + remainder : minutes + ":" + remainder;
}

function intervalName(interval, index) {
  return interval.description || "Interval " + (index + 1);
}

function record(title, subtitle, time, onClick) {
  const row = document.createElement("li");
  const content = onClick ? document.createElement("button") : row;
  const label = document.createElement("span");
  label.textContent = title;
  if (subtitle) {
    const detail = document.createElement("small");
    detail.textContent = subtitle;
    label.append(detail);
  }
  content.append(label);
  if (time) {
    const measure = document.createElement("span");
    measure.className = "measure";
    measure.textContent = time;
    content.append(measure);
  }
  if (onClick) {
    content.type = "button";
    content.className = "record-link";
    content.addEventListener("click", onClick);
    row.append(content);
  } else {
    row.className = "card";
  }
  return row;
}

function refreshIntervalFields() {
  const count = $("intervals").children.length;
  $("empty-intervals").hidden = count > 0;
  $("add-interval").disabled = count >= 200;
  updatePlannedTotal();
}

function updatePlannedTotal() {
  const minutes = [...$("intervals").querySelectorAll(".minutes")].reduce(
    (total, input) => total + (input.validity.valid ? Number(input.value) : 0), 0,
  );
  $("planned-total").value = minutes + " min";
}

function setupDurationFields(form) {
  form.addEventListener("beforeinput", (event) => {
    if (event.target.matches(".minutes") && /[^0-9]/.test(event.data ?? "")) {
      event.preventDefault();
    }
  });
  form.addEventListener("input", (event) => {
    const input = event.target;
    if (!input.matches(".minutes")) return;
    const digits = input.value.replace(/[^0-9]/g, "");
    if (digits !== input.value) {
      const cursor = input.value.slice(0, input.selectionStart).replace(/[^0-9]/g, "").length;
      input.value = digits;
      input.setSelectionRange(cursor, cursor);
    }
    const minutes = Number(digits);
    input.setCustomValidity(digits && (minutes < 1 || minutes > 1440)
      ? "Enter a duration from 1 to 1440 minutes."
      : "");
  });
}

function setupIntervalReordering(list, requestMove) {
  let drag = null;
  let frame = 0;

  function move(row, before) {
    if (row.nextElementSibling === before) return;
    if (requestMove) {
      const rows = [...list.children];
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      requestMove(index, before ? rows.indexOf(before) : rows.length);
      return;
    }
    list.insertBefore(row, before);
    row.querySelector(".drag-handle").focus({ preventScroll: true });
    const position = Array.from(list.children).indexOf(row) + 1;
    $("reorder-status").textContent = "Moved interval to position " + position + " of " + list.children.length + ".";
  }

  function clearMarker() {
    drag.marker?.classList.remove("drop-before", "drop-after");
  }

  function showTarget() {
    clearMarker();
    const rows = Array.from(list.children).filter((row) => row !== drag.row);
    drag.before = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return drag.y < rect.top + rect.height / 2;
    }) ?? null;
    drag.marker = drag.before ?? rows.at(-1);
    drag.marker?.classList.add(drag.before ? "drop-before" : "drop-after");
  }

  function scrollAtEdge() {
    const edge = 48;
    const delta = drag.y < edge ? -12 : drag.y > window.innerHeight - edge ? 12 : 0;
    if (delta) {
      window.scrollBy(0, delta);
      showTarget();
    }
    frame = requestAnimationFrame(scrollAtEdge);
  }

  function finish(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.started && event.type === "pointerup" && drag.row.parentElement === list) {
      drag.y = event.clientY;
      showTarget();
      move(drag.row, drag.before);
    }
    clearMarker();
    drag.row.classList.remove("dragging");
    drag = null;
    cancelAnimationFrame(frame);
  }

  list.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (drag || !handle || handle.disabled || event.button !== 0 || list.children.length < 2) return;
    drag = { row: handle.closest("li"), pointerId: event.pointerId, startY: event.clientY };
    list.setPointerCapture(event.pointerId);
  });
  list.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    if (!drag.started) {
      if (Math.abs(drag.y - drag.startY) < 5) return;
      drag.started = true;
      drag.row.classList.add("dragging");
      frame = requestAnimationFrame(scrollAtEdge);
    }
    showTarget();
  });
  list.addEventListener("pointerup", finish);
  list.addEventListener("pointercancel", finish);
  list.addEventListener("lostpointercapture", finish);
  list.addEventListener("keydown", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (!handle || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const row = handle.closest("li");
    const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (sibling) move(row, event.key === "ArrowUp" ? sibling : sibling.nextElementSibling);
  });
}

function addInterval(interval = { minutes: 5, description: "" }, focus = false) {
  const row = $("interval-fields").content.firstElementChild.cloneNode(true);
  const minutes = row.querySelector(".minutes");
  minutes.value = interval.minutes;
  row.querySelector(".interval-description").value = interval.description;
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    refreshIntervalFields();
    $("add-interval").focus();
  });
  $("intervals").append(row);
  refreshIntervalFields();
  if (focus) minutes.select();
}

function readDefinition() {
  return {
    name: $("session-name").value.trim(),
    instrument: $("instrument").value.trim(),
    description: $("session-description").value.trim(),
    intervals: Array.from($("intervals").children, (row) => ({
      minutes: Number(row.querySelector(".minutes").value),
      description: row.querySelector(".interval-description").value.trim(),
    })),
  };
}

function selectTemplate(template) {
  selectedTemplate = template;
  $("delete-template").disabled = busy || !template;
  const created = $("template-created");
  created.textContent = template?.created_on
    ? "Template created " + dateFormat.format(new Date(template.created_on))
    : "Creation data N/A";
}

function useTemplate(template) {
  selectTemplate(template);
  const data = template.definition;
  $("session-name").value = template.name;
  $("instrument").value = data.instrument ?? "";
  $("session-description").value = data.description;
  $("intervals").replaceChildren();
  data.intervals.forEach((interval) => addInterval(interval));
  refreshIntervalFields();
  message("Loaded template “" + template.name + "”.");
}

async function loadTemplates() {
  templates = await api("templates");
}

function setupChoices(inputId, panelId, load, select) {
  const input = $(inputId);
  const panel = $(panelId);
  const control = input.parentElement;
  let options = [];
  let opening = 0;

  function position() {
    if (!panel.matches(":popover-open")) return;
    const { left, width, top, bottom } = control.getBoundingClientRect();
    const below = window.innerHeight - bottom;
    const above = below < 180 && top > below;
    panel.style.left = left + "px";
    panel.style.width = width + "px";
    panel.style.maxHeight = Math.min(240, (above ? top : below) - 8) + "px";
    panel.style.top = above ? "auto" : bottom + 4 + "px";
    panel.style.bottom = above ? window.innerHeight - top + 4 + "px" : "auto";
  }

  function render(query = "") {
    const matches = options.filter(({ name }) => name.toLocaleLowerCase().includes(query));
    panel.replaceChildren();
    if (!matches.length) panel.textContent = query ? "No matches." : "No saved entries.";
    for (const option of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.name;
      button.addEventListener("click", () => {
        select(option);
        panel.hidePopover();
        input.focus();
      });
      panel.append(button);
    }
  }

  panel.addEventListener("toggle", async (event) => {
    const request = ++opening;
    if (event.newState !== "open") return;
    position();
    panel.textContent = "Loading…";
    try {
      options = await load();
      if (request === opening && panel.matches(":popover-open")) render();
    } catch (error) {
      if (request === opening && panel.matches(":popover-open")) panel.textContent = error.message;
    }
  });

  input.addEventListener("input", () => {
    if (panel.matches(":popover-open")) render(input.value.trim().toLocaleLowerCase());
  });
  control.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (panel.matches(":popover-open")) panel.querySelector("button")?.focus();
    else control.querySelector("button").click();
  });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position);
}

function showOverwrite() {
  $("overwrite-note").hidden = !templates.some((item) => item.name === $("template-name").value.trim());
}

function nextTemplateName(original) {
  const legacyBase = original.replace(/(?: copy(?: [0-9]+)?)+$/, "");
  const generation = / \(([0-9]+)\)$/;
  const base = legacyBase.replace(generation, "");
  let latest = BigInt(legacyBase.match(generation)?.[1] ?? 1);

  function numberedName(number) {
    const suffix = " (" + number + ")";
    return base.slice(0, 120 - suffix.length).trimEnd() + suffix;
  }

  for (const { name } of templates) {
    const match = name.match(generation);
    if (match && name === numberedName(match[1])) {
      const number = BigInt(match[1]);
      if (number > latest) latest = number;
    }
  }
  return numberedName(latest + 1n);
}

function askTemplateName(suggestion, button, submit) {
  pendingName = submit;
  $("template-name").value = suggestion;
  $("confirm-name").textContent = button;
  message("", "name-error");
  showOverwrite();
  nameDialog.showModal();
  $("template-name").select();
}

function setBusy(value) {
  busy = value;
  $("confirm-name").disabled = value;
  $("save-definition").disabled = value;
  $("delete-template").disabled = value || !selectedTemplate;
  $("confirm-delete").disabled = value;
  sessionForm.querySelector(".primary").disabled = value;
  $("edit-description").disabled = value;
  practiceDate.disabled = value;
  const count = run?.elapsed_ms.length ?? 0;
  $("add-run-interval").disabled = value || count >= 200;
  for (const button of runIntervals.querySelectorAll("button")) {
    button.disabled = value || count < 2;
  }
  for (const button of timerButtons) {
    const action = button.dataset.action;
    button.disabled = value || !run
      || (action === "previous" && run.index === 0)
      || (action === "next" && run.index === run.elapsed_ms.length - 1);
  }
}

function tick() {
  if (!run || $("running").hidden || $("practice").hidden) return;
  const runningMs = run.running_since === null ? 0 : Math.max(0, Date.now() + clockOffset - run.running_since);
  const intervalMs = run.elapsed_ms[run.index] + runningMs;
  const totalMs = run.elapsed_ms.reduce((sum, ms) => sum + ms, runningMs + run.removed_elapsed_ms);
  const remaining = run.definition.intervals[run.index].minutes * 60000 - intervalMs;
  const overtime = remaining <= 0;
  const seconds = overtime ? Math.floor(-remaining / 1000) : Math.ceil(remaining / 1000);
  $("clock").textContent = (overtime ? "+" : "-") + duration(seconds);
  $("clock").classList.toggle("overtime", overtime);
  $("elapsed-clock").textContent = duration(Math.floor(totalMs / 1000));
  const status = run.running_since === null ? "Paused" : "";
  if ($("clock-status").textContent !== status) $("clock-status").textContent = status;
  runIntervals.children[run.index].querySelector(".measure").textContent =
    duration(Math.floor(intervalMs / 1000));
}

function applyRun(state) {
  run = state.run;
  clockOffset = state.now - Date.now();
  $("setup").hidden = Boolean(run);
  $("running").hidden = !run;
  if (run) {
    const { definition, index } = run;
    $("running-name").textContent = definition.name;
    practiceDate.value = run.date;
    $("running-instrument").textContent = definition.instrument ?? "";
    $("interval-progress").textContent = "Interval " + (index + 1) + " of " + definition.intervals.length;
    $("current-interval").textContent = intervalName(definition.intervals[index], index);
    document.querySelector('[data-action="toggle"]').textContent = run.running_since === null ? "Resume" : "Pause";
    runIntervals.replaceChildren(...definition.intervals.map((interval, i) => {
      const row = record(intervalName(interval, i), interval.minutes + " min planned",
        duration(Math.floor(run.elapsed_ms[i] / 1000)));
      const controls = $("interval-fields").content.firstElementChild;
      const grip = controls.querySelector(".drag-handle").cloneNode(true);
      const remove = controls.querySelector(".remove").cloneNode(true);
      grip.setAttribute("aria-label", "Reorder " + intervalName(interval, i));
      remove.setAttribute("aria-label", "Remove " + intervalName(interval, i));
      remove.addEventListener("click", () => confirmIntervalEdit("remove_interval", { index: i }, "Save removal"));
      row.prepend(grip);
      row.append(remove);
      if (i === index) {
        row.classList.add("current");
        row.setAttribute("aria-current", "step");
      }
      return row;
    }));
  }
  setBusy(busy);
  tick();
}

async function start(data, templateName, save) {
  const state = await api("start", {
    definition: data, date: today(), template_name: templateName, save_template: save,
  });
  applyRun(state);
  showTab("practice");
}

async function action(type, extra = {}, version = run.version) {
  const state = await api("action", { action: type, version, ...extra });
  applyRun(state);
  if (type === "end") {
    resetSessionForm();
    showTab("practice");
    message("Session saved to history.");
  }
}

function resetSessionForm() {
  sessionForm.reset();
  $("session-description-disclosure").open = false;
  $("intervals").replaceChildren();
  selectTemplate(null);
  refreshIntervalFields();
}

function showTab(tab) {
  ++historyRequest;
  for (const name of ["practice", "history"]) {
    $(name).hidden = name !== tab;
    if (name === tab) $(name + "-tab").setAttribute("aria-current", "page");
    else $(name + "-tab").removeAttribute("aria-current");
  }
  message();
  tick();
}

async function openHistory() {
  showTab("history");
  const request = historyRequest;
  $("history-list").hidden = false;
  $("history-detail").hidden = true;
  try {
    const entries = await api("history");
    if (request !== historyRequest) return;
    $("empty-history").hidden = entries.length > 0;
    $("history-entries").replaceChildren(...entries.map((entry) => record(
      entry.name, dateFormat.format(new Date(entry.practiced_on)),
      duration(Math.floor(entry.total_ms / 1000)), () => openDetail(entry.id),
    )));
  } catch (error) {
    if (request === historyRequest) message(error.message);
  }
}

async function openDetail(id) {
  const request = ++historyRequest;
  try {
    const entry = await api("history/" + id);
    if (request !== historyRequest) return;
    $("detail-name").textContent = entry.name;
    $("detail-date").textContent = dateFormat.format(new Date(entry.date));
    $("detail-instrument").textContent = entry.instrument ?? "";
    $("detail-description").textContent = entry.description;
    $("detail-description").hidden = !entry.description;
    $("detail-total").textContent = duration(Math.floor(entry.total_ms / 1000));
    $("detail-intervals").replaceChildren(...entry.intervals.map((interval, index) => record(
      intervalName(interval, index), interval.minutes + " min planned" + (interval.removed ? " · Removed during practice" : ""),
      duration(Math.floor(interval.elapsed_ms / 1000)) + " actual",
    )));
    $("history-list").hidden = true;
    $("history-detail").hidden = false;
    $("back-history").focus();
  } catch (error) {
    if (request === historyRequest) message(error.message);
  }
}

setupDurationFields(sessionForm);
setupDurationFields($("add-interval-form"));
sessionForm.addEventListener("input", (event) => {
  if (event.target.matches(".minutes")) updatePlannedTotal();
});
$("add-interval").addEventListener("click", () => addInterval(undefined, true));
setupIntervalReordering($("intervals"));
setupIntervalReordering(runIntervals, (index, target) =>
  confirmIntervalEdit("move_interval", { index, target }, "Save order"));
$("practice-tab").addEventListener("click", () => showTab("practice"));
$("history-tab").addEventListener("click", openHistory);
$("back-history").addEventListener("click", openHistory);
$("template-name").addEventListener("input", showOverwrite);
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

setupChoices("session-name", "template-choices", async () => {
  await loadTemplates();
  return templates;
}, useTemplate);
setupChoices("instrument", "instrument-choices", async () =>
  (await api("instruments")).map((name) => ({ name })),
({ name }) => { $("instrument").value = name; });

const themeToggle = $("theme-toggle");
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const label = dark ? "Light mode" : "Dark mode";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
}
const savedTheme = localStorage.getItem("practice-theme");
setTheme(savedTheme ? savedTheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme !== "dark");
  localStorage.setItem("practice-theme", document.documentElement.dataset.theme);
});

sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  message();
  const data = readDefinition();
  const starting = event.submitter?.value !== "save";
  if (!data.name) {
    message("Enter a session name.");
    $("session-name").focus();
    return;
  }
  if (!data.instrument) {
    message("Enter an instrument.");
    $("instrument").focus();
    return;
  }
  if (starting && !data.intervals.length) {
    message("Add at least one interval before starting.");
    $("add-interval").focus();
    return;
  }
  setBusy(true);
  try {
    await loadTemplates();
    const saved = selectedTemplate && templates.find((item) => item.name === selectedTemplate.name);
    const unchanged = saved && JSON.stringify(saved.definition) === JSON.stringify({
      ...data,
      name: data.name === saved.name ? saved.definition.name : data.name,
    });
    if (starting && unchanged) {
      await start(data, saved.name, false);
    } else {
      const suggestion = selectedTemplate && !unchanged
        ? nextTemplateName(selectedTemplate.name)
        : selectedTemplate?.name || data.name;
      askTemplateName(suggestion, starting ? "Save and start" : "Save template", async (templateName) => {
        if (starting) {
          await start(data, templateName, true);
        } else {
          const saved = await api("templates", { template_name: templateName, definition: data });
          selectTemplate({ ...saved, definition: data });
          message("Saved template “" + templateName + "”.");
        }
      });
    }
  } catch (error) {
    await report(error);
  } finally {
    setBusy(false);
  }
});

$("name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const name = $("template-name").value.trim();
  if (!name) {
    message("Enter a template name.", "name-error");
    return;
  }
  setBusy(true);
  try {
    await pendingName(name);
    nameDialog.close();
  } catch (error) {
    if (error.status === 409) {
      nameDialog.close();
      await report(error);
    } else {
      message(error.message, "name-error");
    }
  } finally {
    setBusy(false);
  }
});

$("delete-template").addEventListener("click", () => {
  if (busy || !selectedTemplate) return;
  $("delete-question").textContent = "Delete the saved template “" + selectedTemplate.name + "”?";
  message("", "delete-error");
  deleteDialog.showModal();
});

$("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !selectedTemplate) return;
  const name = selectedTemplate.name;
  setBusy(true);
  try {
    await api("templates/delete", { template_name: name });
    deleteDialog.close();
    resetSessionForm();
    $("session-name").focus();
    message("Deleted template “" + name + "”.");
  } catch (error) {
    message(error.message, "delete-error");
  } finally {
    setBusy(false);
  }
});

for (const button of timerButtons) {
  button.addEventListener("click", async () => {
    if (busy || !run) return;
    setBusy(true);
    message();
    try {
      await action(button.dataset.action);
    } catch (error) {
      await report(error);
    } finally {
      setBusy(false);
    }
  });
}

practiceDate.addEventListener("change", async () => {
  if (busy || !run) return;
  if (!practiceDate.validity.valid) {
    practiceDate.value = run.date;
    return;
  }
  if (practiceDate.value === run.date) return;
  setBusy(true);
  message();
  try {
    await action("set_date", { date: practiceDate.value });
  } catch (error) {
    practiceDate.value = run.date;
    await report(error);
  } finally {
    setBusy(false);
  }
});

$("edit-description").addEventListener("click", () => {
  $("interval-description").value = run.definition.intervals[run.index].description;
  descriptionDialog.showModal();
});

$("description-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !run) return;
  const description = $("interval-description").value.trim();
  descriptionDialog.close();
  if (description !== run.definition.intervals[run.index].description) {
    await confirmIntervalEdit("describe", { description }, "Save description");
  }
});

$("add-run-interval").addEventListener("click", () => {
  const form = $("add-interval-form");
  form.reset();
  form.elements.minutes.setCustomValidity("");
  addIntervalDialog.showModal();
});

$("add-interval-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { minutes, description } = event.currentTarget.elements;
  const interval = { minutes: Number(minutes.value), description: description.value.trim() };
  addIntervalDialog.close();
  await confirmIntervalEdit("add_interval", { interval }, "Save new interval");
});

async function confirmIntervalEdit(type, fields, label) {
  if (busy || !run) return;
  const { version, template_name } = run;
  setBusy(true);
  try {
    await loadTemplates();
    askTemplateName(nextTemplateName(template_name), label, (templateName) =>
      action(type, { ...fields, template_name: templateName }, version));
  } catch (error) {
    message(error.message);
  } finally {
    setBusy(false);
  }
}

try {
  applyRun(await api("active"));
  $("practice").hidden = false;
  tick();
} catch (error) {
  message(error.message);
}
setInterval(tick, 150);
document.addEventListener("visibilitychange", tick);
