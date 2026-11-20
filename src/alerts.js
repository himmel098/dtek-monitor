import { createHash } from "node:crypto"

const kyiv = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})
const dateLabel = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" })
const statuses = ["off", "possible_off"]
const html = (value) => String(value ?? "").replace(/[&<>]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const time = (hhmm) => hhmm.split(":").reduce((h, m) => h * 60 + Number(m))
const span = ([start, end]) => `${start}–${end}`

function spans(intervals, status) {
  const merged = []
  for (const { start, end } of intervals.filter((i) => i.status === status).sort((a, b) => a.start.localeCompare(b.start))) {
    if (merged.at(-1)?.[1] === start) merged.at(-1)[1] = end
    else merged.push([start, end])
  }
  return merged
}

function edits(before, after, status) {
  // Lock exact matches before pairing overlapping intervals as time shifts.
  const old = before.filter((item) => !after.some((other) => equal(item, other)))
  const added = after.filter((item) => !before.some((other) => equal(item, other)))
  const shifts = [], removed = []
  for (const item of old) {
    let best = 0, index = -1
    for (const [i, candidate] of added.entries()) {
      const overlap = Math.min(time(item[1]), time(candidate[1])) - Math.max(time(item[0]), time(candidate[0]))
      if (overlap > best) { best = overlap; index = i }
    }
    if (index < 0) removed.push(item)
    else shifts.push(`🕒 <b>${status === "off" ? "Час відключення" : "Час можливого відключення"} змінено:</b> ${html(span(item))} → ${html(span(added.splice(index, 1)[0]))}`)
  }
  const label = status === "off" ? "відключення" : "можливе відключення"
  if (removed.length) shifts.push(`🟢 <b>Скасовано ${label}:</b> ${html(removed.map(span).join(", "))}`)
  if (added.length) shifts.push(`🔴 <b>Додано ${label}:</b> ${html(added.map(span).join(", "))}`)
  return shifts
}

function emergency(outage) {
  if (!outage?.reported) return null
  const { sub_type: title, start_date, end_date } = outage.data ?? {}
  const kind = [title, outage.data?.type].filter(Boolean).join(" ")
  if (/стабілізац/iu.test(kind) || !/аварійн|екстрен/iu.test(kind)) return null
  return [title || outage.data.type, start_date || null, end_date || null]
}

export function planAlert(result, previous, now = new Date()) {
  if (result?.result !== true) throw new Error("Cannot process an unsuccessful DTEK result")
  const { region, city, street, house } = result.address
  const key = createHash("sha256").update(JSON.stringify([region, city, street, house].map((v) => String(v).trim().toLocaleLowerCase("uk")))).digest("hex")
  const baseline = previous?.key === key ? previous : null
  const [today, clock] = kyiv.format(now).split(" ")
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const nowSeconds = time(clock.slice(0, 5)) * 60 + Number(clock.slice(6)) + now.getMilliseconds() / 1000
  const visible = (items, date) => date !== today ? items : items.filter((item) => nowSeconds <= (time(item[1]) + 30) * 60)
  const [year, month, day] = (result.scheduleDate ?? "").split("-")
  const fresh = result.scheduleDate === today && String(result.updatedAt?.daily ?? "").startsWith(`${day}.${month}.${year}`)
  const blocks = []
  const dates = {}
  for (const date of [today, tomorrow]) {
    const old = new Map(baseline?.dates[date] ?? [])
    const next = new Map(old)
    const lines = []
    if (result.flags?.showTableFact && result.flags?.showTableSchedule) {
      for (const group of result.groups) {
        const daily = group.daily.find((d) => d.date === date)
        if (daily?.status !== "available" || daily.intervals.some((i) => i.status === "unknown")) continue
        const after = statuses.map((status) => spans(daily.intervals, status))
        const before = old.get(group.id)
        // A stale but available snapshot can seed missing state, not replace a known baseline.
        if (!fresh && before) continue
        next.set(group.id, after)
        if (!baseline || !fresh) continue
        const current = after.map((items) => visible(items, date))
        const changes = before
          ? statuses.flatMap((status, i) => edits(visible(before[i], date), current[i], status))
          : date === tomorrow ? ["📢 <b>Опубліковано добовий графік</b>"] : []
        if (!changes.length) continue
        lines.push(`🔢 Черга <b>${html(group.name || group.id)}</b>`, ...changes,
          `🔴 <b>Чинні відключення:</b> ${html(current[0].map(span).join(", ") || "немає")}`)
        if (current[1].length) lines.push(`🟡 <b>Можливі відключення:</b> ${html(current[1].map(span).join(", "))}`)
      }
    }
    dates[date] = [...next]
    if (lines.length) blocks.push(`📅 <b>${dateLabel.format(new Date(`${date}T00:00:00Z`))}</b>\n${lines.join("\n")}`)
  }
  const event = emergency(result.currentOutage)
  if (baseline && !equal(baseline.event, event)) {
    blocks.push(event
      ? `🚨 <b>Аварійна подія:</b> ${[event[0], event[1] && `початок ${event[1]}`, event[2] && `завершення ${event[2]}`].filter(Boolean).map(html).join("; ")}`
      : "✅ <b>Аварійну подію завершено або знято з повідомлення ДТЕК</b>")
  }
  const message = blocks.length ? [
    `⚡ <b>Зміни графіка ДТЕК</b>\n📍 ${[city, street, house].map(html).join(", ")}`,
    ...blocks,
    `🕒 Дані ДТЕК оновлено о ${html(result.updatedAt?.daily || "час невідомий")}`,
  ].join("\n\n") : null
  return { message, state: { version: 1, key, dates, event } }
}
