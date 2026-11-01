import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pcDir = path.resolve(testDir, "..");
const rootDir = path.resolve(pcDir, "..");

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
const pack = readJson("PC/test/fixtures/sample.stepikpack");

function validatePack(value) {
  assert.equal(value.format, "stepikpack");
  assert.equal(value.schemaVersion, 2);
  assert.equal(typeof value.packageId, "string");
  assert.equal(typeof value.course?.id, "string");
  assert.equal(typeof value.course?.title, "string");
  assert.equal(typeof value.course?.sourceUrl, "string");
  assert.ok(Array.isArray(value.steps));
  assert.ok(Array.isArray(value.navigation?.sections));
  assert.ok(Array.isArray(value.navigation?.progress));
  value.steps.forEach((step, index) => {
    assert.equal(typeof step.id, "string");
    assert.equal(typeof step.title, "string");
    assert.equal(typeof step.sourceUrl, "string");
    assert.equal(typeof step.html, "string");
    assert.equal(typeof step.text, "string");
    assert.equal(step.order, index);
  });
}

test("Manifest V3 содержит только нужные разрешения", () => {
  const manifest = readJson("PC/manifest.json");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.8");
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(!manifest.permissions.includes("cookies"));
  assert.ok(!manifest.permissions.includes("webRequest"));
  assert.ok(manifest.host_permissions.includes("https://ucarecdn.stepik.net/*"));
  assert.ok(manifest.host_permissions.every((host) => host.includes("stepik.org") || host === "https://ucarecdn.stepik.net/*"));
});

