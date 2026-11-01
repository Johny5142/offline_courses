const statusNode = document.querySelector("#status");
const stateTitleNode = document.querySelector("#state-title");
const statusCard = document.querySelector(".status-card");
const errorNode = document.querySelector("#error");
const STATUS_LABELS = {
  idle: "Ожидает запуска",
  running: "Сбор выполняется",
  paused: "Сбор на паузе",
  completed: "Сбор завершён",
  failed: "Не удалось подключиться"
};

function call(type) {
  return chrome.runtime.sendMessage({ type });
}

function render(state) {
  statusCard.dataset.status = state.status || "idle";
  stateTitleNode.textContent = STATUS_LABELS[state.status] || "Состояние сбора";
  statusNode.textContent = `Сохранено шагов: ${state.steps?.length || 0}`;
  statusNode.textContent += `\n${state.course?.title || "Открой курс на Stepik"}`;
  errorNode.textContent = state.error || "";
  document.querySelector("#start").textContent = ["paused", "completed"].includes(state.status) && state.steps?.length
    ? "Продолжить с текущей страницы"
    : "Начать сбор с текущей страницы";
  document.querySelector("#pause").disabled = state.status !== "running";
  document.querySelector("#export").disabled = !(state.steps?.length);
  document.querySelector("#clear").disabled = !(state.steps?.length || state.course || state.navigation?.sections?.length);
}

async function refresh() {
  const response = await call("GET_STATUS");
  if (response?.ok) render(response.state);
}

for (const id of ["start", "pause", "stop", "export", "clear"]) {
  document.querySelector(`#${id}`).addEventListener("click", async () => {
    if (id === "clear" && !confirm("Очистить все сохранённые шаги и оглавление курса в расширении?")) return;
    errorNode.textContent = "";
    const messageTypes = { start: "START", pause: "PAUSE", stop: "STOP", export: "EXPORT", clear: "CLEAR" };
    const response = await call(messageTypes[id]);
    if (!response?.ok) errorNode.textContent = response?.error || "Неизвестная ошибка";
    await refresh();
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS") render(message.state);
});

refresh();
