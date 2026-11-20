import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config.js"
import { collect } from "./monitor.js"
import { planAlert } from "./alerts.js"

async function run() {
  const config = loadConfig([])
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chat = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token ?? "")) throw new Error("Set TELEGRAM_BOT_TOKEN")
  if (!chat) throw new Error("Set TELEGRAM_CHAT_ID")
  const key = createHash("sha256").update(`dtek-alert-v1\0${process.env.DTEK_STATE_SECRET || token}`).digest()
  const file = fileURLToPath(new URL("../artifacts/alert-state/baseline.enc", import.meta.url))
  let encoded
  try { encoded = await readFile(file) } catch (error) { if (error.code !== "ENOENT") throw error }
  let previous = null
  if (encoded) {
    try {
      const cipher = createDecipheriv("aes-256-gcm", key, encoded.subarray(0, 12))
      cipher.setAuthTag(encoded.subarray(12, 28))
      previous = JSON.parse(Buffer.concat([cipher.update(encoded.subarray(28)), cipher.final()]))
      if (previous.version !== 1 || !previous.dates) throw new Error("Invalid state")
    } catch {
      throw new Error("Cannot decrypt or read DTEK baseline; check DTEK_STATE_SECRET")
    }
  }
  const { state, message } = planAlert(await collect(config), previous)
  if (message) {
    let response, data
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: message, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      })
      data = await response.json()
    } catch {
      throw new Error("Telegram request failed or returned invalid JSON")
    }
    if (!response.ok || data?.ok !== true || !data.result?.message_id) {
      throw new Error(`Telegram did not confirm delivery (HTTP ${response.status})`)
    }
  }
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const payload = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()])
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temp, Buffer.concat([nonce, cipher.getAuthTag(), payload]), { flag: "wx", mode: 0o600 })
  await rename(temp, file)
}

run().catch((error) => {
  console.error(`DTEK monitor: ${error.message}`)
  process.exitCode = 1
})