test("Popup расширения показывает статусы и оформленные кнопки управления", () => {
  const popup = fs.readFileSync(path.join(pcDir, "src/popup.html"), "utf8");
  const script = fs.readFileSync(path.join(pcDir, "src/popup.js"), "utf8");
  assert.match(popup, /class="panel"/);
  assert.match(popup, /class="status-card" aria-live="polite"/);
  assert.match(popup, /id="start"/);
  assert.match(popup, /id="pause"/);
  assert.match(popup, /id="stop"/);
  assert.match(popup, /id="export"/);
  assert.match(popup, /id="clear"/);
  assert.match(script, /STATUS_LABELS/);
  assert.match(script, /statusCard\.dataset\.status/);
  assert.match(script, /confirm\(/);
  assert.match(script, /clear: "CLEAR"/);
});

test("Тестовый пакет соответствует контракту v2 с оглавлением", () => {
  validatePack(pack);
  assert.equal(pack.steps.length, 2);
  assert.equal(pack.steps[0].type, "theory");
  assert.equal(pack.steps[1].type, "exercise");
  assert.equal(pack.steps[1].options[0].text, "4");
  assert.equal(pack.navigation.sections[0].lessons[0].steps.length, 2);
  assert.equal(pack.navigation.progress[0].savedStepId, "step:10:1");
});

test("Сборщик получает курс, разделы, уроки и прогресс из DOM Stepik", () => {
  const textNode = (textContent) => ({ textContent });
  const link = (href, textContent, childText = textContent) => ({
    textContent,
    getAttribute: (name) => name === "href" ? href : null,
    querySelector: () => textNode(childText)
  });
  const courseLink = link("/course/5?auth=registration", "Мой курс");
  const lessonLink = link("/lesson/11?unit=20", "1.1 Введение", "1.1 Введение");
  const progressLinks = [1, 2].map((id) => link(`/lesson/11/step/${id}?unit=20`, String(id)));
  const header = {
    textContent: "1 Основы",
    getAttribute: (name) => name === "data-section" ? "section-1" : null,
    querySelector: () => textNode("1 Основы")
  };
  const toc = {
    getAttribute: (name) => name === "data-section" ? "section-1" : null,
    querySelectorAll: () => [lessonLink, ...progressLinks]
  };
  const document = {
    title: "Мой курс — Stepik",
    documentElement: {},
    querySelector: (selector) => selector === ".lesson-sidebar__course-title[href]" ? courseLink : null,
    querySelectorAll(selector) {
      if (selector === ".lesson-sidebar__module-header") return [header];
      if (selector === ".lesson-sidebar__toc-inner") return [toc];
      if (selector === "a[href]") return [courseLink, lessonLink, ...progressLinks];
      return [];
    }
  };
  const context = {
    URL,
    document,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } },
    MutationObserver: class { observe() {} disconnect() {} },
    window: { addEventListener() {} },
    location: {
      href: "https://stepik.org/lesson/11/step/2?unit=20",
      pathname: "/lesson/11/step/2",
      origin: "https://stepik.org"
    }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__snapshot = navigationSnapshot; globalThis.__sourceId = sourceId;`, context);
  const snapshot = context.__snapshot();
  assert.equal(snapshot.course.id, "course:5");
  assert.equal(snapshot.course.title, "Мой курс");
  assert.equal(snapshot.course.sourceUrl, "https://stepik.org/course/5/");
  assert.equal(snapshot.navigation.sections[0].lessons.length, 1, "прогресс-ссылки не должны попадать в список уроков");
  assert.equal(snapshot.navigation.sections[0].lessons[0].id, "lesson:11");
  assert.deepEqual(Array.from(snapshot.navigation.progress, (item) => item.id), ["step:11:1", "step:11:2"]);
  assert.equal(context.__sourceId(), "step:11:2");
  context.location.pathname = "/lesson/12/step/2";
  assert.equal(context.__sourceId(), "step:12:2", "одинаковые номера шагов в разных уроках не должны совпадать");
});

test("Фоновый процесс объединяет оглавление из снимков шагов, не теряя старые разделы", () => {
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  const context = {
    URL,
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() }
    }
  };
  vm.runInNewContext(`${source}\nglobalThis.__mergeNavigation = mergeNavigation;`, context);
  const merged = context.__mergeNavigation(
    { sections: [{ id: "s1", title: "Раздел", order: 0, lessons: [{ id: "l1", title: "Урок 1", url: "https://stepik.org/lesson/1", order: 0, steps: [] }, { id: "bad", title: "Лишний шаг", url: "https://stepik.org/lesson/1/step/3", order: 1, steps: [] }] }], progress: [] },
    { sections: [{ id: "s1", title: "Раздел", order: 0, lessons: [{ id: "l2", title: "Урок 2", url: "https://stepik.org/lesson/2", order: 1, steps: [] }] }], progress: [{ id: "step:2", title: "2", url: "https://stepik.org/lesson/2/step/2", order: 2 }] }
  );
  assert.deepEqual(Array.from(merged.sections[0].lessons, (lesson) => lesson.id), ["l1", "l2"]);
  assert.equal(merged.progress.length, 1);
});

test("Экспорт v2 связывает кликабельное оглавление с действительно сохранёнными шагами", async () => {
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  let downloaded;
  const state = {
    status: "completed",
    course: { id: "course:5", title: "Курс", author: "", sourceUrl: "https://stepik.org/course/5/" },
    steps: [{ id: "step:11:1", title: "Первый шаг", sourceUrl: "https://stepik.org/lesson/11/step/1?unit=2", html: "<article class='step-view'>Текст урока</article>", text: "Текст урока", order: 0 }],
    navigation: {
      sections: [{ id: "section:1", title: "Основы", order: 0, lessons: [{ id: "lesson:11", title: "Вводный урок", url: "https://stepik.org/lesson/11", order: 0, steps: [{ id: "step:11:1", title: "Первый", url: "https://stepik.org/lesson/11/step/1", order: 1 }, { id: "step:11:2", title: "Второй", url: "https://stepik.org/lesson/11/step/2", order: 2 }] }] }],
      progress: [{ id: "step:11:1", title: "Первый", url: "https://stepik.org/lesson/11/step/1", order: 1 }, { id: "step:11:2", title: "Второй", url: "https://stepik.org/lesson/11/step/2", order: 2 }]
    },
    visited: ["https://stepik.org/lesson/11/step/1"],
    error: null
  };
  const context = {
    URL,
    Date,
    encodeURIComponent,
    crypto: { randomUUID: () => "test-package-id" },
    chrome: {
      storage: { local: { async get() { return { offlineStepikState: state }; }, async set() {} } },
      downloads: { async download(options) { downloaded = options; } },
      runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() }
    }
  };
  vm.runInNewContext(`${source}\nglobalThis.__exportPack = exportPack;`, context);
  await context.__exportPack();
  const exported = JSON.parse(decodeURIComponent(downloaded.url.split(",")[1]));
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.navigation.sections[0].lessons[0].savedCount, 1);
  assert.equal(exported.navigation.sections[0].lessons[0].steps[0].saved, true);
  assert.equal(exported.navigation.sections[0].lessons[0].steps[0].savedStepId, "step:11:1");
  assert.equal(exported.navigation.sections[0].lessons[0].steps[1].saved, false);
});

test("Повторный сбор заменяет ранее сохранённую оболочку загрузки содержимым урока", async () => {
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  let stored = {
    offlineStepikState: {
      status: "running",
      tabId: 7,
      course: { id: "course:5", title: "Курс", author: "", sourceUrl: "https://stepik.org/course/5/" },
      steps: [{ id: "step:1", title: "Загрузка", sourceUrl: "https://stepik.org/lesson/11/step/1?unit=1", html: "<article class=\"offline-step\">загрузка...</article>", text: "загрузка...", order: 0 }],
      visited: [],
      navigation: { sections: [], progress: [] }
    }
  };
  const context = {
    URL,
    Date,
    chrome: {
      storage: { local: { async get() { return stored; }, async set(value) { stored = value; } } },
      runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() },
      tabs: { async update() {}, async sendMessage() {} }
    }
  };
  vm.runInNewContext(`${source}\nglobalThis.__saveStep = saveStep;`, context);
  await context.__saveStep(7, {
    id: "step:1",
    courseId: "course:5",
    courseTitle: "Курс",
    courseUrl: "https://stepik.org/course/5/",
    title: "Настоящий урок",
    sourceUrl: "https://stepik.org/lesson/11/step/1?unit=2",
    html: "<article class=\"offline-step\"><div class=\"step-wrapper\"><div class=\"html-content\">Полный учебный материал с достаточным текстом.</div></div></article>",
    text: "Полный учебный материал с достаточным текстом.",
    nextUrls: [],
    canClickNext: false,
    navigation: { sections: [], progress: [] }
  });
  const saved = stored.offlineStepikState.steps;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].order, 0);
  assert.match(saved[0].html, /step-wrapper/);
  assert.equal(saved[0].title, "Настоящий урок");
});

test("Шаги идут в порядке курса и имеют уникальные идентификаторы", () => {
  const ids = pack.steps.map((step) => step.id);
  assert.deepEqual(ids, [...new Set(ids)]);
  assert.deepEqual(pack.steps.map((step) => step.order), [0, 1]);
});

test("Сборщик чистит активный код страницы", () => {
  const content = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  assert.match(content, /script, style, noscript, iframe/);
  assert.match(content, /removeUnsafe/);
  assert.match(content, /type: "FETCH_IMAGE"/);
  assert.doesNotMatch(content, /oauth2\/token|api\/courses/);
});

test("Сборщик не зависает из-за пустого видимого loader-элемента рядом с готовым уроком", async () => {
  const messages = [];
  let contentListener;
  let resolveResult;
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
  const readyText = "В этом уроке объясняется ввод и вывод данных на языке Python.";
  const root = {
    innerText: readyText,
    textContent: readyText,
    innerHTML: "<p>В этом уроке объясняется ввод и вывод данных на языке Python.</p>",
    children: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    cloneNode: () => ({ ...root })
  };
  const leftoverLoader = { getClientRects: () => [{ width: 10, height: 10 }] };
  const anchors = [456, 789].map((stepId) => ({
    href: `https://stepik.org/lesson/123/step/${stepId}`,
    textContent: "",
    getAttribute: (name) => name === "href" ? `/lesson/123/step/${stepId}` : null,
    getClientRects: () => [{ width: 100, height: 20 }]
  }));
  const document = {
    title: "Урок Python | Stepik",
    body: root,
    documentElement: {},
    querySelector(selector) {
      if ([".step-show .step-view", ".step-show", ".step-view", ".html-content.rich-text-viewer", "main"].includes(selector)) return root;
      if (selector === "h1, h2") return { textContent: "Ввод и вывод данных" };
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("a[href]")) return anchors;
      if (selector.includes("class*=")) return [leftoverLoader];
      return [];
    }
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { contentListener = listener; } },
      sendMessage(message) {
        messages.push(message);
        if (message.type === "STEP_DATA" || message.type === "STEP_ERROR") resolveResult(message);
        return Promise.resolve();
      }
    }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(source, {
    AbortController,
    Date,
    URL,
    chrome,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/123/step/456",
      pathname: "/lesson/123/step/456",
      origin: "https://stepik.org"
    },
    MutationObserver: FakeMutationObserver,
    setInterval,
    clearInterval,
    setTimeout(callback, delay, ...args) {
      // Keep the production 2-minute timeout in the code while bounding a
      // negative readiness case in this test harness.
      return globalThis.setTimeout(callback, delay >= 120000 ? 1800 : delay, ...args);
    },
    clearTimeout,
    window: { addEventListener() {} }
  });

  assert.equal(typeof contentListener, "function");
  contentListener({ type: "COLLECT_STEP" }, {}, () => {});
  const result = await Promise.race([
    resultPromise,
    new Promise((resolve) => globalThis.setTimeout(() => resolve(null), 2500))
  ]);
  assert.ok(result, "скрипт должен отправить результат сбора");
  assert.equal(result.type, "STEP_DATA");
  assert.equal(result.step.text, readyText);
  assert.equal(result.step.nextUrl, anchors[1].href);
  assert.ok(messages.some((message) => message.type === "PAGE_READY"));
});

