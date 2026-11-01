package com.offlinestepik

import org.json.JSONArray
import org.json.JSONObject

data class CoursePack(
    val packageId: String,
    val courseId: String,
    val title: String,
    val author: String,
    val sourceUrl: String,
    val complete: Boolean,
    val steps: List<OfflineStep>,
    val navigation: CourseNavigation
)

data class OfflineStep(
    val id: String,
    val title: String,
    val type: String,
    val sourceUrl: String,
    val html: String,
    val text: String,
    val options: List<String>,
    val order: Int
)

data class CourseNavigation(
    val sections: List<CourseSection>,
    val progress: List<CourseNavStep>
)

data class CourseSection(
    val id: String,
    val title: String,
    val order: Int,
    val lessons: List<CourseLesson>
)

data class CourseLesson(
    val id: String,
    val title: String,
    val url: String,
    val order: Int,
    val savedCount: Int,
    val steps: List<CourseNavStep>
)

data class CourseNavStep(
    val id: String,
    val title: String,
    val url: String,
    val order: Int,
    val saved: Boolean,
    val savedStepId: String
)

object PackParser {
    fun parse(raw: String): CoursePack {
        val root = JSONObject(raw)
        require(root.optString("format") == "stepikpack") { "Это не файл stepikpack." }
        require(root.optInt("schemaVersion", -1) in 1..2) { "Неподдерживаемая версия пакета." }

        val course = root.getJSONObject("course")
        val stepsJson = root.optJSONArray("steps") ?: JSONArray()
        val steps = buildList {
            for (index in 0 until stepsJson.length()) {
                val item = stepsJson.getJSONObject(index)
                val options = item.optJSONArray("options")?.let(::readOptions) ?: emptyList()
                add(
                    OfflineStep(
                        id = item.optString("id", "step-$index"),
                        title = item.optString("title", "Шаг ${index + 1}"),
                        type = item.optString("type", "theory"),
                        sourceUrl = item.optString("sourceUrl", ""),
                        html = item.optString("html", "<p>${item.optString("text")}</p>"),
                        text = item.optString("text", ""),
                        options = options,
                        order = item.optInt("order", index)
                    )
                )
            }
        }.sortedBy { it.order }

        return CoursePack(
            packageId = root.optString("packageId", ""),
            courseId = course.optString("id", "unknown-course"),
            title = course.optString("title", "Курс Stepik"),
            author = course.optString("author", ""),
            sourceUrl = course.optString("sourceUrl", ""),
            complete = root.optBoolean("complete", false),
            steps = steps,
            navigation = readNavigation(root.optJSONObject("navigation"))
        )
    }

    private fun readNavigation(json: JSONObject?): CourseNavigation {
        if (json == null) return CourseNavigation(emptyList(), emptyList())
        val sectionsJson = json.optJSONArray("sections") ?: JSONArray()
        val sections = buildList {
            for (sectionIndex in 0 until sectionsJson.length()) {
                val section = sectionsJson.optJSONObject(sectionIndex) ?: continue
                val lessonsJson = section.optJSONArray("lessons") ?: JSONArray()
                val lessons = buildList {
                    for (lessonIndex in 0 until lessonsJson.length()) {
                        val lesson = lessonsJson.optJSONObject(lessonIndex) ?: continue
                        val lessonSteps = readNavSteps(lesson.optJSONArray("steps"))
                        add(
                            CourseLesson(
                                id = lesson.optString("id", "lesson-$lessonIndex"),
                                title = lesson.optString("title", "Урок ${lessonIndex + 1}"),
                                url = lesson.optString("url", ""),
                                order = lesson.optInt("order", lessonIndex),
                                savedCount = lesson.optInt("savedCount", lessonSteps.count { it.saved }),
                                steps = lessonSteps
                            )
                        )
                    }
                }.sortedBy { it.order }
                add(
                    CourseSection(
                        id = section.optString("id", "section-$sectionIndex"),
                        title = section.optString("title", "Раздел ${sectionIndex + 1}"),
                        order = section.optInt("order", sectionIndex),
                        lessons = lessons
                    )
                )
            }
        }.sortedBy { it.order }
        return CourseNavigation(sections, readNavSteps(json.optJSONArray("progress")))
    }

    private fun readNavSteps(array: JSONArray?): List<CourseNavStep> {
        if (array == null) return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                add(
                    CourseNavStep(
                        id = item.optString("id", "nav-step-$index"),
                        title = item.optString("title", "Шаг ${index + 1}"),
                        url = item.optString("url", ""),
                        order = item.optInt("order", index),
                        saved = item.optBoolean("saved", false),
                        savedStepId = item.optString("savedStepId", "")
                    )
                )
            }
        }.sortedBy { it.order }
    }

    private fun readOptions(array: JSONArray): List<String> = buildList {
        for (index in 0 until array.length()) {
            val option = array.opt(index)
            if (option is JSONObject) add(option.optString("text")) else add(option.toString())
        }
    }
}
