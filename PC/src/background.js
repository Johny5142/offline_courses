const STATE_KEY = "offlineStepikState";
const DEFAULT_STATE = {
  status: "idle",
  tabId: null,
  course: null,
  navigation: { sections: [], progress: [] },
  steps: [],
  visited: [],
  currentUrl: null,
  error: null,
  startedAt: null,
  updatedAt: null
};

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...DEFAULT_STATE, ...(stored[STATE_KEY] || {}) };
}

async function setState(next) {
  const state = { ...(await getState()), ...next, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

async function fetchOfflineImage(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "ucarecdn.stepik.net") {
    throw new Error("Разрешено сохранять изображения только с CDN Stepik.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url.href, { credentials: "omit", signal: controller.signal });
    if (!response.ok) throw new Error(`CDN вернул HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error("CDN вернул не изображение.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Размер изображения превышает 8 МБ.");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } finally {
    clearTimeout(timeout);
  }
}

function notifyPopup(state) {
  chrome.runtime.sendMessage({ type: "STATUS", state }).catch(() => {});
}

async function sendCollect(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "COLLECT_STEP" });
    if (response && response.ok === false) {
      const state = await setState({
        status: "paused",
        error: `Не удалось прочитать страницу: ${response.error || "неизвестная ошибка"}`
      });
      notifyPopup(state);
    }
  } catch (error) {
    try {
      // Tabs that were already open when the extension was installed or
      // reloaded do not receive static content scripts. Inject it on demand.
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
      // PAGE_READY normally triggers another collection request. Send one
      // directly as well so startup does not depend on that notification
      // winning a race with the service worker's current message handler.
      await chrome.tabs.sendMessage(tabId, { type: "COLLECT_STEP" });
    } catch (injectError) {
      const state = await setState({
        status: "failed",
        error: `Не удалось подключиться к странице. Обновите вкладку Stepik и запустите сбор ещё раз. (${injectError.message || "ошибка подключения"})`
      });
      notifyPopup(state);
    }
  }
}

function routeKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value;
  }
}

function hasStepMarkup(html) {
  return /class\s*=\s*["'][^"']*\b(?:step-view|step-show|step-wrapper|html-content)\b/i.test(html || "");
}

function isCourseLessonUrl(value) {
  try { return /^\/lesson\/\d+\/?$/.test(new URL(value).pathname); }
  catch { return false; }
}

function mergeNavigation(existing = { sections: [], progress: [] }, incoming = {}) {
  const cleanSection = (section) => ({
    ...section,
    lessons: (section.lessons || []).filter((lesson) => isCourseLessonUrl(lesson.url))
  });
  const sections = new Map((existing.sections || []).map((raw) => {
    const section = cleanSection(raw);
    return [section.id, section];
  }));
  for (const rawSection of incoming.sections || []) {
    const section = cleanSection(rawSection);
    const prior = sections.get(section.id);
    if (!prior) {
      sections.set(section.id, section);
      continue;
    }
    const lessons = new Map((prior.lessons || []).map((lesson) => [lesson.id, lesson]));
    for (const lesson of section.lessons || []) {
      const oldLesson = lessons.get(lesson.id);
      if (!oldLesson) {
        lessons.set(lesson.id, lesson);
        continue;
      }
      const steps = new Map([...(oldLesson.steps || []), ...(lesson.steps || [])].map((step) => [routeKey(step.url), step]));
      lessons.set(lesson.id, { ...oldLesson, ...lesson, steps: [...steps.values()].sort((a, b) => a.order - b.order) });
    }
    sections.set(section.id, {
      ...prior,
      ...section,
      lessons: [...lessons.values()].sort((a, b) => a.order - b.order)
    });
  }
  const progress = new Map([...(existing.progress || []), ...(incoming.progress || [])].map((step) => [routeKey(step.url), step]));
  return {
    sections: [...sections.values()].sort((a, b) => a.order - b.order),
    progress: [...progress.values()].sort((a, b) => a.order - b.order)
  };
}

async function advance(tabId, step) {
  const state = await getState();
  const candidates = Array.isArray(step.nextUrls) ? step.nextUrls : step.nextUrl ? [step.nextUrl] : [];
  const visitedRoutes = new Set(state.visited.map(routeKey));
  const nextUrl = candidates.find((candidate) => !visitedRoutes.has(routeKey(candidate)));
  if (nextUrl) {
    await setState({ currentUrl: nextUrl });
    await chrome.tabs.update(tabId, { url: nextUrl });
    return;
  }

  if (step.canClickNext) {
    await setState({ currentUrl: step.sourceUrl });
    try {
      await chrome.tabs.sendMessage(tabId, { type: "CLICK_NEXT" });
      return;
    } catch (error) {
      // Fall through to a visible paused state if the page cannot navigate.
    }
  }
  const paused = await setState({
    status: "paused",
    currentUrl: step.sourceUrl,
    error: candidates.length
      ? "Найдены только уже посещённые переходы. Курс не отмечен завершённым; перейдите в следующий раздел вручную и продолжите."
      : formatNavigationError(step.navigationDebug)
  });
  notifyPopup(paused);
}

function formatNavigationError(debug) {
  if (!debug) return "Шаг сохранён, но переход дальше не найден. Перейдите к следующему шагу вручную и продолжите сбор.";
  return `Шаг сохранён, переход не найден после ожидания ${debug.waitedMs} мс (${debug.route}; ссылок на шаги: ${debug.stepLinks}; прогресс: ${debug.progress}; активных маркеров: ${debug.activeMarkers}; рядов прогресса: ${debug.compactRows}; подписанных кнопок: ${debug.nextLabels}).`;
}

async function saveStep(tabId, payload) {
  const state = await getState();
  if (state.status !== "running" || state.tabId !== tabId) return;

  const stepId = payload.id || payload.sourceUrl;
  const duplicateIndex = state.steps.findIndex((step) => routeKey(step.sourceUrl) === routeKey(payload.sourceUrl)
    || (!step.sourceUrl && step.id === stepId));
  const previous = duplicateIndex >= 0 ? state.steps[duplicateIndex] : null;
  const shouldReplace = previous && hasStepMarkup(payload.html)
    && (!hasStepMarkup(previous.html) || payload.html.length > previous.html.length);
  const steps = duplicateIndex < 0
    ? [...state.steps, { ...payload, order: state.steps.length }]
    : shouldReplace
      ? state.steps.map((step, index) => index === duplicateIndex ? { ...payload, order: step.order } : step)
      : state.steps;
  const visited = [...new Set([...state.visited, payload.sourceUrl])];
  const detectedCourse = {
    id: payload.courseId || "unknown",
    title: payload.courseTitle || "Курс Stepik",
    author: payload.author || "",
    sourceUrl: payload.courseUrl || payload.sourceUrl
  };
  const course = !state.course || state.course.id === "unknown-course" || state.course.id === "unknown"
    ? detectedCourse
    : state.course.id === detectedCourse.id
      ? { ...state.course, ...detectedCourse, title: detectedCourse.title || state.course.title }
      : state.course;
  const navigation = mergeNavigation(state.navigation, payload.navigation);
  const next = await setState({ steps, visited, course, navigation, currentUrl: payload.sourceUrl });
  notifyPopup(next);
  await advance(tabId, payload);
}

async function start(tab) {
  const oldState = await getState();
  const routeAlreadyVisited = oldState.visited.some((url) => routeKey(url) === routeKey(tab.url));
  const stoppedRunOnSamePage = ["idle", "completed", "failed"].includes(oldState.status) && routeAlreadyVisited;
  const resume = oldState.steps.length > 0 && (oldState.status === "paused" || stoppedRunOnSamePage);
  const nextState = resume
    ? await setState({ status: "running", tabId: tab.id, currentUrl: tab.url, error: null })
    : await setState({
        ...DEFAULT_STATE,
        status: "running",
        tabId: tab.id,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
  notifyPopup(nextState);
  await sendCollect(tab.id);
}

async function exportPack() {
  const state = await getState();
  if (!state.steps.length) throw new Error("Пока нет сохранённых шагов.");
  const steps = state.steps.map((step, index) => ({ ...step, order: index }));
  const savedByRoute = new Map(steps.map((step) => [routeKey(step.sourceUrl), step]));
  const navigation = {
    sections: (state.navigation?.sections || []).map((section) => ({
      ...section,
      lessons: (section.lessons || []).filter((lesson) => isCourseLessonUrl(lesson.url)).map((lesson) => {
        const lessonSteps = (lesson.steps || []).map((step) => {
          const saved = savedByRoute.get(routeKey(step.url));
          return { ...step, saved: Boolean(saved), savedStepId: saved?.id || null };
        });
        const lessonSavedSteps = steps.filter((step) => {
          try { return new URL(step.sourceUrl).pathname.startsWith(`/lesson/${lesson.id.replace("lesson:", "")}/`); }
          catch { return false; }
        });
        return { ...lesson, steps: lessonSteps, savedCount: lessonSavedSteps.length };
      })
    })),
    progress: (state.navigation?.progress || []).map((step) => {
      const saved = savedByRoute.get(routeKey(step.url));
      return { ...step, saved: Boolean(saved), savedStepId: saved?.id || null };
    })
  };
  const pack = {
    format: "stepikpack",
    schemaVersion: 2,
    packageId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    complete: state.status === "completed",
    course: state.course || { id: "unknown", title: "Курс Stepik", author: "", sourceUrl: "" },
    navigation,
    steps,
    report: {
      status: state.status,
      savedSteps: state.steps.length,
      visitedPages: state.visited.length,
      error: state.error
    }
  };
  const content = JSON.stringify(pack, null, 2);
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(content);
  await chrome.downloads.download({
    url,
    filename: `offline-stepik-${Date.now()}.stepikpack`,
    saveAs: true
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "GET_STATUS") {
        sendResponse({ ok: true, state: await getState() });
      } else if (message.type === "FETCH_IMAGE") {
        sendResponse({ ok: true, dataUrl: await fetchOfflineImage(message.url) });
      } else if (message.type === "START") {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab?.id || !/^https:\/\/(www\.)?stepik\.org\//.test(tab.url || "")) {
          throw new Error("Откройте курс на stepik.org в активной вкладке.");
        }
        await start(tab);
        sendResponse({ ok: true });
      } else if (message.type === "PAUSE") {
        const state = await setState({ status: "paused" });
        notifyPopup(state);
        sendResponse({ ok: true });
      } else if (message.type === "STOP") {
        const state = await setState({ status: "idle", tabId: null });
        notifyPopup(state);
        sendResponse({ ok: true });
      } else if (message.type === "CLEAR") {
        const state = await setState({ ...DEFAULT_STATE });
        notifyPopup(state);
        sendResponse({ ok: true });
      } else if (message.type === "EXPORT") {
        await exportPack();
        sendResponse({ ok: true });
      } else if (message.type === "STEP_DATA" && sender.tab?.id) {
        await saveStep(sender.tab.id, message.step);
        sendResponse({ ok: true });
      } else if (message.type === "STEP_ERROR" && sender.tab?.id) {
        const state = await getState();
        if (state.tabId === sender.tab.id && state.status === "running") {
          const paused = await setState({
            status: "paused",
            currentUrl: message.url || state.currentUrl,
            error: message.error || "Не удалось дождаться загрузки шага."
          });
          notifyPopup(paused);
        }
        sendResponse({ ok: true });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "PAGE_READY" || !sender.tab?.id) return;
  getState().then((state) => {
    if (state.status === "running" && state.tabId === sender.tab.id) {
      sendCollect(sender.tab.id);
    }
  });
});