test("Сборщик не считает оболочку Stepik с текстом загрузки содержимым урока", async () => {
  const shell = {
    innerText: "Каталог Моё обучение загрузка... © 2013 — 2026. Stepik Наши условия",
    textContent: "Каталог Моё обучение загрузка... © 2013 — 2026. Stepik Наши условия",
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const lesson = {
    innerText: "Настоящий текст урока, который появился после завершения загрузки Stepik.",
    textContent: "Настоящий текст урока, который появился после завершения загрузки Stepik.",
    querySelectorAll: () => [],
    querySelector: () => null
  };
  let lessonLoaded = false;
  const document = {
    body: shell,
    documentElement: {},
    querySelector(selector) {
      if ([".step-show .step-view", ".step-show", ".step-view", ".html-content.rich-text-viewer"].includes(selector)) {
        return lessonLoaded ? lesson : null;
      }
      if (selector === "main") return shell;
      return null;
    },
    querySelectorAll: () => []
  };
  class FakeMutationObserver { observe() {} disconnect() {} }
  const context = {
    Date,
    URL,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/290248/step/3",
      pathname: "/lesson/290248/step/3",
      origin: "https://stepik.org"
    },
    MutationObserver: FakeMutationObserver,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__waitForStep = waitForStepReady; globalThis.__pickRoot = pickRoot;`, context);
  assert.equal(context.__pickRoot(), null);
  context.location.pathname = "/lesson/290248";
  assert.equal(context.__pickRoot(), null, "страница /lesson/ID не должна считаться готовой, пока Stepik показывает оболочку");
  context.location.pathname = "/lesson/290248/step/3";
  globalThis.setTimeout(() => { lessonLoaded = true; }, 300);

  const ready = await context.__waitForStep(2000, 300);
  assert.equal(ready, true);
  assert.equal(context.__pickRoot(), lesson);
});

test("Сборщик ждёт, пока Stepik позже подгрузит навигационные ссылки", async () => {
  let linksLoaded = false;
  const anchors = [456, 789].map((stepId) => ({
    href: `https://stepik.org/lesson/123/step/${stepId}`,
    textContent: "",
    getAttribute: (name) => name === "href" ? `/lesson/123/step/${stepId}` : null,
    getClientRects: () => [{ width: 100, height: 20 }]
  }));
  const root = {
    innerText: "Текст урока уже отобразился, но список шагов ещё загружается.",
    textContent: "Текст урока уже отобразился, но список шагов ещё загружается.",
    children: [],
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const document = {
    body: root,
    documentElement: {},
    querySelector: (selector) => selector === "main" ? root : null,
    querySelectorAll(selector) {
      return linksLoaded && selector.includes("a[href]") ? anchors : [];
    }
  };
  class FakeMutationObserver { observe() {} disconnect() {} }
  const context = {
    Date,
    URL,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/123/step/456",
      pathname: "/lesson/123/step/456",
      origin: "https://stepik.org"
    },
    MutationObserver: FakeMutationObserver,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__waitForNavigation = waitForNavigationControl; globalThis.__findNextUrl = findNextUrl;`, context);
  globalThis.setTimeout(() => { linksLoaded = true; }, 350);

  const found = await context.__waitForNavigation(2000);
  assert.equal(found, true);
  assert.equal(context.__findNextUrl(), anchors[1].href);
});

test("Сборщик находит следующий шаг в прогресс-полосе без href и подписи кнопки", () => {
  const root = {
    innerText: "Текст готового шага курса достаточно длинный для проверки готовности страницы.",
    textContent: "Текст готового шага курса достаточно длинный для проверки готовности страницы.",
    innerHTML: "<p>Текст шага</p>",
    children: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    cloneNode: () => ({ ...root })
  };
  const track = { children: [] };
  const tiles = Array.from({ length: 13 }, () => ({
    parentElement: track,
    textContent: "",
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{ width: 28, height: 26 }],
    getBoundingClientRect: () => ({ width: 28, height: 26 }),
    click() {}
  }));
  track.children = tiles;
  const document = {
    title: "Урок Python | Stepik",
    body: root,
    documentElement: {},
    querySelector(selector) { return selector === "main" ? root : null; },
    querySelectorAll(selector) {
      return selector.includes("aria-current") ? [tiles[2]] : [];
    }
  };
  const chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } };
  class FakeMutationObserver { observe() {} disconnect() {} }
  const context = {
    AbortController,
    Date,
    URL,
    chrome,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/123/step/456",
      pathname: "/lesson/123/step/456",
      origin: "https://stepik.org"
    },
    MutationObserver: FakeMutationObserver,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__testNextButton = nextButton();`, context);

  assert.equal(context.__testNextButton, tiles[3]);
});

