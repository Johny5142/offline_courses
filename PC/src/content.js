function absoluteUrl(value) {
  try { return new URL(value, location.href).href; } catch { return value; }
}

function pickRoot() {
  const lessonContent = document.querySelector(".step-show .step-view")
    || document.querySelector(".step-show")
    || document.querySelector(".step-view");
  if (lessonContent) return lessonContent;
  // On a Stepik step route, the app shell/footer can contain enough text to
  // look ready while the lesson is still showing its loading skeleton.
  if (/^\/lesson\/\d+(?:\/step\/\d+)?\/?$/.test(location.pathname)) return null;
  return document.querySelector("main") || document.querySelector("article") || document.querySelector(".step") || document.body;
}

function sourceId() {
  const step = location.pathname.match(/\/step\/(\d+)/);
  const lesson = location.pathname.match(/\/lesson\/(\d+)/);
  return step && lesson ? `step:${lesson[1]}:${step[1]}` : lesson ? `lesson:${lesson[1]}` : location.href;
}

function courseId() {
  const sidebarLink = document.querySelector(".lesson-sidebar__course-title[href]");
  const sidebarMatch = sidebarLink?.getAttribute("href")?.match(/\/course\/(\d+)/);
  if (sidebarMatch) return `course:${sidebarMatch[1]}`;
  const match = location.pathname.match(/\/course\/(\d+)/);
  return match ? `course:${match[1]}` : "unknown-course";
}

function courseUrl() {
  const sidebarLink = document.querySelector(".lesson-sidebar__course-title[href]");
  if (sidebarLink) {
    try {
      const url = new URL(sidebarLink.getAttribute("href"), location.href);
      return `${url.origin}${url.pathname.replace(/\/?$/, "/")}`;
    } catch { /* Fall back to the current course route. */ }
  }
  const match = location.pathname.match(/\/course\/\d+/);
  return match ? new URL(match[0] + "/", location.origin).href : location.origin;
}

function navigationSnapshot() {
  const courseLink = document.querySelector(".lesson-sidebar__course-title[href]");
  const headers = [...document.querySelectorAll(".lesson-sidebar__module-header")];
  const tocContainers = [...document.querySelectorAll(".lesson-sidebar__toc-inner")];
  const sections = headers.map((header, sectionOrder) => {
    const sectionId = header.getAttribute("data-section") || `section-${sectionOrder + 1}`;
    const title = (header.querySelector(".sidebar-module-header__title")?.textContent || header.textContent || "Раздел")
      .replace(/\s+/g, " ").trim();
    const container = tocContainers.find((node) => node.getAttribute("data-section") === sectionId);
    const lessonNodes = container ? [...container.querySelectorAll("a[href]")].filter((anchor) => {
      try {
        const url = new URL(anchor.href || anchor.getAttribute("href"), location.href);
        return url.origin === location.origin && /^\/lesson\/\d+\/?$/.test(url.pathname);
      } catch { return false; }
    }) : [];
    const lessons = lessonNodes.map((anchor, order) => {
      let url;
      try { url = new URL(anchor.getAttribute("href"), location.href); } catch { return null; }
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/\/lesson\/(\d+)(?:\/step\/([^/]+))?/);
      if (!match) return null;
      const name = anchor.querySelector(".lesson-sidebar__lesson-name")?.textContent || anchor.textContent;
      return {
        id: `lesson:${match[1]}`,
        title: (name || `Урок ${order + 1}`).replace(/\s+/g, " ").trim(),
        url: `${url.origin}${url.pathname}`,
        order,
        steps: []
      };
    }).filter(Boolean);
    return { id: `section:${sectionId}`, title, order: sectionOrder, lessons };
  });

  const currentLessonId = location.pathname.match(/\/lesson\/(\d+)/)?.[1];
  const progress = [...document.querySelectorAll("a[href]")].flatMap((anchor) => {
    let url;
    try { url = new URL(anchor.getAttribute("href"), location.href); } catch { return []; }
    if (url.origin !== location.origin) return [];
    const match = url.pathname.match(/\/lesson\/(\d+)\/step\/([^/]+)/);
    if (!match || match[1] !== currentLessonId) return [];
    return [{
      id: `step:${match[1]}:${match[2]}`,
      title: (anchor.getAttribute("aria-label") || anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim() || `Шаг ${match[2]}`,
      url: `${url.origin}${url.pathname}`,
      order: Number(match[2]) || 0
    }];
  });
  const uniqueProgress = [...new Map(progress.map((item) => [item.url, item])).values()]
    .sort((a, b) => a.order - b.order);
  const currentLesson = sections.flatMap((section) => section.lessons).find((lesson) => lesson.id === `lesson:${currentLessonId}`);
  if (currentLesson) currentLesson.steps = uniqueProgress;

  let title = courseLink?.textContent?.replace(/\s+/g, " ").trim() || "";
  let id = courseId();
  let url = courseUrl();
  if (courseLink) {
    try {
      const parsed = new URL(courseLink.getAttribute("href"), location.href);
      const match = parsed.pathname.match(/\/course\/(\d+)/);
      if (match) id = `course:${match[1]}`;
      url = `${parsed.origin}${parsed.pathname.replace(/\/?$/, "/")}`;
    } catch { /* Keep fallback metadata. */ }
  }
  return {
    course: { id, title, sourceUrl: url },
    navigation: { sections, progress: uniqueProgress }
  };
}

