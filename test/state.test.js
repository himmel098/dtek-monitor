import assert from "node:assert/strict"
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { saveWithComparison } from "../src/state.js"

function stateDirectory(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dtek-state-test-"))
  t.after(() => {
    const resolved = realpathSync(directory)
    assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith("dtek-state-test-"))
    rmSync(resolved, { recursive: true, force: true })
  })
  return directory
}

function result() {
  const intervals = [
    { start: "00:00", end: "01:00", status: "on", sourceCode: "yes" },
    { start: "01:00", end: "02:00", status: "off", sourceCode: "no" },
  ]
  return {
    schemaVersion: 1,
    result: true,
    source: "https://www.dtek-oem.com.ua/ua/shutdowns",
    timeZone: "Europe/Kyiv",
    address: {
      region: "o",
      city: "м. Місто",
      street: "вул. Миру",
      house: "5А",
      matchedHouse: "5А",
    },
    retrievedAt: "2026-10-18T12:00:00.000Z",
    updatedAt: {
      address: "15:00 18.10.2026",
      daily: "18.10.2026 15:00",
      weekly: "18.10.2026 15:00",
    },
    flags: { showTableFact: true, showTableSchedule: true },
    currentOutage: {
      reported: false,
      data: {
        sub_type: "",
        type: "",
        start_date: "",
        end_date: "",
        sub_type_reason: ["GPV1.1", "GPV2.1"],
      },
    },
    groups: ["GPV1.1", "GPV2.1"].map((id) => ({
      id,
      name: id,
      daily: [
        {
          date: "2026-10-18",
          timestamp: 1792270800,
          status: "available",
          intervals: structuredClone(intervals),
        },
      ],
      weekly: [1, 2].map((weekday) => ({
        weekday,
        name: "День",
        status: "available",
        intervals: structuredClone(intervals),
      })),
    })),
    notices: [],
    warnings: [],
  }
}

test("first successful run saves the full JSON and reports no previous comparison", (t) => {
  const directory = stateDirectory(t)
  const output = saveWithComparison(result(), directory)
  assert.equal(output.comparison.status, "first_run")
  assert.equal(output.comparison.changed, null)
  assert.equal(output.comparison.previousRetrievedAt, null)
  const files = readdirSync(directory)
  assert.equal(files.length, 1)
  const saved = JSON.parse(readFileSync(path.join(directory, files[0]), "utf8"))
  assert.deepEqual(saved.snapshot, output)
})

test("timestamps, labels, group order and equivalent interval splits do not count as changes", (t) => {
  const directory = stateDirectory(t)
  const initial = saveWithComparison(result(), directory)
  const current = result()
  current.retrievedAt = "2026-10-18T12:05:00.000Z"
  current.updatedAt = { address: "15:05 18.10.2026" }
  current.notices = ["Загальне повідомлення"]
  current.groups.reverse()
  current.currentOutage.data.sub_type_reason.reverse()
  current.flags = { showTableSchedule: true, showTableFact: true }
  for (const group of current.groups) {
    group.name = "Новий підпис"
    group.weekly.reverse()
    const day = group.weekly[0]
    day.name = "Інший підпис"
    day.intervals.splice(
      0,
      1,
      { start: "00:00", end: "00:30", status: "on", sourceCode: "first" },
      { start: "00:30", end: "01:00", status: "on", sourceCode: "second" }
    )
  }
  const output = saveWithComparison(current, directory)
  assert.equal(output.comparison.status, "unchanged")
  assert.equal(output.comparison.changed, false)
  assert.equal(output.comparison.message, "Графік для цієї адреси не змінився.")
  assert.equal(output.comparison.previousRetrievedAt, initial.retrievedAt)
  const saved = JSON.parse(
    readFileSync(path.join(directory, readdirSync(directory)[0]), "utf8")
  )
  assert.deepEqual(saved.snapshot, output)
  const again = saveWithComparison(current, directory)
  assert.equal(again.comparison.previousRetrievedAt, current.retrievedAt)
  assert.equal(again.comparison.changed, false)
})

test("changed intervals, groups, dates, availability, outage records and flags are detected", async (t) => {
  const edits = {
    interval: (current) => {
      current.groups[0].daily[0].intervals[0].status = "off"
    },
    group: (current) => {
      current.groups.pop()
    },
    date: (current) => {
      current.groups[0].daily[0].date = "2026-10-19"
    },
    availability: (current) => {
      current.groups[0].daily = []
    },
    outage: (current) => {
      current.currentOutage.data.end_date = "20:00 18.10.2026"
    },
    flags: (current) => {
      current.flags.showTableFact = false
    },
  }
  for (const [name, edit] of Object.entries(edits)) {
    await t.test(name, (subtest) => {
      const directory = stateDirectory(subtest)
      saveWithComparison(result(), directory)
      const current = result()
      edit(current)
      const output = saveWithComparison(current, directory)
      assert.equal(output.comparison.status, "changed")
      assert.equal(output.comparison.changed, true)
      assert.deepEqual(output.groups, current.groups)
    })
  }
})

test("each house has independent state, with case and whitespace normalized", (t) => {
  const directory = stateDirectory(t)
  saveWithComparison(result(), directory)
  const anotherHouse = result()
  anotherHouse.address.house = "9"
  anotherHouse.address.matchedHouse = "9"
  assert.equal(
    saveWithComparison(anotherHouse, directory).comparison.status,
    "first_run"
  )
  const sameHouse = result()
  sameHouse.address.house = " 5а "
  sameHouse.address.city = "М.  МІСТО"
  assert.equal(
    saveWithComparison(sameHouse, directory).comparison.status,
    "unchanged"
  )
  assert.equal(readdirSync(directory).length, 2)
  assert.equal(
    saveWithComparison(anotherHouse, directory).comparison.status,
    "unchanged"
  )
})

test("failed runs do not overwrite the previous successful JSON", (t) => {
  const directory = stateDirectory(t)
  saveWithComparison(result(), directory)
  const filename = path.join(directory, readdirSync(directory)[0])
  const before = readFileSync(filename, "utf8")
  assert.throws(
    () =>
      saveWithComparison(
        { result: false, error: { code: "FETCH_FAILED" } },
        directory
      ),
    { code: "INVALID_STATE_RESULT" }
  )
  assert.equal(readFileSync(filename, "utf8"), before)
  assert.equal(
    saveWithComparison(result(), directory).comparison.status,
    "unchanged"
  )
})

test("corrupt state is reported and is not replaced or treated as unchanged", (t) => {
  const directory = stateDirectory(t)
  saveWithComparison(result(), directory)
  const filename = path.join(directory, readdirSync(directory)[0])
  const corrupt = "{incomplete-json"
  writeFileSync(filename, corrupt)
  assert.throws(() => saveWithComparison(result(), directory), {
    code: "STATE_READ_FAILED",
  })
  assert.equal(readFileSync(filename, "utf8"), corrupt)
  assert.equal(readdirSync(directory).length, 1)
})
