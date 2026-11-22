import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { buildResult, selectName } from './helpers.js'

function assignment(html, field) {
  const value = html.match(new RegExp(`(?:^|<script>)\\s*DisconSchedule\\.${field}\\s*=\\s*([^\\r\\n]+)`, 'm'))?.[1]?.split(/<\/script>/i, 1)[0].trim().replace(/;$/, '')
  if (!value) throw new Error(`DTEK page missing ${field}`)
  return JSON.parse(value)
}

function meta(html, name) {
  return html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]+)"`, 'i'))?.[1]
}

export async function collectHttp(config, request = fetch) {
  const page = await request(config.url, { signal: AbortSignal.timeout(15_000) })
  if (!page.ok) throw new Error(`DTEK page HTTP ${page.status}`)
  const html = await page.text()
  let streets, fact, preset
  try {
    streets = assignment(html, 'streets')
    fact = assignment(html, 'fact')
    preset = assignment(html, 'preset')
  } catch (error) {
    const expectedPath = new URL(config.url).pathname
    const finalPath = page.url ? new URL(page.url).pathname : null
    const mediaType = page.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    console.warn('DTEK page parse failed', {
      status: page.status,
      redirected: page.redirected,
      path: finalPath === expectedPath || finalPath === '/' ? finalPath : finalPath ? '[unexpected path]' : null,
      contentType: ['text/html', 'application/json', 'text/plain', 'application/xhtml+xml'].includes(mediaType) ? mediaType : null,
      bodyBytes: Buffer.byteLength(html),
      markers: Object.fromEntries(['streets', 'fact', 'preset'].map((field) => [field, html.includes(`DisconSchedule.${field}`)])),
    })
    // JSON.parse errors may include excerpts from the response body.
    if (error instanceof SyntaxError) throw new Error('DTEK page contains invalid schedule JSON')
    throw error
  }
  const city = selectName(config.city || 'Київ', Object.keys(streets), 'city')
  const street = selectName(config.street, streets[city], 'street')
  const endpoint = new URL(meta(html, 'ajaxUrl') ?? '/ua/ajax', config.url)
  if (endpoint.origin !== new URL(config.url).origin || endpoint.pathname !== '/ua/ajax') throw new Error('Unexpected DTEK form endpoint')
  const data = new URLSearchParams({ method: 'getHomeNum' })
  for (const [i, [name, value]] of Object.entries({ city, street, updateFact: fact.update ?? '' }).entries()) {
    data.set(`data[${i}][name]`, name)
    data.set(`data[${i}][value]`, value)
  }
  const csrfName = meta(html, 'csrf-param')
  const csrfToken = meta(html, 'csrf-token')
  if (csrfName && csrfToken) data.set(csrfName, csrfToken)
  const cookie = page.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
  const response = await request(endpoint, {
    method: 'POST', body: data, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { referer: config.url, origin: endpoint.origin, 'x-requested-with': 'XMLHttpRequest', ...(cookie && { cookie }) },
  })
  if (!response.ok) throw new Error(`DTEK address HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('DTEK address returned non-JSON')
  const result = await response.json()
  return buildResult({ config, address: { city, street }, response: result, fact: result.fact ?? fact, preset: result.preset ?? preset })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await collectHttp(loadConfig())
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`)
    process.exitCode = 1
  }
}
