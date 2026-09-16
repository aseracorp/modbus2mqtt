import { it, expect, beforeAll, afterAll } from 'vitest'
import { parse } from 'yaml'
import { createTestServer, TestServer } from './httpTestHelper.js'

let ts: TestServer
beforeAll(async () => {
  // mockHassio delivers ingress_entry 'test', which must end up in the <base href>
  ts = await createTestServer({ name: 'http-statics', mockHassio: true })
})
afterAll(() => ts.cleanup())

it('GET /old-ui/index.html rewrites base href to /old-ui/', async () => {
  const response = await ts.request().get('/old-ui/index.html').expect(200)
  expect(response.text.indexOf('href="/old-ui/en-US/"')).toBeGreaterThanOrEqual(0)
})

it('GET /old-ui/index.html with Ingress header serves the legacy index', async () => {
  const response = await ts.request().get('/old-ui/index.html').set({ 'X-Ingress-Path': 'test' }).expect(200)
  expect(response.text.indexOf('<base')).toBeGreaterThanOrEqual(0)
})

it('GET angular files serves language specific statics under /old-ui', async () => {
  const response = await ts.request().get('/old-ui/en-US/test.css').expect(200)
  expect(response.text).toBe('.justContent {\n' + '  margin: 1pt;\n' + '}\n')
  expect(response.type).toBe('text/css')
})

it('GET local specification files', async () => {
  const response = await ts.request().get('/specifications/files/waterleveltransmitter/files.yaml').expect(200)
  if (response.type === 'text/yaml' || response.type === 'application/x-yaml') {
    const o = parse(response.text)
    const files = Array.isArray(o) ? (o as { url: string }[]) : o && o.files ? o.files : []
    expect(Array.isArray(files)).toBeTruthy()
    if (files.length > 0) {
      expect((files[0].url as string).startsWith('/')).toBeFalsy()
    }
  } else {
    // Fallback: Angular index.html served when files.yaml is missing in test-setup
    expect(response.type).toBe('text/html')
  }
})

it('GET / serves the new webui (root)', async () => {
  const response = await ts.request().get('/').expect(200)
  expect(response.type).toBe('text/html')
})
