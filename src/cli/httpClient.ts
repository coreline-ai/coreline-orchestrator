export interface CliApiClientOptions {
  baseUrl?: string
  apiToken?: string
  fetchImpl?: typeof fetch
}

export interface CliApiRequestOptions {
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  output?: 'json' | 'text'
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4310/api/v1'

export async function requestCliApi(
  path: string,
  options: CliApiRequestOptions = {},
  clientOptions: CliApiClientOptions = {},
): Promise<unknown> {
  const fetchImpl = clientOptions.fetchImpl ?? fetch
  const relativePath = path.startsWith('/') ? path.slice(1) : path
  const url = new URL(relativePath, normalizeBaseUrl(clientOptions.baseUrl))
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) {
      continue
    }
    url.searchParams.set(key, String(value))
  }

  const response = await fetchImpl(url, {
    method: options.method ?? 'GET',
    headers: {
      accept: options.output === 'text' ? 'text/plain, application/json' : 'application/json',
      ...(clientOptions.apiToken === undefined
        ? {}
        : { authorization: `Bearer ${clientOptions.apiToken}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

  if (!response.ok) {
    const failureBody = await response.text()
    throw new Error(
      `CLI API request failed (${response.status} ${response.statusText}): ${failureBody}`,
    )
  }

  return options.output === 'text' ? await response.text() : await response.json()
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl ?? DEFAULT_API_BASE_URL).trim()
  if (normalized.length === 0) {
    return DEFAULT_API_BASE_URL
  }
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}
