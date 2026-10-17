import { Component, Input, OnDestroy, signal, computed } from '@angular/core'
import { FormBuilder, FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms'
import { ApiService } from '../services/api-service'
import { TranslationService } from '../services/translation.service'
import { MatFormField, MatLabel, MatOption, MatSelect } from '@angular/material/select'
import { MatIconButton } from '@angular/material/button'
import { MatIcon } from '@angular/material/icon'
import { MatTooltip } from '@angular/material/tooltip'
import { MatSlideToggle } from '@angular/material/slide-toggle'
import { Subscription, interval } from 'rxjs'
import { TrendDialogComponent } from './trend-dialog/trend-dialog.component'
import {
  SnifferBusConfig,
  SnifferRegisterRow,
  SnifferDeviceRow,
  SnifferTelegramRow,
  SnifferState,
} from '@shared/server'

export type SnifferView = 'live' | 'history'

/**
 * RTU sniffer panel for a single bus. Shown inside the bus card of the
 * SelectModbus view. Lets the user start/stop the sniffer (stack hook by
 * default, or a passive tap port), watch the live telegram log, inspect the
 * discovered devices and registers, and open a full telegram history view with
 * time filter + pagination.
 *
 * Views:
 *  - live:   current telegram tail, devices, registers (auto-refresh while running)
 *  - history: every telegram in the DB (both directions), newest first, with
 *             timestamp column, time-range filter and server-side pagination
 *
 * All tables are paginated so large captures (10k+ telegrams) stay responsive.
 */
@Component({
  selector: 'app-sniffer',
  templateUrl: './sniffer.component.html',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatFormField,
    MatLabel,
    MatSelect,
    MatOption,
    MatIconButton,
    MatIcon,
    MatTooltip,
    MatSlideToggle,
    TrendDialogComponent,
  ],
  standalone: true,
})
export class SnifferComponent implements OnDestroy {
  /** Exposed for template access to the static formatter. */
  readonly SnifferComponent = SnifferComponent
  @Input() busId: number = 0
  @Input() busName: string = ''

  config: SnifferBusConfig = { busId: 0, mode: 'stack', enabled: false }
  state: SnifferState | undefined
  modeControl: FormControl<string | null>
  enabledControl: FormControl<boolean | null>
  private refreshSub: Subscription | undefined

  // ---- view switching ----
  view: SnifferView = 'live'

  // ---- live data ----
  telegrams: SnifferTelegramRow[] = []
  devices: SnifferDeviceRow[] = []
  registers: SnifferRegisterRow[] = []

  // ---- history (paginated, server-side) ----
  history: SnifferTelegramRow[] = []
  historyTotal = 0
  historyPage = 1
  historyPageSize = 100
  historyFrom?: number
  historyTo?: number
  historyLoading = false

  // ---- pagination (live tables) ----
  // telegrams (server-side)
  telegramTotal = 0
  telegramPage = 1
  telegramPageSize = 100
  // devices + registers (client-side slice)
  devicePage = 1
  devicePageSize = 20
  registerPage = 1
  registerPageSize = 25

  // ---- trend popup ----
  trendReg: SnifferRegisterRow | undefined

  // Signals so the template can compute slices reactively without extra code.
  readonly devicePageSignal = signal(1)
  readonly registerPageSignal = signal(1)

  pagedDevices = computed(() => {
    const pg = this.devicePageSignal()
    const start = (pg - 1) * this.devicePageSize
    return this.devices.slice(start, start + this.devicePageSize)
  })
  pagedRegisters = computed(() => {
    const pg = this.registerPageSignal()
    const start = (pg - 1) * this.registerPageSize
    return this.registers.slice(start, start + this.registerPageSize)
  })

  private static fmt = (n: number): string => n.toString().padStart(2, '0')
  private static hex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase()

  constructor(
    private api: ApiService,
    private fb: FormBuilder,
    private translation: TranslationService
  ) {
    this.modeControl = this.fb.control('stack')
    this.enabledControl = this.fb.control(false)
  }