test("Сборщик использует счётчик прогресса, если текущая ячейка не помечена active", () => {
  const lessonText = "3 из 13 шагов пройдено. Текст текущего шага курса отображается здесь.";
  const root = {
    innerText: lessonText,
    textContent: lessonText,
    innerHTML: "<p>Текст шага</p>",
    children: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    cloneNode: () => ({ ...root })
  };
  const track = { children: [] };
  const tiles = Array.from({ length: 13 }, () => ({
    parentElement: track,
    textContent: "",
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{ width: 28, height: 26 }],
    getBoundingClientRect: () => ({ width: 28, height: 26 }),
    click() {}
  }));
  track.children = tiles;
  const document = {
    title: "Урок Python | Stepik",
    body: root,
    documentElement: {},
    querySelector(selector) { return selector === "main" ? root : null; },
    querySelectorAll(selector) { return selector === "body *" ? [track] : []; }
  };
  const chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } };
  class FakeMutationObserver { observe() {} disconnect() {} }
  const context = {
    AbortController,
    Date,
    URL,
    chrome,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/123/step/456",
      pathname: "/lesson/123/step/456",
      origin: "https://stepik.org"
    },
    MutationObserver: FakeMutationObserver,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__testNextButton = nextButton();`, context);

  assert.equal(context.__testNextButton, tiles[3]);
});

test("На последнем шаге урока сборщик продолжает список ссылками следующих уроков", () => {
  const anchors = [
    "/lesson/290248/step/13",
    "/lesson/290248/step/1",
    "/lesson/290248?unit=0",
    "/lesson/290249?unit=1",
    "/lesson/290250?unit=2"
  ].map((href) => ({
    href: `https://stepik.org${href}`,
    textContent: "",
    getAttribute: (name) => name === "href" ? href : null,
    getClientRects: () => [{ width: 80, height: 20 }]
  }));
  const document = {
    body: { innerText: "10 из 13 шагов пройдено", textContent: "10 из 13 шагов пройдено" },
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector) => selector === ".lesson-sidebar__lesson[href]"
      ? anchors.slice(2)
      : selector.includes("a[href]") ? anchors : []
  };
  const context = {
    URL,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/290248/step/13?unit=271724",
      pathname: "/lesson/290248/step/13",
      origin: "https://stepik.org"
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__nextUrls = findNextUrls();`, context);

  assert.deepEqual(Array.from(context.__nextUrls), [
    "https://stepik.org/lesson/290249/step/1?unit=1",
    "https://stepik.org/lesson/290250/step/1?unit=2"
  ]);
});

test("Полоса шагов перед оглавлением не возвращает сборщик к первому уроку", () => {
  const makeAnchor = (href, text = "") => ({
    href: `https://stepik.org${href}`,
    textContent: text,
    getAttribute: (name) => name === "href" ? href : null,
    getClientRects: () => [{ width: 40, height: 24 }]
  });
  const progress = Array.from({ length: 14 }, (_, index) => makeAnchor(`/lesson/1044665/step/${index + 1}`, String(index + 1)));
  const outline = [
    makeAnchor("/lesson/1044812", "1.1 Предисловие"),
    makeAnchor("/lesson/1044665", "2.1 Что такое FastAPI"),
    makeAnchor("/lesson/1044666", "2.2 Настройка проекта"),
    makeAnchor("/lesson/1044667", "2.3 Конечные точки")
  ];
  const allAnchors = [...progress, ...outline];
  const document = {
    body: { innerText: "14 из 14 шагов пройдено", textContent: "14 из 14 шагов пройдено" },
    documentElement: {},
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === ".lesson-sidebar__lesson[href]") return outline;
      return selector.includes("a[href]") ? allAnchors : [];
    }
  };
  const context = {
    URL,
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: {
      href: "https://stepik.org/lesson/1044665/step/14?unit=1053239",
      pathname: "/lesson/1044665/step/14",
      origin: "https://stepik.org"
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/content.js"), "utf8");
  vm.runInNewContext(`${source}\nglobalThis.__nextUrls = findNextUrls();`, context);
  assert.equal(context.__nextUrls[0], "https://stepik.org/lesson/1044666/step/1");
  assert.ok(!context.__nextUrls.includes("https://stepik.org/lesson/1044812"));
});

