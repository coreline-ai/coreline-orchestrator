import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { createHarnessPlaygroundRouter } from './routes/harnessPlaygrounds.js'

describe('harness playground routes', () => {
  const app = new Hono()
  app.route('/', createHarnessPlaygroundRouter({ version: '0.4.0' }))

  test('index route lists all three runnable previews', async () => {
    const response = await app.request('/playgrounds')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('16-fullstack-webapp')
    expect(html).toContain('36-design-system')
    expect(html).toContain('42-bi-dashboard')
  })

  test('fullstack preview renders a live API shell', async () => {
    const response = await app.request('/playgrounds/harness/16-fullstack-webapp')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Live control-plane shell')
    expect(html).toContain('/distributed/readiness')
    expect(html).toContain('jobsView')
  })

  test('design-system preview renders actual UI tokens and components', async () => {
    const response = await app.request('/playgrounds/harness/36-design-system')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Primary action')
    expect(html).toContain('token-card')
    expect(html).toContain('This is now an executable preview page')
  })

  test('bi dashboard preview renders telemetry-oriented widgets', async () => {
    const response = await app.request('/playgrounds/harness/42-bi-dashboard')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Jobs Total')
    expect(html).toContain('Readiness Alerts')
    expect(html).toContain('/audit')
  })
})