function nextLabelMatches(node) {
  const label = [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title")]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  return /следующ(?:ий|ая|ее)|дальше|далее|продолжить|next(?:\s+(?:step|lesson))?/.test(label);
}

function findNextUrls() {
  const current = new URL(location.href);
  const currentRoute = current.pathname.match(/\/lesson\/(\d+)(?:\/step\/([^/]+))?/);
  if (!currentRoute) return [];

  const currentLessonId = currentRoute[1];
  const currentStepId = currentRoute[2] || null;
  const links = [...document.querySelectorAll("a[href]")]
    .filter((anchor) => anchor.getClientRects().length > 0)
    .map((anchor) => {
      const url = new URL(anchor.href, location.href);
      const match = url.pathname.match(/\/lesson\/(\d+)(?:\/step\/([^/]+))?/);
      return match && url.origin === current.origin
        ? { url, lessonId: match[1], stepId: match[2] || null }
        : null;
    })
    .filter(Boolean);
  const candidates = [];

  // Prefer links for individual steps in this lesson, such as the numbered
  // progress strip at the top of the Stepik player. Sort numeric Stepik step
  // IDs instead of trusting DOM order: repeated progress strips can wrap from
  // the last step back to an already visited first step.
  if (currentStepId) {
    const stepLinks = [...new Map(links
      .filter((link) => link.lessonId === currentLessonId && link.stepId)
      .map((link) => [`${link.lessonId}:${link.stepId}`, link])).values()];
    const currentNumber = Number(currentStepId);
    if (Number.isFinite(currentNumber) && stepLinks.every((link) => Number.isFinite(Number(link.stepId)))) {
      candidates.push(...stepLinks
        .filter((link) => Number(link.stepId) > currentNumber)
        .sort((a, b) => Number(a.stepId) - Number(b.stepId))
        .map((link) => link.url.href));
    } else {
      const currentIndex = stepLinks.findIndex((link) => link.stepId === currentStepId);
      if (currentIndex >= 0) candidates.push(...stepLinks.slice(currentIndex + 1).map((link) => link.url.href));
    }
  }

  // Follow only Stepik's course-outline links here. The progress strip also
  // contains links to the current lesson's steps and can appear before the
  // sidebar in the DOM; mixing both lists makes the next lesson wrap to the
  // first lesson in the course.
  const sidebarNodes = [...document.querySelectorAll(".lesson-sidebar__lesson[href]")];
  const outlineNodes = sidebarNodes.length
    ? sidebarNodes
    : [...document.querySelectorAll("a[href]")].filter((anchor) => {
        try {
          const url = new URL(anchor.href, location.href);
          return url.origin === current.origin && /^\/lesson\/\d+\/?$/.test(url.pathname);
        } catch { return false; }
      });
  const lessonLinks = [];
  const seenLessons = new Set();
  for (const anchor of outlineNodes) {
    try {
      const url = new URL(anchor.href || anchor.getAttribute("href"), location.href);
      const match = url.pathname.match(/^\/lesson\/(\d+)(?:\/step\/\d+)?\/?$/);
      if (!match || url.origin !== current.origin || seenLessons.has(match[1])) continue;
      seenLessons.add(match[1]);
      const firstStep = new URL(url.href);
      firstStep.pathname = `/lesson/${match[1]}/step/1`;
      lessonLinks.push({ url: firstStep, lessonId: match[1] });
    } catch { /* Ignore malformed outline links. */ }
  }
  const lessonIndex = lessonLinks.findIndex((link) => link.lessonId === currentLessonId);
  if (lessonIndex >= 0 && lessonLinks[lessonIndex + 1]) {
    candidates.push(...lessonLinks.slice(lessonIndex + 1).map((link) => link.url.href));
  }

  // Keep a text-based fallback for layouts that expose a labeled Next link.
  const next = [...document.querySelectorAll("a[href], button, [role=link], [role=button]")]
    .find((node) => visible(node) && nextLabelMatches(node));
  if (next?.getAttribute("href")) candidates.push(absoluteUrl(next.getAttribute("href")));
  return [...new Set(candidates)];
}

function findNextUrl() {
  return findNextUrls()[0] || null;
}

const ACTIVE_MARKER_SELECTOR = '[aria-current], [aria-selected="true"], .active, .selected, .current, [class*="active"], [class*="current"], [class*="selected"]';

function compactControlRow(siblings) {
  if (!siblings.length) return false;
  const boxes = siblings.map((sibling) => sibling.getBoundingClientRect());
  return boxes.every((box) => box.width >= 18 && box.width <= 80 && box.height >= 14 && box.height <= 60);
}

function nextSequenceControl() {
  const activeNodes = [...document.querySelectorAll(ACTIVE_MARKER_SELECTOR)].filter(visible);

  for (const active of activeNodes) {
    let node = active;
    // Stepik's progress strip can use clickable tiles instead of links. Look
    // for the next tile only in a row of small, similarly sized controls so
    // an active item in the wide course sidebar is not mistaken for a step.
    for (let depth = 0; depth < 5 && node?.parentElement; depth += 1, node = node.parentElement) {
      const siblings = [...node.parentElement.children].filter(visible);
      const index = siblings.indexOf(node);
      if (siblings.length < 4 || index < 0 || index >= siblings.length - 1) continue;
      if (!compactControlRow(siblings)) continue;
      const next = siblings[index + 1];
      if (next.disabled || next.getAttribute("aria-disabled") === "true") return null;
      return next;
    }
  }

  // Some Stepik versions expose the progress count as text but render step
  // tiles without aria-current or an active class. If we can match the total
  // count to a compact row of tiles, use the next zero-based position.
  const progress = (document.body.innerText || document.body.textContent || "")
    .match(/(\d+)\s+из\s+(\d+)\s+шаг(?:а|ов)?\s+пройдено/i);
  if (progress) {
    const completed = Number(progress[1]);
    const total = Number(progress[2]);
    if (completed > 0 && completed < total) {
      for (const row of document.querySelectorAll("body *")) {
        const siblings = [...row.children].filter(visible);
        if (siblings.length !== total || !compactControlRow(siblings)) continue;
        const next = siblings[completed];
        if (!next || next.disabled || next.getAttribute("aria-disabled") === "true") return null;
        return next;
      }
    }
  }
  return null;
}

function nextButton() {
  const labeled = [...document.querySelectorAll("a[href], button, [role=link], [role=button]")].find((node) => {
    return visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && nextLabelMatches(node);
  });
  return labeled || nextSequenceControl();
}

function navigationDiagnostics() {
  const current = new URL(location.href);
  const stepLinks = [...document.querySelectorAll("a[href]")].filter((anchor) => {
    try { return new URL(anchor.href, location.href).origin === current.origin && /\/lesson\/\d+\/step\/[^/]+/.test(new URL(anchor.href, location.href).pathname); }
    catch { return false; }
  }).length;
  const markers = [...document.querySelectorAll(ACTIVE_MARKER_SELECTOR)].filter(visible).length;
  const progress = (document.body.innerText || document.body.textContent || "")
    .match(/(\d+)\s+из\s+(\d+)\s+шаг(?:а|ов)?\s+пройдено/i);
  const progressRows = progress
    ? [...document.querySelectorAll("body *")].filter((row) => {
        const children = [...row.children].filter(visible);
        return children.length === Number(progress[2]) && compactControlRow(children);
      }).length
    : 0;
  const labeledNext = [...document.querySelectorAll("a[href], button, [role=link], [role=button]")]
    .filter((node) => visible(node) && nextLabelMatches(node)).length;
  return {
    route: current.pathname,
    stepLinks,
    activeMarkers: markers,
    progress: progress ? `${progress[1]}/${progress[2]}` : "нет",
    compactRows: progressRows,
    nextLabels: labeledNext
  };
}

function waitForNavigationControl(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (found) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timeout);
      observer.disconnect();
      resolve(found);
    };
    const check = () => {
      if (findNextUrl() || nextButton()) finish(true);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    const poll = setInterval(check, 250);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    check();
  });
}

