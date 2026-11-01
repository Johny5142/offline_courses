package com.offlinestepik

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONException
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OfflineStepikApp() }
    }
}

private data class StoredCourse(val folder: String, val pack: CoursePack)

private data class ReaderTarget(
    val lessonId: String,
    val lessonTitle: String,
    val title: String,
    val url: String,
    val step: OfflineStep?
)

@Composable
private fun OfflineStepikApp() {
    val context = LocalContext.current
    var courses by remember { mutableStateOf<List<StoredCourse>>(emptyList()) }
    var selectedCourseFolder by remember { mutableStateOf<String?>(null) }
    var selectedStep by remember { mutableStateOf<OfflineStep?>(null) }
    var errorMessage by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }

    fun refreshLibrary() {
        courses = readLibrary(context)
    }

    LaunchedEffect(Unit) {
        refreshLibrary()
        if (courses.isEmpty()) {
            val legacy = File(context.filesDir, "course.stepikpack")
            if (legacy.exists()) {
                try {
                    val oldPack = PackParser.parse(legacy.readText())
                    savePack(context, oldPack, legacy.readText())
                    refreshLibrary()
                } catch (exception: Exception) {
                    errorMessage = "Сохранённый пакет не удалось открыть: ${exception.message}"
                }
            }
        }
    }

    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            val raw = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                ?: throw IllegalStateException("Не удалось прочитать файл.")
            val imported = PackParser.parse(raw)
            val folder = savePack(context, imported, raw)
            refreshLibrary()
            selectedCourseFolder = folder
            selectedStep = null
            query = ""
            errorMessage = ""
        } catch (exception: JSONException) {
            errorMessage = "Повреждённый или неполный stepikpack: ${exception.message}"
        } catch (exception: IllegalArgumentException) {
            errorMessage = exception.message ?: "Неподдерживаемый пакет."
        } catch (exception: Exception) {
            errorMessage = "Ошибка импорта: ${exception.message}"
        }
    }

    val activeCourse = courses.firstOrNull { it.folder == selectedCourseFolder }?.pack
    val readerTargets = remember(activeCourse) { activeCourse?.let(::buildReaderTargets).orEmpty() }

    MaterialTheme {
        Scaffold { padding ->
            when {
                selectedStep != null && activeCourse != null -> ReaderScreen(
                    step = selectedStep!!,
                    targets = readerTargets,
                    onBack = { selectedStep = null },
                    onStep = { selectedStep = it },
                    modifier = Modifier.padding(padding)
                )
                activeCourse != null -> CourseScreen(
                    pack = activeCourse,
                    query = query,
                    error = errorMessage,
                    onQuery = { query = it },
                    onBack = { selectedCourseFolder = null; query = "" },
                    onStep = { selectedStep = it },
                    modifier = Modifier.padding(padding)
                )
                else -> LibraryScreen(
                    courses = courses,
                    query = query,
                    error = errorMessage,
                    onQuery = { query = it },
                    onImport = { openFile.launch(arrayOf("application/json", "application/octet-stream", "*/*")) },
                    onCourse = { selectedCourseFolder = it; query = "" },
                    onDeleteCourse = { folder ->
                        try {
                            deletePack(context, folder)
                            refreshLibrary()
                            errorMessage = ""
                        } catch (exception: Exception) {
                            errorMessage = "Не удалось удалить курс: ${exception.message}"
                        }
                    },
                    modifier = Modifier.padding(padding)
                )
            }
        }
    }
}

private fun libraryDirectory(context: Context) = File(context.filesDir, "courses")

private fun courseFolderName(pack: CoursePack): String {
    val id = pack.courseId.removePrefix("course:").takeIf { it.isNotBlank() && it != "unknown-course" && it != "unknown" }
        ?: pack.packageId.ifBlank { pack.title }
    val title = pack.title.lowercase().replace(Regex("[^\\p{L}\\p{N}]+"), "-").trim('-').take(40)
    val safeId = id.lowercase().replace(Regex("[^\\p{L}\\p{N}-]+"), "-").trim('-').take(36)
    return listOf(title.ifBlank { "stepik-course" }, safeId.ifBlank { "imported" }).joinToString("-")
}

