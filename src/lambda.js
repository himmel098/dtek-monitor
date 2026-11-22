import { gzipSync, gunzipSync } from "node:zlib"
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb"
import { planAlert } from "./alerts.js"
import { loadConfig } from "./config.js"
import { collectHttp } from "./monitor-http.js"

export function createHandler({ db, collectResult, request = fetch, env = process.env }) {
  return async () => {
    const { DTEK_TABLE: TableName, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = env
    if (!TableName || !/^\d+:[A-Za-z0-9_-]+$/u.test(token ?? "") || !chat) {
      throw new Error("Missing DTEK_TABLE or Telegram configuration")
    }
    const Key = { id: { S: "latest" } }
    const result = await collectResult()
    const { Item } = await db.send(new GetItemCommand({ TableName, Key, ConsistentRead: true }))
    const previous = Item ? JSON.parse(gunzipSync(Item.payload.B).toString("utf8")) : null
    const { state, message } = planAlert(result, previous?.state)
    const payload = gzipSync(JSON.stringify({ state, snapshot: result }))
    if (payload.length > 390 * 1024) throw new Error("DTEK snapshot exceeds the DynamoDB item limit")
    if (message) {
      let response, data
      try {
        response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
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
    // Keep the previous snapshot until any required Telegram message is acknowledged.
    await db.send(new PutItemCommand({ TableName, Item: { ...Key, payload: { B: payload } } }))
    const outcome = message ? "notified" : previous?.state?.key === state.key ? "no_alert" : "baseline_created"
    console.info(`DTEK: ${outcome}`)
    return { outcome }
  }
}

const db = new DynamoDBClient({})
export const handler = createHandler({ db, collectResult: async () => {
  const config = loadConfig([])
  return collectHttp(config)
} })