test("Фоновый процесс повторно отправляет сбор после подключения к уже открытой вкладке", async () => {
  const listeners = [];
  const storage = new Map();
  let messageAttempts = 0;
  let injections = 0;
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(value) { for (const [key, item] of Object.entries(value)) storage.set(key, item); }
      }
    },
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage() { return Promise.resolve(); }
    },
    tabs: {
      async query() { return [{ id: 7, url: "https://stepik.org/lesson/123/step/456" }]; },
      async sendMessage() {
        messageAttempts += 1;
        if (messageAttempts === 1) throw new Error("Receiving end does not exist");
        return { ok: true, accepted: true };
      }
    },
    scripting: {
      async executeScript() { injections += 1; }
    },
    downloads: { async download() {} }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  vm.runInNewContext(source, { chrome, Date, crypto: { randomUUID: () => "test-id" } });
  const startListener = listeners[0];
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  startListener({ type: "START" }, {}, resolveResponse);
  const response = await Promise.race([
    responsePromise,
    new Promise((resolve) => globalThis.setTimeout(() => resolve(null), 1000))
  ]);

  assert.equal(response?.ok, true);
  assert.equal(injections, 1);
  assert.equal(messageAttempts, 2);
  assert.equal(storage.get("offlineStepikState").status, "running");
});