function removeUnsafe(root) {
  root.querySelectorAll("script, style, noscript, iframe, object, embed, form, input, textarea, select").forEach((node) => node.remove());
  root.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    });
  });
}

async function inlineImages(root) {
  const images = [...root.querySelectorAll("img[src]")];
  await Promise.all(images.map(async (image) => {
    const url = absoluteUrl(image.getAttribute("src"));
    let timeout;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: "FETCH_IMAGE", url }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Время загрузки изображения истекло")), 10000); })
      ]);
      if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Изображение не удалось сохранить");
      image.setAttribute("src", response.dataUrl);
    } catch {
      image.setAttribute("data-offline-source", url);
    } finally {
      clearTimeout(timeout);
    }
  }));
}

function questionOptions(root) {
  return [...root.querySelectorAll("label, [role=option], .answer-option, .quiz-option")]
    .map((node, index) => ({ id: node.id || `option-${index}`, text: node.textContent.replace(/\s+/g, " ").trim() }))
    .filter((option) => option.text);
}

function visible(element) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function pageFingerprint() {
  const root = pickRoot();
  if (!root) return null;
  const text = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
  // Stepik can leave a hidden/empty loader node in the DOM after the lesson
  // has rendered. A page-wide `[class*=loading]` check then blocks collection
  // forever. Judge readiness from the actual lesson content instead.
  if (/^(?:загрузка|loading)(?:…|\.{3})?$/i.test(text)) return null;
  const hasMedia = root.querySelector("img[src], video, audio, svg, [role=img]");
  if (text.length < 24 && !(hasMedia && text.length >= 4)) return null;
  return `${location.href}|${text.slice(0, 500)}|${text.slice(-120)}`;
}

