import Debug from 'debug'
import * as http from 'http'
import * as https from 'https'
import { Application, Request } from 'express'
import express from 'express'
import { Config } from '../config.js'
import { HttpErrorsEnum } from '../../shared/specification/index.js'
import { LogLevelEnum, Logger } from '../../specification/index.js'

import { apiUri } from '../../shared/server/index.js'
import { ConfigPersistence } from '../persistence/configPersistence.js'
import { createAuthMiddleware } from './auth/authMiddleware.js'
import { initOidc, registerOidcRoutes, setupSession, type OidcConfig } from './auth/oidc.js'
import { sendResult } from './sendResult.js'
import { AngularStatics } from './angularStatics.js'
import { WebuiStatics } from './webuiStatics.js'
import { corsMiddleware } from './corsMiddleware.js'
import * as fs from 'fs'
import { join } from 'path'

interface IAddonInfo {
  slug: string
  ingress: boolean
  ingress_entry: string
  ingress_panel: boolean
  ingress_port: number
  ingress_url: string
}

const debug = Debug('HttpServerBase')
const debugUrl = Debug('HttpServerBaseUrl')
const log = new Logger('HttpServerBase')

export class HttpServerBase {
  protected app: Application
  server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>
  httpsServer?: https.Server
  protected oidcConfig: OidcConfig | null = null
  private angularStatics: AngularStatics
  private webuiStatics: WebuiStatics
  constructor(private angulardir: string = '.') {
    this.app = express()
    this.angularStatics = new AngularStatics(angulardir)
    this.webuiStatics = new WebuiStatics(angulardir)
  }
  /** Node-level request listener; lets tests (supertest) drive the server without framework internals */
  get requestListener(): http.RequestListener {
    return this.app
  }
  returnResult(
    req: express.Request,
    res: http.ServerResponse,
    code: HttpErrorsEnum,
    message: unknown,
    object: unknown = undefined
  ) {
    sendResult(req, res, code, message, object)
  }
  listen(listenFunction: () => void) {
    const config = Config.getConfiguration()
    const httpsPort = config.httpsPort

    if (httpsPort) {
      // Auto-detect: check if certificate files exist in sslDir
      const persistence = new ConfigPersistence()
      const certData = persistence.readCertificateFile(config.httpsCertFile)
      const keyData = persistence.readCertificateFile(config.httpsKeyFile)

      if (certData && keyData) {
        // Certificates found — start HTTPS server with the app
        this.httpsServer = https.createServer({ cert: certData, key: keyData }, this.app)
        this.httpsServer.listen(httpsPort, () => {
          log.log(LogLevelEnum.info, `HTTPS listening on port ${httpsPort}`)
          listenFunction()
        })

        // HTTP server only redirects to HTTPS
        const redirectApp = express()
        redirectApp.all(/.*/, (req: Request, res: express.Response) => {
          const host = req.hostname
          const httpsUrl = `https://${host}:${httpsPort}${req.originalUrl}`
          // 302 (temporary), never 301: the same HTTP port serves the app directly in
          // HTTP-only/debug mode, and browsers cache a 301 permanently — a cached 301 would
          // keep redirecting to an HTTPS port that is no longer listening.
          res.redirect(302, httpsUrl)
        })
        this.server = redirectApp.listen(config.httpport, () => {
          log.log(LogLevelEnum.info, `HTTP redirecting to HTTPS on port ${config.httpport}`)
        })
        return
      } else {
        log.log(
          LogLevelEnum.info,
          `HTTPS disabled: certificate files not found (${config.httpsCertFile}, ${config.httpsKeyFile} in ${ConfigPersistence.sslDir})`
        )
      }
    }

    // No HTTPS: HTTP server serves the app directly
    this.server = this.app.listen(config.httpport, listenFunction)
  }
  close() {
    if (this.httpsServer) this.httpsServer.close()
    if (this.server) this.server.close()
  }
  initApp() {}
  init(): Promise<void> {
    return initOidc().then(
      (oidc) =>
        new Promise<void>((resolve) => {
          this.oidcConfig = oidc
          try {
            Config.executeHassioGetRequest<{ data: IAddonInfo }>(
              '/addons/self/info',
              (info) => {
                this.angularStatics.setIngressUrl(info.data.ingress_entry)
                this.webuiStatics.setIngressUrl(info.data.ingress_entry)
                const port = Config.getConfiguration().httpport
                log.log(LogLevelEnum.info, 'Hassio authentication prefix:' + info.data.ingress_entry + ' modbus2mqtt: ' + port)
                this.initBase()
                resolve()
              },
              (e) => {
                const port = Config.getConfiguration().httpport
                log.log(LogLevelEnum.warn, 'Hassio authentication failed ' + e.message + ' modbus2mqtt: ' + port)
                this.initBase()
                resolve()
              }
            )
          } catch {
            this.initBase()
            resolve()
          }
        })
    )
  }