test("Повторный адрес шага не завершает курс, если есть непосещённый следующий урок", async () => {
  const listeners = [];
  const updates = [];
  const currentLesson = "https://stepik.org/lesson/290248/step/13?unit=271724";
  const visited = Array.from({ length: 13 }, (_, index) => `https://stepik.org/lesson/290248/step/${index + 1}?unit=271724`);
  const storage = new Map([[
    "offlineStepikState",
    { status: "running", tabId: 77, course: { id: "test", title: "Course", author: "", sourceUrl: currentLesson },
      steps: [], visited, currentUrl: currentLesson, error: null }
  ]]);
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(value) { for (const [key, item] of Object.entries(value)) storage.set(key, item); }
      }
    },
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage() { return Promise.resolve(); }
    },
    tabs: {
      async update(_tabId, options) { updates.push(options.url); },
      async sendMessage() { return { ok: true }; }
    },
    scripting: { async executeScript() {} },
    downloads: { async download() {} }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  vm.runInNewContext(source, { chrome, Date, URL });
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  listeners[0]({
    type: "STEP_DATA",
    step: {
      id: "step:13",
      sourceUrl: currentLesson,
      courseId: "test",
      courseTitle: "Course",
      courseUrl: "https://stepik.org/course/58852/",
      title: "Последний шаг урока",
      html: "<p>Урок</p>",
      text: "Урок",
      nextUrl: visited[0],
      nextUrls: [visited[0], "https://stepik.org/lesson/290249/step/1"],
      canClickNext: false
    }
  }, { tab: { id: 77 } }, resolveResponse);
  const response = await Promise.race([
    responsePromise,
    new Promise((resolve) => globalThis.setTimeout(() => resolve(null), 1000))
  ]);

  assert.equal(response?.ok, true);
  assert.deepEqual(updates, ["https://stepik.org/lesson/290249/step/1"]);
  assert.equal(storage.get("offlineStepikState").status, "running");
});

