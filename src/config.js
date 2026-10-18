import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { MonitorError, SHUTDOWNS_PAGES } from "./constants.js"

export function loadConfig(args = process.argv.slice(2)) {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url))
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const { values } = parseArgs({
    args,
    options: {
      region: { type: "string" },
      city: { type: "string" },
      street: { type: "string" },
      house: { type: "string" },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) return { help: true }

  const config = Object.fromEntries(
    ["region", "city", "street", "house"].map((key) => [
      key,
      (values[key] ?? process.env[key.toUpperCase()] ?? "").trim(),
    ])
  )
  config.region = config.region.toLowerCase()
  const missing = ["region", "street", "house"].filter((key) => !config[key])
  if (config.region !== "k" && !config.city) missing.push("city")
  if (missing.length) {
    throw new MonitorError("INVALID_CONFIG", `Missing: ${missing.join(", ")}`)
  }
  if (!Object.hasOwn(SHUTDOWNS_PAGES, config.region)) {
    throw new MonitorError(
      "INVALID_CONFIG",
      "Unknown region. Use k, kr, dn, o or d."
    )
  }
  return {
    ...config,
    headed: values.headed,
    url: SHUTDOWNS_PAGES[config.region],
  }
}
