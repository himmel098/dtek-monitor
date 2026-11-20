import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { createHandler } from '../src/lambda.js'

test('Lambda saves the full snapshot, stays quiet on first run and retains state on failed delivery', async () => {
  let item, sends = 0, available = false
  const db = { async send(command) {
    assert.equal(command.input.TableName, 'test-table')
    if (command instanceof GetItemCommand) return { Item: item }
    assert.ok(command instanceof PutItemCommand)
    item = command.input.Item
    return {}
  } }
  const snapshot = { result: true, address: { region: 'o', city: 'Одеса', street: 'тест', house: '1' }, groups: [] }
  const handler = createHandler({ db, collectResult: async () => snapshot,
    env: { DTEK_TABLE: 'test-table', TELEGRAM_BOT_TOKEN: '123:fake', TELEGRAM_CHAT_ID: '-100' },
    request: async () => {
      sends++
      return { ok: available, status: available ? 200 : 403, json: async () => ({ ok: available, result: { message_id: 42 } }) }
    },
  })
  assert.equal((await handler()).outcome, 'baseline_created')
  const saved = item
  assert.deepEqual(JSON.parse(gunzipSync(item.payload.B)).snapshot, snapshot)
  snapshot.currentOutage = { reported: true, data: { sub_type: 'Екстрене' } }
  await assert.rejects(handler, /403/)
  assert.equal(item, saved)
  available = true
  assert.equal((await handler()).outcome, 'notified')
  assert.equal((await handler()).outcome, 'no_alert')
  assert.equal(sends, 2)
})
