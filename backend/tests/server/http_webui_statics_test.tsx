import { it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, request as httpRequest } from 'http'
import express from 'express'
import { join } from 'path'
import { createTestServer, TestServer } from './httpTestHelper.js'
import { WebuiStatics } from '../../src/server/http/webuiStatics.js'

let ts: TestServer
beforeAll(async () => {
  // webui is mounted at /webui; mockHassio provides the ingress entry used for base-href rewrites
  ts = await createTestServer({ name: 'http-webui-statics', mockHassio: true })
})
afterAll(() => ts.cleanup())

it('GET /webui redirects to /webui/ (express static directory index)', async () => {
  const response = await ts.request().get('/webui').expect(301)
  expect(response.headers['location']).toBe('/webui/')
})

it('GET /webui/ serves the static index.html', async () => {
  const response = await ts.request().get('/webui/').expect(200)
  expect(response.type).toBe('text/html')
  expect(response.text).toContain('Webui Fixture')
  expect(response.text.indexOf('href="style.css"')).toBeGreaterThanOrEqual(0)
})

it('GET /webui/index.html serves the static index.html', async () => {
  const response = await ts.request().get('/webui/index.html').expect(200)
  expect(response.type).toBe('text/html')
  expect(response.text).toContain('Webui Fixture')
})

it('GET /webui/style.css serves the stylesheet with correct content type', async () => {
  const response = await ts.request().get('/webui/style.css').expect(200)
  expect(response.type).toBe('text/css')
  expect(response.text.indexOf('#f4f5f7')).toBeGreaterThanOrEqual(0)
  expect(response.text.indexOf('Public Sans')).toBeGreaterThanOrEqual(0)
})

it('GET /webui/app.js serves the webui script', async () => {
  const response = await ts.request().get('/webui/app.js').expect(200)
  expect(response.type).toBe('text/javascript')
  expect(response.text.indexOf('webuiFixture')).toBeGreaterThanOrEqual(0)
})

it('GET /webui/lang/en.js serves a language file', async () => {
  const response = await ts.request().get('/webui/lang/en.js').expect(200)
  expect(response.type).toBe('text/javascript')
  expect(response.text).toContain('Web Configurator')
})

it('GET /webui/lang/de.js serves another language file', async () => {
  const response = await ts.request().get('/webui/lang/de.js').expect(200)
  expect(response.type).toBe('text/javascript')
  expect(response.text).toContain('Web-Konfigurator')
})

it('GET /webui/missing.js 404s instead of falling through to the SPA', async () => {
  const response = await ts.request().get('/webui/missing.js').expect(404)
  expect(response.text).toContain('Not Found')
})

it('GET /webui/deep/nested.html 404s for files outside the webui dir', async () => {
  const response = await ts.request().get('/webui/deep/nested.html').expect(404)
})

it('path traversal outside the webui dir is refused (isolated handler)', async () => {
  // In the full HttpServer the Angular statics middleware (mounted earlier) normalises
  // /webui/../index.html via path.join and serves the SPA index before the webui mount
  // runs — so to exercise the webui handler's traversal guard we mount it alone.
  const webuiStatics = new WebuiStatics(join('tests/server/config-dir', 'angular'))
  const app = express()
  app.use('/webui', webuiStatics.middleware())
  app.use((_req, res) => res.status(404).send('no fallthrough'))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const raw = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    const res = await raw('/webui/../index.html')
    expect(res.status).toBe(404)
    expect(res.body).toContain('Not Found')
    // a plain (non-traversal) relative asset still works through the handler
    const ok = await raw('/webui/style.css')
    expect(ok.status).toBe(200)
    expect(ok.body.indexOf('#f4f5f7')).toBeGreaterThanOrEqual(0)
  } finally {
    server.close()
  }
})

it('webui assets stay reachable when requested relative (no base href rewrite)', async () => {
  const index = await ts.request().get('/webui/').expect(200)
  // The fixture references style.css relatively; the URL must resolve without a prefix
  expect(index.text.indexOf('href="style.css"')).toBeGreaterThanOrEqual(0)
  const css = await ts.request().get('/webui/style.css').expect(200)
  expect(css.text.indexOf('#141414')).toBeGreaterThanOrEqual(0)
})