  t = (key: string) => this.translation.map()[key] ?? key

  ngOnInit(): void {
    this.load()
  }

  ngOnDestroy(): void {
    this.stopRefresh()
  }

  /** (Re)loads the config and (if running) the live data. Called by the parent. */
  load(): void {
    if (this.busId === 0) return
    this.api.getSnifferConfig(this.busId).subscribe((config) => {
      if (config && config.busId) {
        this.config = config
        this.modeControl.setValue(config.mode)
        this.enabledControl.setValue(config.enabled)
      }
    })
    this.refresh()
    if (this.view === 'history') this.loadHistory()
  }

  /** Reloads live tables (with their current pagination). */
  private refresh(): void {
    this.api.getSnifferState(this.busId).subscribe((state) => {
      this.state = state
      if (state && state.running) {
        this.loadTelegrams()
        this.api.getSnifferDevices(this.busId).subscribe((d) => {
          this.devices = d
          this.devicePageSignal.set(1)
        })
        this.api.getSnifferRegisters(this.busId).subscribe((r) => {
          this.registers = r
          this.registerPageSignal.set(1)
        })
        this.startRefresh()
      } else {
        this.stopRefresh()
        this.telegrams = []
        this.devices = []
        this.registers = []
      }
    })
  }

  /** Loads the current telegram page (live table). */
  private loadTelegrams(): void {
    const offset = (this.telegramPage - 1) * this.telegramPageSize
    this.api.getSnifferTelegrams(this.busId, undefined, this.telegramPageSize, offset).subscribe((res) => {
      this.telegrams = res.rows
      this.telegramTotal = res.total
    })
  }

  /** Loads the current history page (server-side filter + pagination). */
  loadHistory(): void {
    this.historyLoading = true
    const offset = (this.historyPage - 1) * this.historyPageSize
    this.api
      .getSnifferTelegrams(this.busId, undefined, this.historyPageSize, offset, this.historyFrom, this.historyTo)
      .subscribe({
        next: (res) => {
          this.history = res.rows
          this.historyTotal = res.total
          this.historyLoading = false
        },
        error: () => (this.historyLoading = false),
      })
  }

  switchView(v: SnifferView): void {
    this.view = v
    if (v === 'history') {
      this.loadHistory()
      this.stopRefresh() // don't poll while browsing history
    } else {
      this.refresh()
    }
  }

  /** Resets the history pagination and refetches (after filter change). */
  applyHistoryFilter(): void {
    this.historyPage = 1
    this.loadHistory()
  }
  clearHistoryFilter(): void {
    this.historyFrom = undefined
    this.historyTo = undefined
    this.historyPage = 1
    this.loadHistory()
  }