function waitForStepReady(timeoutMs = 120000, stableMs = 1200) {
  return new Promise((resolve) => {
    let lastFingerprint = null;
    let stableSince = 0;
    let finished = false;

    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timeout);
      observer.disconnect();
      resolve(ready);
    };

    const check = () => {
      const fingerprint = pageFingerprint();
      if (!fingerprint) {
        lastFingerprint = null;
        stableSince = 0;
        return;
      }
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        stableSince = Date.now();
        return;
      }
      if (Date.now() - stableSince >= stableMs) finish(true);
    };

    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    const poll = setInterval(check, 250);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    check();
  });
}

async function collectStep() {
  const ready = await waitForStepReady();
  if (!ready) throw new Error("Содержимое шага Stepik не загрузилось за 2 минуты. Сохранён только уже собранный материал; повторите сбор позже.");

  const root = pickRoot();
  if (!root) throw new Error("Stepik ещё не показал содержимое шага. Повторите сбор с этой страницы.");
  const isExercise = Boolean(root.querySelector("input, [role=option], .quiz, .step__quiz"));
  const source = root.cloneNode(true);
  removeUnsafe(source);
  await inlineImages(source);
  const title = (source.querySelector("h1, h2")?.textContent || document.title || "Шаг").replace(/\s+/g, " ").trim();
  const html = source.innerHTML;
  const text = (source.textContent || "").replace(/\s+/g, " ").trim();
  const id = sourceId();
  const snapshot = navigationSnapshot();
  let nextUrls = findNextUrls();
  let nextUrl = nextUrls[0] || null;
  let nextControl = nextButton();
  let navigationWaitedMs = 0;
  if (!nextUrl && !nextControl) {
    const waitStartedAt = Date.now();
    await waitForNavigationControl();
    navigationWaitedMs = Date.now() - waitStartedAt;
    nextUrls = findNextUrls();
    nextUrl = nextUrls[0] || null;
    nextControl = nextButton();
  }
  const navigationDebug = !nextUrl && !nextControl
    ? { ...navigationDiagnostics(), waitedMs: navigationWaitedMs }
    : null;
  return {
    id,
    courseId: snapshot.course.id,
    courseUrl: snapshot.course.sourceUrl,
    courseTitle: snapshot.course.title || document.title.replace(/\s*[|—-].*$/, "").trim() || "Курс Stepik",
    navigation: snapshot.navigation,
    author: document.querySelector("meta[name='author']")?.content || "",
    lessonTitle: title,
    title,
    type: isExercise ? "exercise" : "theory",
    sourceUrl: location.href,
    html: `<article class="offline-step">${html}</article>`,
    text,
    options: questionOptions(source),
    nextUrl,
    nextUrls,
    canClickNext: Boolean(nextControl),
    navigationDebug
  };
}

