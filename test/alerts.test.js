import test from "node:test"
import assert from "node:assert/strict"
import { planAlert } from "../src/alerts.js"

const today = "2026-11-20", tomorrow = "2026-11-21"
const at = (clock = "07:00:00") => new Date(`${today}T${clock}Z`)
const day = (date, end = "10:00", status = "available") => ({ date, status, intervals: [{ start: "09:00", end, status: "off" }] })
const result = (daily = [day(today)], extra) => ({
  result: true, address: { region: "o", city: "Одеса", street: "<тест>", house: "1" },
  scheduleDate: today, updatedAt: { daily: "20.11.2026 08:00" },
  flags: { showTableFact: true, showTableSchedule: true },
  groups: [{ id: "1.1", name: "1.1", daily }], ...extra,
})
const seed = () => planAlert(result(), null, at()).state

test("first run and metadata-only refresh stay silent", () => {
  assert.equal(planAlert(result(), null, at()).message, null)
  assert.equal(planAlert(result(undefined, { updatedAt: { daily: "20.11.2026 09:00" } }), seed(), at()).message, null)
})

test("moves preserve the template and the exact 30-minute boundary", () => {
  const changed = result([day(today, "10:30")])
  const { message } = planAlert(changed, seed(), at("08:30:00"))
  assert.match(message, /09:00–10:00 → 09:00–10:30/u)
  assert.match(message, /&lt;тест&gt;/u)
  assert.doesNotMatch(planAlert(changed, seed(), at("08:31:00")).message, /09:00–10:00/u)
  assert.equal(planAlert(changed, seed(), at("09:01:00")).message, null)
})

test("stale, hidden and partial observations cannot replace the baseline", () => {
  const changed = [day(today, "11:00")]
  let state = seed()
  for (const input of [result(changed, { updatedAt: { daily: "19.11.2026 22:00" } }),
    result(changed, { flags: { showTableFact: false, showTableSchedule: true } }),
    result([day(today, "11:00", "partial")])]) {
    const plan = planAlert(input, state, at())
    assert.equal(plan.message, null)
    state = plan.state
  }
  assert.match(planAlert(result(changed), state, at()).message, /09:00–10:00 → 09:00–11:00/u)
})

test("tomorrow publication is emitted once and is compared by date after midnight", () => {
  const published = result([day(today), day(tomorrow, "12:00")])
  const plan = planAlert(published, seed(), at())
  assert.match(plan.message, /Опубліковано добовий графік/u)
  assert.equal(planAlert(published, plan.state, at()).message, null)
  const rollover = result([day(tomorrow, "12:00")], { scheduleDate: tomorrow, updatedAt: { daily: "21.11.2026 00:00" } })
  assert.equal(planAlert(rollover, plan.state, at("22:00:00")).message, null)
})

test("only explicit emergencies notify, and their ending is reported once", () => {
  const outage = (sub_type) => result(undefined, { currentOutage: { reported: true, data: { sub_type } } })
  assert.equal(planAlert(outage("Стабілізаційне"), seed(), at()).message, null)
  assert.equal(planAlert(outage("Невідоме"), seed(), at()).message, null)
  const plan = planAlert(outage("Екстрене"), seed(), at())
  assert.match(plan.message, /Аварійна подія/u)
  const ended = planAlert(result(), plan.state, at())
  assert.match(ended.message, /Аварійну подію завершено/u)
  assert.equal(planAlert(result(), ended.state, at()).message, null)
})