private fun savePack(context: Context, pack: CoursePack, raw: String): String {
    val library = libraryDirectory(context)
    val hasStableCourseId = pack.courseId.isNotBlank() && pack.courseId != "unknown-course" && pack.courseId != "unknown"
    val existingFolder = if (hasStableCourseId) {
        library.listFiles { file -> file.isDirectory }.orEmpty().firstOrNull { candidate ->
            val existingPack = File(candidate, "course.stepikpack")
            existingPack.isFile && runCatching { PackParser.parse(existingPack.readText()).courseId == pack.courseId }.getOrDefault(false)
        }
    } else null
    val folder = existingFolder ?: File(library, courseFolderName(pack))
    val folderName = folder.name
    check(folder.canonicalFile.parentFile == libraryDirectory(context).canonicalFile) { "Некорректный идентификатор курса." }
    check(folder.exists() || folder.mkdirs()) { "Не удалось создать папку курса." }
    val target = File(folder, "course.stepikpack")
    val temporary = File(folder, "course.stepikpack.tmp")
    temporary.writeText(raw)
    try {
        try {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    } catch (exception: Exception) {
        temporary.delete()
        throw IllegalStateException("Не удалось сохранить пакет курса.", exception)
    }
    return folderName
}

private fun readLibrary(context: Context): List<StoredCourse> = libraryDirectory(context)
    .listFiles { file -> file.isDirectory }
    .orEmpty()
    .mapNotNull { folder ->
        val file = File(folder, "course.stepikpack")
        if (!file.isFile) return@mapNotNull null
        runCatching { StoredCourse(folder.name, PackParser.parse(file.readText())) }.getOrNull()
    }
    .sortedBy { it.pack.title.lowercase() }

private fun deletePack(context: Context, folderName: String) {
    val library = libraryDirectory(context)
    val folder = File(library, folderName)
    check(folder.canonicalFile.parentFile == library.canonicalFile && folder.isDirectory) {
        "Папка курса не найдена."
    }
    folder.listFiles().orEmpty().forEach { entry ->
        check(entry.canonicalFile.parentFile == folder.canonicalFile && entry.isFile) {
            "В папке есть неожиданные вложенные элементы."
        }
        check(entry.delete()) { "Не удалось удалить файл ${entry.name}." }
    }
    check(folder.delete()) { "Не удалось удалить папку курса." }
}

@Composable
private fun LibraryScreen(
    courses: List<StoredCourse>,
    query: String,
    error: String,
    onQuery: (String) -> Unit,
    onImport: () -> Unit,
    onCourse: (String) -> Unit,
    onDeleteCourse: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var pendingDelete by remember { mutableStateOf<StoredCourse?>(null) }
    val visibleCourses = courses.filter { query.isBlank() || it.pack.title.contains(query, true) }
    Column(modifier.fillMaxSize().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("OfflineStepik", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Твоя библиотека курсов. Материалы хранятся на телефоне и читаются без сети.")
        Button(onClick = onImport, modifier = Modifier.fillMaxWidth()) { Text("Импортировать .stepikpack") }
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        if (courses.isNotEmpty()) {
            OutlinedTextField(
                value = query,
                onValueChange = onQuery,
                label = { Text("Поиск по курсам") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
        }
        if (courses.isEmpty()) {
            Text("Пока нет курсов. Импортируй файл, экспортированный расширением на ПК.")
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(visibleCourses, key = { it.folder }) { stored ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(stored.pack.title, style = MaterialTheme.typography.titleLarge)
                            if (stored.pack.author.isNotBlank()) Text("Автор: ${stored.pack.author}")
                            Text("${stored.pack.steps.size} сохранённых шагов · ${if (stored.pack.complete) "экспорт завершён" else "экспорт неполный"}")
                            Text("Папка: ${stored.folder}", style = MaterialTheme.typography.bodySmall)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { onCourse(stored.folder) }, modifier = Modifier.weight(1f)) { Text("Открыть") }
                                OutlinedButton(onClick = { pendingDelete = stored }, modifier = Modifier.weight(1f)) { Text("Удалить") }
                            }
                        }
                    }
                }
            }
        }
    }
    pendingDelete?.let { course ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Удалить курс?") },
            text = { Text("Курс «${course.pack.title}» и его локальная папка будут удалены с этого телефона.") },
            confirmButton = {
                TextButton(onClick = {
                    onDeleteCourse(course.folder)
                    pendingDelete = null
                }) { Text("Удалить") }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Отмена") } }
        )
    }
}