let collecting = false;

function waitForContentChange(beforeUrl, beforeFingerprint, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let candidate = null;
    let stableSince = 0;
    let finished = false;
    const finish = (changed) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timeout);
      observer.disconnect();
      resolve(changed);
    };
    const check = () => {
      const fingerprint = pageFingerprint();
      const changed = location.href !== beforeUrl || (fingerprint && fingerprint !== beforeFingerprint);
      if (!changed) {
        candidate = null;
        stableSince = 0;
        return;
      }
      const nextCandidate = `${location.href}|${fingerprint || "loading"}`;
      if (candidate !== nextCandidate) {
        candidate = nextCandidate;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 800) {
        finish(true);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    const poll = setInterval(check, 250);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    check();
  });
}

async function clickNextAndWait() {
  await waitForStepReady();
  const button = nextButton();
  if (!button) throw new Error("Не нашлась кнопка перехода к следующему шагу.");
  const beforeUrl = location.href;
  const beforeFingerprint = pageFingerprint();
  button.click();
  const changed = await waitForContentChange(beforeUrl, beforeFingerprint);
  if (!changed) throw new Error("Следующий шаг не открылся за 2 минуты. Можно продолжить вручную.");
  if (location.href === beforeUrl) {
    chrome.runtime.sendMessage({ type: "PAGE_READY", url: location.href });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COLLECT_STEP") {
    sendResponse({ ok: true, accepted: true });
    if (collecting) return;
    collecting = true;
    collectStep()
      .then((step) => {
        collecting = false;
        chrome.runtime.sendMessage({ type: "STEP_DATA", step });
      })
      .catch((error) => {
        collecting = false;
        chrome.runtime.sendMessage({ type: "STEP_ERROR", error: error.message, url: location.href });
      });
    return;
  }

  if (message.type === "CLICK_NEXT") {
    sendResponse({ ok: true, accepted: true });
    clickNextAndWait().catch((error) => {
      chrome.runtime.sendMessage({ type: "STEP_ERROR", error: error.message, url: location.href });
    });
  }
});

chrome.runtime.sendMessage({ type: "PAGE_READY", url: location.href });

let lastObservedUrl = location.href;
const routeObserver = new MutationObserver(() => {
  if (location.href === lastObservedUrl) return;
  lastObservedUrl = location.href;
  chrome.runtime.sendMessage({ type: "PAGE_READY", url: location.href });
});
routeObserver.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", () => {
  if (location.href === lastObservedUrl) return;
  lastObservedUrl = location.href;
  chrome.runtime.sendMessage({ type: "PAGE_READY", url: location.href });
});
