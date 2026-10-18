import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  buildResult,
  decodeSchedule,
  localDate,
  selectName,
} from "../src/helpers.js"

const preset = {
  time_zone: { 1: ["00-01", "00:00", "01:00"], 2: ["01-02", "01:00", "02:00"] },
  days: { 1: "Понеділок" },
  sch_names: { "GPV1.2": "Черга 1.2" },
  data: { "GPV1.2": { 1: { 1: "mfirst", 2: "yes" } } },
}
const config = {
  region: "o",
  city: "Місто",
  street: "Вулиця",
  house: "5",
  url: "https://www.dtek-oem.com.ua/ua/shutdowns",
}
const input = {
  config,
  address: config,
  preset,
  response: {
    result: true,
    data: {
      5: {
        sub_type_reason: ["GPV1.2", "GPV3.2"],
        sub_type: "",
        start_date: "",
        end_date: "",
        type: "",
      },
    },
  },
  fact: { data: [], today: 1792270800, update: "17.10.2026 18:50" },
}

test("half-hour codes preserve which half is off or possibly off", () => {
  for (const [code, expected] of Object.entries({
    first: ["off", "on"],
    second: ["on", "off"],
    mfirst: ["possible_off", "on"],
    msecond: ["on", "possible_off"],
  })) {
    const { intervals } = decodeSchedule({ 1: code, 2: "no" }, preset)
    assert.deepEqual(
      intervals
        .slice(0, 2)
        .map(({ start, end, status }) => ({ start, end, status })),
      [
        { start: "00:00", end: "00:30", status: expected[0] },
        { start: "00:30", end: "01:00", status: expected[1] },
      ]
    )
  }
})

test("missing schedules, missing cells and unknown codes never imply power on", () => {
  assert.deepEqual(decodeSchedule(undefined, preset), {
    status: "unavailable",
    intervals: [],
  })
  const result = decodeSchedule({ 1: "new-code" }, preset)
  assert.equal(result.status, "partial")
  assert.ok(result.intervals.every(({ status }) => status === "unknown"))
  assert.equal(result.intervals[0].sourceCode, "new-code")
  assert.throws(
    () => decodeSchedule({ 1: "yes" }, { time_zone: { 1: "00-01" } }),
    { code: "INVALID_SCHEDULE" }
  )
})

test("multiple groups and empty dated schedules remain separate from weekly forecast", () => {
  const result = buildResult(input)
  assert.deepEqual(
    result.groups.map(({ id }) => id),
    ["GPV1.2", "GPV3.2"]
  )
  assert.equal(result.groups[0].weekly[0].status, "available")
  assert.equal(result.groups[1].weekly[0].status, "unavailable")
  assert.deepEqual(result.groups[0].daily, [])
  assert.ok(result.warnings.includes("MULTIPLE_SUPPLY_GROUPS"))
  assert.ok(result.warnings.includes("DAILY_SCHEDULE_UNAVAILABLE:GPV1.2"))
  assert.equal(result.currentOutage.reported, false)
})

test("daily schedules use Kyiv dates and preserve missing data for a second group", () => {
  const timestamp = String(input.fact.today)
  const result = buildResult({
    ...input,
    fact: {
      ...input.fact,
      data: { [timestamp]: { "GPV1.2": { 1: "no", 2: "yes" } } },
    },
  })
  assert.equal(localDate(timestamp), "2026-10-18")
  assert.equal(result.groups[0].daily[0].date, "2026-10-18")
  assert.equal(result.groups[0].daily[0].intervals[0].status, "off")
  assert.equal(result.groups[1].daily[0].status, "unavailable")
})

test("address lookup accepts unique prefixes and refuses ambiguous addresses", () => {
  assert.equal(selectName("Одеса", ["м. Одеса"], "city"), "м. Одеса")
  assert.throws(
    () => selectName("Миру", ["вул. Миру", "пров. Миру"], "street"),
    { code: "AMBIGUOUS_ADDRESS" }
  )
  assert.throws(
    () => buildResult({ ...input, config: { ...config, house: "5/А" } }),
    { code: "HOUSE_NOT_FOUND" }
  )
  const result = buildResult({
    ...input,
    response: { result: true, data: { "-": input.response.data[5] } },
  })
  assert.equal(result.address.matchedHouse, "-")
  assert.ok(result.warnings.includes("STREET_WIDE_RECORD"))
})

test("CLI emits one parseable JSON error and a nonzero exit status", () => {
  const command = fileURLToPath(new URL("../src/monitor.js", import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      command,
      "--region",
      "invalid",
      "--city",
      "test",
      "--street",
      "test",
      "--house",
      "1",
    ],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 1)
  const json = JSON.parse(result.stdout)
  assert.equal(json.result, false)
  assert.equal(json.error.code, "INVALID_CONFIG")
  assert.ok(result.stderr.trim())
})