  processAll(req: Request, res: express.Response) {
    // SPA fallback at the root: serve the new webui index (the legacy Angular
    // UI is mounted separately under /old-ui).
    this.webuiStatics.sendIndexFile(req, res)
  }

  /** Serves the legacy Angular webui under /old-ui (index + SPA fallback). */
  processOldUi(req: Request, res: express.Response) {
    const enLangDir = this.getAngularEnDir()
    if (!enLangDir) {
      res.status(404).setHeader('Content-Type', 'text/html').send('old-webui not found')
      return
    }
    const file = join(enLangDir, 'index.html')
    if (!fs.existsSync(file)) {
      res.status(404).setHeader('Content-Type', 'text/html').send('old-webui index not found')
      return
    }
    // Rewrite <base href> to the /old-ui path so the Angular assets (referenced
    // as /old-ui/en-US/…) resolve correctly — also behind the HA ingress proxy
    // (the ingress prefix is applied by AngularStatics via setIngressUrl).
    let content = fs.readFileSync(file).toString()
    const baseHref = '/old-ui/en-US/'
    content = content.replace(/<base[^>]*>/, '<base href="' + baseHref + '">')
    const buf = Buffer.from(content)
    res.status(200).setHeader('Content-Type', 'text/html').setHeader('Content-Length', buf.byteLength)
    res.send(buf)
  }
  initBase() {
    this.angularStatics.init()

    this.app.use(express.json({ limit: '50mb' }))
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }))
    this.app.use(corsMiddleware)
    // Session + OIDC routes (only active if OIDC is configured)
    if (this.oidcConfig) {
      setupSession(this.app)
      registerOidcRoutes(this.app, this.oidcConfig)
    }
    // API routes (registered in initApp) come first so /api/* is not shadowed
    // by the root static webui below.
    this.initApp()

    // ---- New webui at the root (/) ----
    // The HA_enoceanmqtt-style configurator uses only relative asset paths, so
    // serving it from / works directly and behind the HA ingress proxy.
    this.app.use(express.static(this.webuiStatics.getDir()))

    // ---- Legacy Angular webui at /old-ui ----
    // The Angular en-<lang> dir has <base href="./en-US/"> (relative), so serving
    // it under /old-ui resolves its assets as /old-ui/en-US/...
    const enLangDir = this.getAngularEnDir()
    if (enLangDir) {
      // Handle the index explicitly before express.static so /old-ui (no
      // trailing slash) serves the rewritten index instead of a 301.
      this.app.get('/old-ui', this.processOldUi.bind(this))
      this.app.get('/old-ui/', this.processOldUi.bind(this))
      // Serve the Angular build dir (parent of en-US/) so /old-ui/en-US/* resolves.
      this.app.use('/old-ui', express.static(this.angulardir))
      this.app.use('/old-ui', this.processOldUi.bind(this)) // SPA fallback
    }

    // Catch-all: anything not matched (e.g. unknown /api route, old /webui link)
    // falls back to the webui index at the root.
    this.app.use(this.webuiStatics.middleware())
    this.app.all(/.*/, this.processAll.bind(this))
  }

  /** Returns the Angular language directory (e.g. <angulardir>/en-US) if present. */
  private getAngularEnDir(): string | null {
    if (!this.angulardir || !fs.existsSync(this.angulardir)) return null
    const entries = fs.readdirSync(this.angulardir)
    for (const entry of entries) {
      const full = join(this.angulardir, entry)
      if (entry.indexOf('-') >= 0 && fs.statSync(full).isDirectory()) return full
    }
    return null
  }
}
