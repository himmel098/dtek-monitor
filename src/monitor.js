import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import { loadConfig } from "./config.js"
import { buildResult, selectName } from "./helpers.js"
import { saveWithComparison } from "./state.js"
import {
  ACTION_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  RETRIES_MAX_COUNT,
  RETRIES_TIMEOUT_MS,
  TIME_ZONE,
  MonitorError,
} from "./constants.js"

async function chooseSuggestion(page, field, value) {
  await page.locator(`#discon_form #${field}`).fill(value)
  const options = page.locator(`#discon_form #${field}autocomplete-list > div`)
  await options.first().waitFor({ state: "visible" })
  const names = await options
    .locator('input[type="hidden"]')
    .evaluateAll((inputs) => inputs.map((input) => input.value))
  const index = names.indexOf(value)
  if (index < 0)
    throw new MonitorError("ADDRESS_NOT_FOUND", `${field}: ${value}`, {
      candidates: names,
    })
  await options.nth(index).click()
}

async function getInfo(config) {
  const browser = await chromium.launch({
    headless: !config.headed,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  })
  try {
    const page = await browser.newPage({
      locale: "uk-UA",
      timezoneId: TIME_ZONE,
    })
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    const notices = []
    // The notice may appear after DOMContentLoaded. Handle it when it blocks an action.
    await page.addLocatorHandler(
      page.locator("#modal-attention.is-open .modal__overlay"),
      async () => {
        const attention = page.locator("#modal-attention")
        notices.push((await attention.innerText()).trim())
        await attention.locator("button[data-micromodal-close]").click()
      }
    )
    await page.goto(config.url, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () =>
        typeof DisconSchedule !== "undefined" &&
        DisconSchedule.preset &&
        DisconSchedule.fact &&
        DisconSchedule.ajax.url
    )
    const streets = await page.evaluate(() => DisconSchedule.streets)
    if (!streets || typeof streets !== "object")
      throw new MonitorError("INVALID_RESPONSE", "Address directory missing.")
    const city =
      config.region === "k" && !config.city
        ? selectName("Київ", Object.keys(streets), "city")
        : selectName(config.city, Object.keys(streets), "city")
    const street = selectName(config.street, streets[city], "street")
    const cityInput = page.locator("#discon_form #city")
    if ((await cityInput.isVisible()) && (await cityInput.isEnabled())) {
      await chooseSuggestion(page, "city", city)
    }
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request()
      return (
        new URL(response.url()).pathname === "/ua/ajax" &&
        request.method() === "POST" &&
        new URLSearchParams(request.postData() ?? "").get("method") ===
          "getHomeNum"
      )
    })
    // Attach the rejection handler before clicking, even if the UI action fails.
    responsePromise.catch(() => {})
    await chooseSuggestion(page, "street", street)
    const networkResponse = await responsePromise
    if (!networkResponse.ok())
      throw new MonitorError(
        "HTTP_ERROR",
        `DTEK HTTP ${networkResponse.status()}`
      )
    let response
    try {
      response = await networkResponse.json()
    } catch {
      throw new MonitorError(
        "INVALID_RESPONSE",
        "DTEK returned non-JSON content (possible verification page)."
      )
    }
    if (response.result !== true)
      throw new MonitorError("INVALID_RESPONSE", "Address request failed.")
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#discon_form #street")
          .closest(".discon-input-wrapper")
          .classList.contains("preloader-spinner")
    )
    const matchedHouse = Object.keys(response.data ?? {}).find(
      (key) =>
        key.trim().toLocaleLowerCase("uk") ===
        config.house.toLocaleLowerCase("uk")
    )
    if (matchedHouse) await chooseSuggestion(page, "house_num", matchedHouse)
    const snapshot = await page.evaluate(() => ({
      preset: DisconSchedule.preset,
      fact: DisconSchedule.fact,
    }))
    return {
      ...buildResult({
        config,
        address: { city, street },
        response,
        preset: response.preset ?? snapshot.preset,
        fact: response.fact ?? snapshot.fact,
      }),
      notices,
    }
  } finally {
    await browser.close()
  }
}

async function run() {
  const config = loadConfig()
  if (config.help) {
    console.log(
      JSON.stringify({
        usage:
          "node src/monitor.js --region o --city Одеса --street 'вул. Назва' --house 1",
        options: ["--region", "--city", "--street", "--house", "--headed"],
        env: ["REGION", "CITY", "STREET", "HOUSE"],
      })
    )
    return
  }
  for (let attempt = 0; attempt <= RETRIES_MAX_COUNT; attempt++) {
    try {
      const result = saveWithComparison(await getInfo(config))
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return
    } catch (error) {
      console.error(
        `Getting info failed (attempt ${attempt + 1}): ${error.message}`
      )
      if (error instanceof MonitorError || attempt === RETRIES_MAX_COUNT)
        throw error
      await delay(RETRIES_TIMEOUT_MS)
    }
  }
}

run().catch((error) => {
  const result = {
    schemaVersion: 1,
    result: false,
    error: {
      code: error.code ?? "FETCH_FAILED",
      message: error.message,
      ...(error.details ?? {}),
    },
  }
  console.error(error.message)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = 1
})
