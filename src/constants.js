export const SHUTDOWNS_PAGES = {
  k: "https://www.dtek-kem.com.ua/ua/shutdowns",
  kr: "https://www.dtek-krem.com.ua/ua/shutdowns",
  dn: "https://www.dtek-dnem.com.ua/ua/shutdowns",
  o: "https://www.dtek-oem.com.ua/ua/shutdowns",
  d: "https://www.dtek-dem.com.ua/ua/shutdowns",
}

export const TIME_ZONE = "Europe/Kyiv"
export const NAVIGATION_TIMEOUT_MS = 45_000
export const ACTION_TIMEOUT_MS = 15_000
export const RETRIES_MAX_COUNT = 2
export const RETRIES_TIMEOUT_MS = 5_000
export const MILLISECONDS_PER_SECOND = 1_000
export const MINUTES_PER_HOUR = 60
export const HALF_HOUR_MINUTES = 30

export class MonitorError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "MonitorError"
    this.code = code
    this.details = details
  }
}