test("Продолжение завершённого запуска сохраняет собранные шаги на той же странице", async () => {
  const listeners = [];
  const currentUrl = "https://stepik.org/lesson/290248/step/13?auth=registration&unit=271724";
  const oldSteps = Array.from({ length: 13 }, (_, index) => ({ id: `step:${index + 1}`, title: `Шаг ${index + 1}` }));
  const storage = new Map([[
    "offlineStepikState",
    { status: "completed", tabId: 7, course: { id: "course:58852", title: "Course", author: "", sourceUrl: "https://stepik.org/course/58852/" },
      steps: oldSteps, visited: ["https://stepik.org/lesson/290248/step/13"], currentUrl: null, error: null, startedAt: "old" }
  ]]);
  let collectMessages = 0;
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(value) { for (const [key, item] of Object.entries(value)) storage.set(key, item); }
      }
    },
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage() { return Promise.resolve(); }
    },
    tabs: {
      async query() { return [{ id: 7, url: currentUrl }]; },
      async sendMessage(_tabId, message) { if (message.type === "COLLECT_STEP") collectMessages += 1; return { ok: true }; }
    },
    scripting: { async executeScript() {} },
    downloads: { async download() {} }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  vm.runInNewContext(source, { chrome, Date, URL });
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  listeners[0]({ type: "START" }, {}, resolveResponse);
  const response = await Promise.race([
    responsePromise,
    new Promise((resolve) => globalThis.setTimeout(() => resolve(null), 1000))
  ]);
  const state = storage.get("offlineStepikState");

  assert.equal(response?.ok, true);
  assert.equal(state.status, "running");
  assert.equal(state.steps.length, 13);
  assert.equal(state.startedAt, "old");
  assert.equal(collectMessages, 1);
});

test("После остановки можно продолжить сохранённый сбор с уже посещённой страницы", async () => {
  const currentUrl = "https://stepik.org/lesson/1044665/step/14?unit=1053239";
  const storage = new Map([["offlineStepikState", {
    status: "idle",
    tabId: null,
    course: { id: "course:179694", title: "FastAPI", author: "", sourceUrl: "https://stepik.org/course/179694/" },
    steps: [{ id: "step:1044665:14", title: "Шаг 14" }],
    visited: ["https://stepik.org/lesson/1044665/step/14?auth=registration&unit=1053239"],
    currentUrl,
    error: null
  }]]);
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(value) { for (const [key, item] of Object.entries(value)) storage.set(key, item); }
      }
    },
    runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() },
    tabs: { async sendMessage() { return { ok: true }; } },
    scripting: { async executeScript() {} }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  const context = { chrome, Date, URL };
  vm.runInNewContext(`${source}\nglobalThis.__start = start;`, context);
  await context.__start({ id: 44, url: currentUrl });
  const saved = storage.get("offlineStepikState");
  assert.equal(saved.status, "running");
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].id, "step:1044665:14");
});

test("CLEAR удаляет локальные шаги, оглавление и привязку к активной вкладке", async () => {
  const listeners = [];
  const storage = new Map([["offlineStepikState", {
    status: "running",
    tabId: 9,
    course: { id: "course:9", title: "Курс", sourceUrl: "https://stepik.org/course/9/" },
    navigation: { sections: [{ id: "section:1" }], progress: [{ id: "step:1" }] },
    steps: [{ id: "step:9:1", html: "контент" }],
    visited: ["https://stepik.org/lesson/9/step/1"],
    currentUrl: "https://stepik.org/lesson/9/step/1"
  }]]);
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(value) { for (const [key, item] of Object.entries(value)) storage.set(key, item); }
      }
    },
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage: () => Promise.resolve()
    }
  };
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  vm.runInNewContext(source, { chrome, Date, URL });
  const responsePromise = new Promise((resolve) => listeners[0]({ type: "CLEAR" }, {}, resolve));
  const response = await Promise.race([
    responsePromise,
    new Promise((resolve) => globalThis.setTimeout(() => resolve(null), 1000))
  ]);
  const cleared = storage.get("offlineStepikState");
  assert.equal(response?.ok, true);
  assert.equal(cleared.status, "idle");
  assert.equal(cleared.tabId, null);
  assert.equal(cleared.course, null);
  assert.deepEqual(Array.from(cleared.steps), []);
  assert.deepEqual(Array.from(cleared.navigation.sections), []);
  assert.deepEqual(Array.from(cleared.visited), []);
});

