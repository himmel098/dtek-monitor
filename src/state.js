import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MonitorError } from "./constants.js"

const STATE_VERSION = 1
const STATE_DIRECTORY = fileURLToPath(
  new URL("../artifacts/state/", import.meta.url)
)

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function addressKey(result) {
  const normalize = (value) =>
    String(value ?? "")
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("uk")
  return stableJson({
    source: result.source,
    address: Object.fromEntries(
      ["region", "city", "street", "house"].map((key) => [
        key,
        normalize(result.address[key]),
      ])
    ),
  })
}

function intervalsForComparison(intervals = []) {
  const normalized = []
  const sorted = [...intervals].sort((left, right) =>
    left.start.localeCompare(right.start)
  )
  for (const interval of sorted) {
    const item = {
      start: interval.start,
      end: interval.end,
      status: interval.status,
    }
    // Preserve an unrecognized source code: different unknown data should not look identical.
    if (interval.status === "unknown")
      item.sourceCode = interval.sourceCode ?? null
    const previous = normalized.at(-1)
    if (
      previous &&
      previous.end === item.start &&
      previous.status === item.status &&
      previous.sourceCode === item.sourceCode
    ) {
      previous.end = item.end
    } else {
      normalized.push(item)
    }
  }
  return normalized
}

function scheduleForComparison(result) {
  return stableJson({
    timeZone: result.timeZone,
    flags: result.flags,
    currentOutage: {
      reported: result.currentOutage.reported,
      data: Object.fromEntries(
        Object.entries(result.currentOutage.data).filter(
          ([key]) => key !== "sub_type_reason"
        )
      ),
    },
    groups: result.groups
      .map((group) => ({
        id: group.id,
        daily: group.daily
          .map((day) => ({
            date: day.date,
            status: day.status,
            intervals: intervalsForComparison(day.intervals),
          }))
          .sort((left, right) => left.date.localeCompare(right.date)),
        weekly: group.weekly
          .map((day) => ({
            weekday: day.weekday,
            status: day.status,
            intervals: intervalsForComparison(day.intervals),
          }))
          .sort((left, right) => left.weekday - right.weekday),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
}

function readPrevious(stateFile, currentResult) {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"))
    if (
      state.stateVersion !== STATE_VERSION ||
      state.snapshot?.result !== true ||
      !Array.isArray(state.snapshot.groups) ||
      !state.snapshot.currentOutage ||
      !state.snapshot.address ||
      addressKey(state.snapshot) !== addressKey(currentResult)
    ) {
      throw new Error("Invalid saved snapshot")
    }
    // Check the complete comparison data before permitting a state replacement.
    scheduleForComparison(state.snapshot)
    return state.snapshot
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new MonitorError(
      "STATE_READ_FAILED",
      `Cannot read previous result: ${error.message}`,
      { stateFile }
    )
  }
}

export function saveWithComparison(result, stateDirectory = STATE_DIRECTORY) {
  if (result?.result !== true) {
    throw new MonitorError(
      "INVALID_STATE_RESULT",
      "Only a successful result can be saved."
    )
  }
  const filename =
    createHash("sha256").update(addressKey(result)).digest("hex") + ".json"
  const stateFile = path.join(stateDirectory, filename)
  const previous = readPrevious(stateFile, result)
  const changed =
    previous === null
      ? null
      : scheduleForComparison(previous) !== scheduleForComparison(result)
  const status =
    previous === null ? "first_run" : changed ? "changed" : "unchanged"
  const message = {
    first_run:
      "Перший успішний запуск для цієї адреси. Графік збережено для наступного порівняння.",
    changed: "Графік або інформація про відключення для цієї адреси змінилися.",
    unchanged: "Графік для цієї адреси не змінився.",
  }[status]
  const output = {
    ...result,
    comparison: {
      status,
      changed,
      previousRetrievedAt: previous?.retrievedAt ?? null,
      message,
    },
  }
  const temporaryFile = path.join(
    stateDirectory,
    `${filename}.${randomUUID()}.tmp`
  )
  try {
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(
      temporaryFile,
      JSON.stringify({ stateVersion: STATE_VERSION, snapshot: output }) + "\n",
      { flag: "wx" }
    )
    renameSync(temporaryFile, stateFile)
  } catch (error) {
    try {
      rmSync(temporaryFile, { force: true })
    } catch (cleanupError) {
      console.error(
        `Cannot remove temporary state file: ${cleanupError.message}`
      )
    }
    throw new MonitorError(
      "STATE_WRITE_FAILED",
      `Cannot save result: ${error.message}`,
      { stateFile }
    )
  }
  return output
}