  /** Converts epoch seconds to a datetime-local input value (yyyy-MM-ddTHH:mm). */
  toLocalInput(epochSec: number): string {
    const d = new Date(epochSec * 1000)
    return (
      d.getFullYear() +
      '-' +
      SnifferComponent.fmt(d.getMonth() + 1) +
      '-' +
      SnifferComponent.fmt(d.getDate()) +
      'T' +
      SnifferComponent.fmt(d.getHours()) +
      ':' +
      SnifferComponent.fmt(d.getMinutes())
    )
  }
  onHistoryFromInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value
    this.historyFrom = v ? new Date(v).getTime() / 1000 : undefined
  }
  onHistoryToInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value
    this.historyTo = v ? new Date(v).getTime() / 1000 : undefined
  }

  private startRefresh(): void {
    if (this.refreshSub) return
    // Poll every 2s while running so the telegram log stays live.
    this.refreshSub = interval(2000).subscribe(() => {
      this.api.getSnifferState(this.busId).subscribe((state) => {
        this.state = state
        if (!state || !state.running) {
          this.stopRefresh()
          this.telegrams = []
          return
        }
        this.loadTelegrams()
        this.api.getSnifferDevices(this.busId).subscribe((d) => (this.devices = d))
        this.api.getSnifferRegisters(this.busId).subscribe((r) => (this.registers = r))
      })
    })
  }

  private stopRefresh(): void {
    if (this.refreshSub) {
      this.refreshSub.unsubscribe()
      this.refreshSub = undefined
    }
  }

  saveConfig(): void {
    this.config.busId = this.busId
    this.config.busName = this.busName
    const mode = this.modeControl.value ?? 'stack'
    this.config.mode = mode === 'tap' || mode === 'auto' ? mode : 'stack'
    // Tap device and baud rate are intentionally not configurable here: the
    // sniffer always uses the same connection the modbus bus listens on.
    this.config.enabled = this.enabledControl.value ?? false
    this.api.postSnifferConfig(this.config).subscribe(() => {
      if (this.config.enabled && !this.state?.running) void this.start()
    })
  }

  start(): void {
    this.api.snifferStart(this.busId).subscribe(() => this.load())
  }

  stop(): void {
    this.api.snifferStop(this.busId).subscribe(() => this.load())
  }

  isRunning(): boolean {
    return this.state != undefined && this.state.running
  }

  clearDatabase(): void {
    if (!confirm(this.t('sniffer.clearDbConfirm'))) return
    this.api.snifferReset(this.busId).subscribe({
      next: () => {
        this.load()
      },
      error: (e) => console.error('sniffer clear failed', e),
    })
  }

  annotate(reg: SnifferRegisterRow): void {
    const converter = prompt(this.t('sniffer.annotateConverter'), reg.converter ?? '') ?? ''
    if (converter === '') return
    const uom = prompt(this.t('sniffer.annotateUom'), reg.uom ?? '') ?? ''
    this.api
      .snifferRegisterAnnotation(this.busId, reg.slaveId, reg.address, { converter, uom })
      .subscribe({
        next: () => this.refresh(),
        error: (e) => console.error('sniffer annotate failed', e),
      })
  }

  openTrend(reg: SnifferRegisterRow): void {
    this.trendReg = reg
  }
  closeTrend(): void {
    this.trendReg = undefined
  }

  // ---- pagination helpers ----
  totalPages(total: number, pageSize: number): number {
    return Math.max(1, Math.ceil(total / pageSize))
  }
  goTelegramPage(p: number): void {
    this.telegramPage = Math.min(Math.max(1, p), this.totalPages(this.telegramTotal, this.telegramPageSize))
    this.loadTelegrams()
  }
  goHistoryPage(p: number): void {
    this.historyPage = Math.min(Math.max(1, p), this.totalPages(this.historyTotal, this.historyPageSize))
    this.loadHistory()
  }
  goDevicePage(p: number): void {
    this.devicePageSignal.set(Math.min(Math.max(1, p), this.totalPages(this.devices.length, this.devicePageSize)))
  }
  goRegisterPage(p: number): void {
    this.registerPageSignal.set(Math.min(Math.max(1, p), this.totalPages(this.registers.length, this.registerPageSize)))
  }

  time(ts: number): string {
    const d = new Date(ts * 1000)
    return (
      SnifferComponent.fmt(d.getHours()) +
      ':' +
      SnifferComponent.fmt(d.getMinutes()) +
      ':' +
      SnifferComponent.fmt(d.getSeconds())
    )
  }

  /** Full timestamp (date + time) for the history view. */
  dateTime(ts: number): string {
    const d = new Date(ts * 1000)
    return (
      d.getFullYear() +
      '-' +
      SnifferComponent.fmt(d.getMonth() + 1) +
      '-' +
      SnifferComponent.fmt(d.getDate()) +
      ' ' +
      SnifferComponent.fmt(d.getHours()) +
      ':' +
      SnifferComponent.fmt(d.getMinutes()) +
      ':' +
      SnifferComponent.fmt(d.getSeconds())
    )
  }

  hexRow(rawHex: string): string {
    // rawHex is a hex string; insert spaces for readability.
    return rawHex.match(/.{1,2}/g)?.join(' ') ?? rawHex
  }

  static formatDirection(d: string): string {
    return d === 'request' ? '→' : '←'
  }
}