@Composable
private fun CourseScreen(
    pack: CoursePack,
    query: String,
    error: String,
    onQuery: (String) -> Unit,
    onBack: () -> Unit,
    onStep: (OfflineStep) -> Unit,
    modifier: Modifier = Modifier
) {
    var expandedSections by remember(pack.courseId) { mutableStateOf(setOf<String>()) }
    var expandedLessons by remember(pack.courseId) { mutableStateOf(setOf<String>()) }
    val stepsByRoute = remember(pack.steps) { pack.steps.associateBy { routeKey(it.sourceUrl) } }
    val progressByLesson = remember(pack.navigation.progress) {
        pack.navigation.progress.groupBy { lessonIdFromRoute(it.url) }
    }

    fun resolveStep(nav: CourseNavStep): OfflineStep? =
        pack.steps.firstOrNull { it.id == nav.savedStepId && nav.savedStepId.isNotBlank() }
            ?: stepsByRoute[routeKey(nav.url)]

    fun savedSteps(lesson: CourseLesson): List<OfflineStep> = pack.steps.filter {
        lessonIdFromRoute(it.sourceUrl) == lesson.id.removePrefix("lesson:")
    }.sortedBy { it.order }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        TextButton(onClick = onBack) { Text("← Все курсы") }
        Text(pack.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        if (pack.author.isNotBlank()) Text("Автор: ${pack.author}", style = MaterialTheme.typography.bodyMedium)
        Text("${pack.steps.size} сохранённых шагов · ${if (pack.complete) "курс собран полностью" else "экспорт неполный"}")
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            label = { Text("Поиск по курсу") },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 8.dp),
            singleLine = true
        )

        if (pack.navigation.sections.isEmpty()) {
            Text("В этом старом пакете нет оглавления; показаны сохранённые шаги.", style = MaterialTheme.typography.bodySmall)
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(pack.steps.filter { query.isBlank() || it.title.contains(query, true) || it.text.contains(query, true) }, key = { it.id }) { step ->
                    StepRow(step = step, onClick = { onStep(step) })
                }
            }
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                progressByLesson.forEach { (lessonId, navSteps) ->
                    val lesson = pack.navigation.sections.flatMap { it.lessons }.firstOrNull { it.id.removePrefix("lesson:") == lessonId }
                    if (navSteps.isNotEmpty() && (query.isBlank() || lesson?.title?.contains(query, true) == true)) {
                        item(key = "progress-$lessonId") {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Шаги урока: ${lesson?.title ?: "урок $lessonId"}", style = MaterialTheme.typography.labelLarge)
                                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                                    navSteps.sortedBy { it.order }.forEachIndexed { index, nav ->
                                        val saved = resolveStep(nav)
                                        OutlinedButton(
                                            onClick = { saved?.let(onStep) },
                                            enabled = saved != null,
                                            modifier = Modifier.padding(end = 6.dp).widthIn(min = 42.dp)
                                        ) { Text(nav.title.takeIf { it.length < 8 } ?: (index + 1).toString()) }
                                    }
                                }
                            }
                        }
                    }
                }
                pack.navigation.sections.forEach { section ->
                    val visibleLessons = section.lessons.filter { lesson ->
                        query.isBlank() || lesson.title.contains(query, true) || savedSteps(lesson).any { it.title.contains(query, true) || it.text.contains(query, true) }
                    }
                    if (visibleLessons.isNotEmpty() || query.isBlank()) {
                        item(key = section.id) {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Card(Modifier.fillMaxWidth().clickable {
                                    expandedSections = if (section.id in expandedSections) expandedSections - section.id else expandedSections + section.id
                                }) {
                                    Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(section.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                        Text(if (section.id in expandedSections) "−" else "+", style = MaterialTheme.typography.titleLarge)
                                    }
                                }
                                if (section.id in expandedSections) {
                                    visibleLessons.forEach { lesson ->
                                        val saved = savedSteps(lesson)
                                        val lessonExpanded = lesson.id in expandedLessons
                                        Row(Modifier.fillMaxWidth().padding(start = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                            TextButton(onClick = { saved.firstOrNull()?.let(onStep) }, enabled = saved.isNotEmpty(), modifier = Modifier.weight(1f)) {
                                                Column(Modifier.fillMaxWidth()) {
                                                    Text(lesson.title, style = MaterialTheme.typography.bodyLarge)
                                                    Text(if (saved.isEmpty()) "Не сохранён" else "Сохранено шагов: ${saved.size}", style = MaterialTheme.typography.bodySmall)
                                                }
                                            }
                                            TextButton(onClick = {
                                                expandedLessons = if (lessonExpanded) expandedLessons - lesson.id else expandedLessons + lesson.id
                                            }) { Text(if (lessonExpanded) "Свернуть" else "Шаги") }
                                        }
                                        if (lessonExpanded) {
                                            val navSteps = (lesson.steps + progressByLesson[lesson.id.removePrefix("lesson:")].orEmpty())
                                                .distinctBy { routeKey(it.url) }
                                                .sortedBy { it.order }
                                            val mapped = navSteps.mapNotNull { nav -> resolveStep(nav)?.let { nav to it } }
                                            if (mapped.isNotEmpty()) {
                                                mapped.forEach { (nav, step) ->
                                                    TextButton(onClick = { onStep(step) }, modifier = Modifier.fillMaxWidth().padding(start = 24.dp)) {
                                                        Text(nav.title.ifBlank { step.title }, modifier = Modifier.fillMaxWidth())
                                                    }
                                                }
                                            } else if (saved.isNotEmpty()) {
                                                saved.forEach { step ->
                                                    TextButton(onClick = { onStep(step) }, modifier = Modifier.fillMaxWidth().padding(start = 24.dp)) {
                                                        Text(step.title, modifier = Modifier.fillMaxWidth())
                                                    }
                                                }
                                            } else {
                                                Text("Шаги этого урока ещё не собраны на ПК.", modifier = Modifier.padding(start = 28.dp, bottom = 8.dp), style = MaterialTheme.typography.bodySmall)
                                            }
                                        }
                                        HorizontalDivider(Modifier.padding(start = 12.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StepRow(step: OfflineStep, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(14.dp)) {
            Text(step.title, style = MaterialTheme.typography.titleMedium)
            Text(if (step.type == "exercise") "Задание" else "Теория", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ReaderScreen(
    step: OfflineStep,
    targets: List<ReaderTarget>,
    onBack: () -> Unit,
    onStep: (OfflineStep) -> Unit,
    modifier: Modifier = Modifier
) {
    val currentIndex = targets.indexOfFirst { it.step?.id == step.id }
        .takeIf { it >= 0 }
        ?: targets.indexOfFirst { routeKey(it.url) == routeKey(step.sourceUrl) }
    val currentLessonId = lessonIdFromRoute(step.sourceUrl)
    val previous = if (currentIndex >= 0) targets.getOrNull(currentIndex - 1) else null
    val next = if (currentIndex >= 0) targets.getOrNull(currentIndex + 1) else null

    Column(modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        TextButton(onClick = onBack) { Text("← К оглавлению") }
        Text(
            step.title,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp),
            style = MaterialTheme.typography.titleMedium
        )
        if (hasSavedStepContent(step.html)) {
            OfflineWebView(step.html, Modifier.weight(1f).fillMaxWidth())
        } else {
            Column(Modifier.weight(1f).fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Содержимое шага не сохранилось", style = MaterialTheme.typography.titleMedium)
                Text("В HTML этого шага не найден распознаваемый блок учебного содержимого.")
                Text("Обнови расширение на ПК до версии 0.2.6, собери шаг заново и импортируй новый пакет.")
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            ReaderNavigationButton(
                target = previous,
                currentLessonId = currentLessonId,
                forward = false,
                onStep = onStep,
                modifier = Modifier.weight(1f)
            )
            ReaderNavigationButton(
                target = next,
                currentLessonId = currentLessonId,
                forward = true,
                onStep = onStep,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
private fun ReaderNavigationButton(
    target: ReaderTarget?,
    currentLessonId: String,
    forward: Boolean,
    onStep: (OfflineStep) -> Unit,
    modifier: Modifier = Modifier
) {
    val destinationStep = target?.step?.takeIf { hasSavedStepContent(it.html) }
    val isLessonBoundary = target != null && target.lessonId != currentLessonId
    val action = when {
        target == null -> if (forward) "Конец курса" else "Начало курса"
        isLessonBoundary -> if (forward) "Следующий урок" else "Предыдущий урок"
        forward -> "Следующий шаг"
        else -> "Предыдущий шаг"
    }
    val enabled = destinationStep != null
    val buttonLabel = if (forward) action else "← $action"
    val click: () -> Unit = { destinationStep?.let(onStep) }
    val buttonModifier = modifier.height(72.dp)
    if (forward) {
        Button(onClick = click, enabled = enabled, modifier = buttonModifier) {
            Column(horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                Text(buttonLabel, style = MaterialTheme.typography.labelLarge)
                if (target?.title?.isNotBlank() == true) {
                    Text(target.title, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
                if (target != null && destinationStep == null) {
                    Text("Не сохранён офлайн", style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
            }
        }
    } else {
        OutlinedButton(onClick = click, enabled = enabled, modifier = buttonModifier) {
            Column(horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                Text(buttonLabel, style = MaterialTheme.typography.labelLarge)
                if (target?.title?.isNotBlank() == true) {
                    Text(target.title, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
                if (target != null && destinationStep == null) {
                    Text("Не сохранён офлайн", style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
            }
        }
    }
}

private fun buildReaderTargets(pack: CoursePack): List<ReaderTarget> {
    val stepsById = pack.steps.associateBy { it.id }
    val stepsByRoute = pack.steps.mapNotNull { step ->
        routeKey(step.sourceUrl).takeIf(String::isNotBlank)?.let { it to step }
    }.toMap()
    val usedStepIds = mutableSetOf<String>()
    val usedRoutes = mutableSetOf<String>()
    val targets = mutableListOf<ReaderTarget>()

    fun resolve(nav: CourseNavStep): OfflineStep? =
        nav.savedStepId.takeIf(String::isNotBlank)?.let(stepsById::get)
            ?: routeKey(nav.url).takeIf(String::isNotBlank)?.let(stepsByRoute::get)

    fun addTarget(lessonId: String, lessonTitle: String, title: String, url: String, saved: OfflineStep?) {
        val normalizedLessonId = lessonId.removePrefix("lesson:").ifBlank { lessonIdFromRoute(url) }
        val route = routeKey(url).ifBlank { saved?.let { routeKey(it.sourceUrl) }.orEmpty() }
        if (route.isNotBlank() && route in usedRoutes) return
        if (saved != null && saved.id in usedStepIds) return
        saved?.let {
            usedStepIds += it.id
            routeKey(it.sourceUrl).takeIf(String::isNotBlank)?.let(usedRoutes::add)
        }
        route.takeIf(String::isNotBlank)?.let(usedRoutes::add)
        targets += ReaderTarget(normalizedLessonId, lessonTitle, title.ifBlank { saved?.title.orEmpty() }, url, saved)
    }

    if (pack.navigation.sections.isEmpty()) {
        pack.navigation.progress.sortedBy { it.order }.forEach { nav ->
            val saved = resolve(nav)
            addTarget(lessonIdFromRoute(nav.url), "Урок ${lessonIdFromRoute(nav.url)}", nav.title, nav.url, saved)
        }
        pack.steps.sortedBy { it.order }.forEach { saved ->
            if (saved.id !in usedStepIds) {
                val lessonId = lessonIdFromRoute(saved.sourceUrl)
                addTarget(lessonId, "Урок $lessonId", saved.title, saved.sourceUrl, saved)
            }
        }
        return targets
    }

    val progressByLesson = pack.navigation.progress.groupBy { lessonIdFromRoute(it.url) }
    pack.navigation.sections.sortedBy { it.order }.forEach { section ->
        section.lessons.sortedBy { it.order }.forEach { lesson ->
            val lessonId = lesson.id.removePrefix("lesson:").ifBlank { lessonIdFromRoute(lesson.url) }
            val lessonNav = (lesson.steps + progressByLesson[lessonId].orEmpty())
                .distinctBy { routeKey(it.url).ifBlank { it.id } }
                .sortedBy { it.order }
            lessonNav.forEach { nav ->
                addTarget(lessonId, lesson.title, nav.title, nav.url, resolve(nav))
            }
            pack.steps.asSequence()
                .filter { lessonIdFromRoute(it.sourceUrl) == lessonId }
                .sortedBy { it.order }
                .forEach { saved -> addTarget(lessonId, lesson.title, saved.title, saved.sourceUrl, saved) }

            if (lessonNav.isEmpty() && pack.steps.none { lessonIdFromRoute(it.sourceUrl) == lessonId }) {
                addTarget(lessonId, lesson.title, lesson.title, lesson.url, null)
            }
        }
    }

    pack.steps.sortedBy { it.order }.forEach { saved ->
        if (saved.id !in usedStepIds) {
            val lessonId = lessonIdFromRoute(saved.sourceUrl)
            addTarget(lessonId, "Урок $lessonId", saved.title, saved.sourceUrl, saved)
        }
    }
    return targets
}

private fun lessonIdFromRoute(url: String): String =
    Regex("/lesson/(\\d+)").find(Uri.parse(url).path.orEmpty())?.groupValues?.getOrNull(1).orEmpty()

private fun routeKey(url: String): String = Uri.parse(url).path.orEmpty().trimEnd('/')

private fun hasSavedStepContent(html: String): Boolean {
    val hasStepContainer = Regex("""class\s*=\s*["'][^"']*\b(?:step-view|step-show|step-wrapper|html-content)\b""")
        .containsMatchIn(html)
    if (!hasStepContainer) return false

    val visibleText = html
        .replace(Regex("(?is)<(script|style|noscript)[^>]*>.*?</\\1>"), " ")
        .replace(Regex("(?s)<[^>]*>"), " ")
        .replace("&nbsp;", " ")
        .replace(Regex("\\s+"), " ")
        .trim()
    val hasMedia = Regex("(?i)<(?:img|svg|video|audio)\\b").containsMatchIn(html)
    if (visibleText.matches(Regex("(?i)(?:loading|загрузка)(?:…|\\.{3})?"))) return false
    return visibleText.length >= 24 || hasMedia
}

private fun offlineDocument(html: String): String = """
    <!doctype html>
    <html lang="ru">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
      <style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; min-height: 100%; background: #fff; color: #17202a; }
        body { padding: 16px; font-family: Roboto, "Noto Sans", sans-serif; font-size: 16px; line-height: 1.55; }
        .offline-step { width: 100%; max-width: 900px; margin: 0 auto; overflow-wrap: anywhere; }
        .main-header, .navbar, #player-lesson-sidebar, .lesson-sidebar, .lesson-sidebar__wrapper,
        .lesson-sidebar__body, .lesson-sidebar__expand-sidebar, .lesson-sidebar__pin-sidebar,
        .lesson-controls, .comments, .comments-list, .comments-user-avatar { display: none !important; }
        .lesson-modern__main, .lesson-modern__body, .lesson__player, .player-content-wrapper,
        .step-show, .step-dynamic-container, .step-view, .step-wrapper, .step-inner,
        .page-fragment, .html-content { display: block !important; width: auto !important;
          max-width: 100% !important; height: auto !important; min-height: 0 !important;
          margin: 0 !important; position: static !important; overflow: visible !important; }
        .lesson-modern__body { padding: 0 !important; }
        p { margin: 0 0 1em; }
        img, video, svg { max-width: 100%; height: auto; }
        img[data-offline-source] { display: none !important; }
        table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
        pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
        a { color: #2457c5; text-decoration: none; pointer-events: none; }
      </style>
    </head>
    <body>$html</body>
    </html>
""".trimIndent()

@Composable
private fun OfflineWebView(html: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context: Context ->
            WebView(context).apply {
                settings.javaScriptEnabled = false
                settings.domStorageEnabled = false
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val scheme = request.url.scheme.orEmpty()
                        if (scheme == "http" || scheme == "https") {
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }
            }
        },
        update = { view -> view.loadDataWithBaseURL("https://offline.local/", offlineDocument(html), "text/html", "UTF-8", null) }
    )
}
