import {
  HALF_HOUR_MINUTES,
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
  MonitorError,
  TIME_ZONE,
} from "./constants.js"

const normalize = (value) =>
  String(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase("uk")
const withoutPrefix = (value) =>
  normalize(value).replace(
    /^(?:м\.|с\.|смт\.?|селище|місто|село|вул\.|вулиця|просп\.|проспект|пров\.|провулок|пл\.|площа)\s*/u,
    ""
  )

export function selectName(requested, candidates, field) {
  const exact = candidates.filter(
    (name) => normalize(name) === normalize(requested)
  )
  const matches = exact.length
    ? exact
    : candidates.filter(
        (name) => withoutPrefix(name) === withoutPrefix(requested)
      )
  if (matches.length === 1) return matches[0]
  throw new MonitorError(
    matches.length ? "AMBIGUOUS_ADDRESS" : "ADDRESS_NOT_FOUND",
    `${field}: ${requested}`,
    { field, candidates: matches.length ? matches : candidates }
  )
}

export function localDate(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Number(timestamp) * MILLISECONDS_PER_SECOND))
  const get = (type) => parts.find((part) => part.type === type).value
  return `${get("year")}-${get("month")}-${get("day")}`
}

function midpoint(time) {
  const [hours, minutes] = time.split(":").map(Number)
  const total = hours * MINUTES_PER_HOUR + minutes + HALF_HOUR_MINUTES
  return `${String(Math.floor(total / MINUTES_PER_HOUR)).padStart(2, "0")}:${String(total % MINUTES_PER_HOUR).padStart(2, "0")}`
}

export function decodeSchedule(cells, preset) {
  const zones = Object.entries(preset?.time_zone ?? {})
  if (!cells || !Object.keys(cells).length || !zones.length) {
    return { status: "unavailable", intervals: [] }
  }
  const intervals = []
  for (const [key, zone] of zones) {
    // Current site schema: [display label, start time, end time].
    // Fail explicitly on a schema change instead of inventing hours.
    if (
      !Array.isArray(zone) ||
      !/^\d{2}:\d{2}$/u.test(zone[1]) ||
      !/^\d{2}:\d{2}$/u.test(zone[2])
    ) {
      throw new MonitorError(
        "INVALID_SCHEDULE",
        `Unsupported time zone: ${key}`
      )
    }
    const [, start, end] = zone
    const code = cells[key] ?? null
    const statuses = {
      yes: ["on"],
      no: ["off"],
      maybe: ["possible_off"],
      first: ["off", "on"],
      second: ["on", "off"],
      mfirst: ["possible_off", "on"],
      msecond: ["on", "possible_off"],
    }[code] ?? ["unknown"]
    const boundaries =
      statuses.length === 1 ? [start, end] : [start, midpoint(start), end]
    statuses.forEach((status, index) =>
      intervals.push({
        start: boundaries[index],
        end: boundaries[index + 1],
        status,
        sourceCode: code,
      })
    )
  }
  return {
    status: intervals.some((interval) => interval.status === "unknown")
      ? "partial"
      : "available",
    intervals,
  }
}

export function buildResult({ config, address, response, preset, fact }) {
  if (
    response?.result !== true ||
    !response.data ||
    typeof response.data !== "object"
  ) {
    throw new MonitorError(
      "INVALID_RESPONSE",
      "DTEK did not return a successful address response."
    )
  }
  const houseKey = Object.keys(response.data).find(
    (key) => normalize(key) === normalize(config.house)
  )
  const streetWide =
    houseKey === undefined &&
    Object.keys(response.data).length === 1 &&
    Object.hasOwn(response.data, "-")
  const matchedHouse = houseKey ?? (streetWide ? "-" : undefined)
  const house = response.data[matchedHouse]
  if (!house) {
    throw new MonitorError(
      "HOUSE_NOT_FOUND",
      `House ${config.house} not found.`,
      {
        availableHouses: Object.keys(response.data),
      }
    )
  }
  const groups = [...new Set(house.sub_type_reason ?? [])]
  const warnings = []
  if (groups.length > 1) warnings.push("MULTIPLE_SUPPLY_GROUPS")
  if (!groups.length) warnings.push("NO_GROUP_ASSIGNED")
  if (streetWide) warnings.push("STREET_WIDE_RECORD")
  const schedules = groups.map((id) => {
    const weekly = Object.entries(preset?.days ?? {}).map(
      ([weekday, name]) => ({
        weekday: Number(weekday),
        name,
        ...decodeSchedule(preset?.data?.[id]?.[weekday], preset),
      })
    )
    const daily = Object.entries(fact?.data ?? {})
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([timestamp, data]) => ({
        date: localDate(timestamp),
        timestamp: Number(timestamp),
        ...decodeSchedule(data?.[id], preset),
      }))
    if (!daily.some((day) => day.status !== "unavailable"))
      warnings.push(`DAILY_SCHEDULE_UNAVAILABLE:${id}`)
    if (!weekly.some((day) => day.status !== "unavailable"))
      warnings.push(`WEEKLY_SCHEDULE_UNAVAILABLE:${id}`)
    return { id, name: preset?.sch_names?.[id] ?? id, daily, weekly }
  })
  const flags = Object.fromEntries(
    Object.entries(response).filter(([key]) => key.startsWith("show"))
  )
  return {
    schemaVersion: 1,
    result: true,
    address: {
      region: config.region,
      city: address.city,
      street: address.street,
      house: config.house,
      matchedHouse,
    },
    source: config.url,
    retrievedAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    updatedAt: {
      address: response.updateTimestamp ?? null,
      daily: fact?.update ?? null,
      weekly: preset?.updateFact ?? null,
    },
    scheduleDate: fact?.today ? localDate(fact.today) : null,
    flags,
    currentOutage: {
      reported: [
        house.sub_type,
        house.start_date,
        house.end_date,
        house.type,
      ].some((value) => value != null && Boolean(String(value).trim())),
      data: house,
    },
    legend: preset?.time_type ?? {},
    groups: schedules,
    warnings,
  }
}