test("Фоновый процесс сохраняет изображения только с CDN Stepik без cookies", async () => {
  const source = fs.readFileSync(path.join(pcDir, "src/background.js"), "utf8");
  const context = {
    AbortController,
    URL,
    Uint8Array,
    btoa,
    setTimeout,
    clearTimeout,
    fetch: async (_url, options) => ({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      options
    }),
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() }
    }
  };
  vm.runInNewContext(`${source}\nglobalThis.__fetchOfflineImage = fetchOfflineImage;`, context);

  const dataUrl = await context.__fetchOfflineImage("https://ucarecdn.stepik.net/image.png");
  assert.equal(dataUrl, "data:image/png;base64,AQID");
  await assert.rejects(context.__fetchOfflineImage("https://example.com/image.png"), /только с CDN Stepik/);
});

test("Android-проект рассчитан на Android 10 и не просит INTERNET", () => {
  const gradle = fs.readFileSync(path.join(rootDir, "Android/app/build.gradle.kts"), "utf8");
  const manifest = fs.readFileSync(path.join(rootDir, "Android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(gradle, /minSdk\s*=\s*29/);
  assert.match(gradle, /targetSdk\s*=\s*35/);
  assert.doesNotMatch(manifest, /android\.permission\.INTERNET/);
});

test("Android parser принимает тот же формат, который экспортирует PC", () => {
  const parser = fs.readFileSync(path.join(rootDir, "Android/app/src/main/java/com/offlinestepik/PackParser.kt"), "utf8");
  assert.match(parser, /stepikpack/);
  assert.match(parser, /schemaVersion/);
  assert.match(parser, /optJSONArray\("steps"\)/);
  validatePack(pack);
});

test("Android-читалка оформляет шаги без сети и распознаёт экспортированный экран загрузки", () => {
  const main = fs.readFileSync(path.join(rootDir, "Android/app/src/main/java/com/offlinestepik/MainActivity.kt"), "utf8");
  assert.match(main, /hasSavedStepContent/);
  assert.match(main, /step-view\|step-show\|step-wrapper\|html-content/);
  assert.match(main, /visibleText\.length >= 24 \|\| hasMedia/);
  assert.match(main, /File\(context\.filesDir, "courses"\)/);
  assert.match(main, /savePack\(context, imported, raw\)/);
  assert.match(main, /PackParser\.parse\(existingPack\.readText\(\)\)\.courseId == pack\.courseId/);
  assert.match(main, /OutlinedButton\(/);
  assert.match(main, /section\.lessons/);
  assert.match(main, /AlertDialog\(/);
  assert.match(main, /private fun deletePack\(/);
  assert.match(main, /Курс «\$\{course\.pack\.title\}» и его локальная папка будут удалены/);
  assert.match(main, /#player-lesson-sidebar, \.lesson-sidebar/);
  assert.match(main, /img\[data-offline-source\]/);
  assert.doesNotMatch(main, /android\.permission\.INTERNET/);
});

test("Android-читалка показывает навигацию между сохранёнными шагами и уроками", () => {
  const main = fs.readFileSync(path.join(rootDir, "Android/app/src/main/java/com/offlinestepik/MainActivity.kt"), "utf8");
  assert.match(main, /targets = readerTargets/);
  assert.match(main, /private fun buildReaderTargets\(pack: CoursePack\)/);
  assert.match(main, /private fun ReaderNavigationButton\(/);
  assert.match(main, /"Следующий шаг"/);
  assert.match(main, /"Следующий урок"/);
  assert.match(main, /"Предыдущий шаг"/);
  assert.match(main, /"Предыдущий урок"/);
  assert.match(main, /val enabled = destinationStep != null/);
  assert.match(main, /targets\.getOrNull\(currentIndex \+ 1\)/);
});
