import { Component, Input, OnDestroy } from '@angular/core'
import { FormBuilder, FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms'
import { ApiService } from '../services/api-service'
import { TranslationService } from '../services/translation.service'
import { MatFormField, MatLabel, MatOption, MatSelect } from '@angular/material/select'
import { MatInput } from '@angular/material/input'
import { MatIconButton } from '@angular/material/button'
import { MatIcon } from '@angular/material/icon'
import { MatTooltip } from '@angular/material/tooltip'
import { MatSlideToggle } from '@angular/material/slide-toggle'
import { Observable, Subscription, interval } from 'rxjs'
import {
  SnifferBusConfig,
  SnifferDeviceRow,
  SnifferRegisterRow,
  SnifferState,
  SnifferTelegramRow,
} from '@shared/server'

/**
 * RTU sniffer panel for a single bus. Shown inside the bus card of the
 * SelectModbus view. Lets the user start/stop the sniffer (stack hook by
 * default, or a passive tap port), watch the live telegram log, and inspect
 * the discovered devices and registers.
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
    MatInput,
    MatIconButton,
    MatIcon,
    MatTooltip,
    MatSlideToggle,
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
  telegrams: SnifferTelegramRow[] = []
  devices: SnifferDeviceRow[] = []
  registers: SnifferRegisterRow[] = []
  modeControl: FormControl<string | null>
  tapDeviceControl: FormControl<string | null>
  baudControl: FormControl<number | null>
  enabledControl: FormControl<boolean | null>
  private refreshSub: Subscription | undefined

  private static fmt = (n: number): string => n.toString().padStart(2, '0')
  private static hex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase()

  constructor(
    private api: ApiService,
    private fb: FormBuilder,
    private translation: TranslationService
  ) {
    this.modeControl = this.fb.control('stack')
    this.tapDeviceControl = this.fb.control('')
    this.baudControl = this.fb.control(9600)
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
        this.tapDeviceControl.setValue(config.tapDevice ?? '')
        this.baudControl.setValue(config.baudRate ?? 9600)
        this.enabledControl.setValue(config.enabled)
      }
    })
    this.refresh()
  }

  private refresh(): void {
    this.api.getSnifferState(this.busId).subscribe((state) => {
      this.state = state
      if (state && state.running) {
        this.api.getSnifferTelegrams(this.busId, undefined, 100).subscribe((t) => (this.telegrams = t))
        this.api.getSnifferDevices(this.busId).subscribe((d) => (this.devices = d))
        this.api.getSnifferRegisters(this.busId).subscribe((r) => (this.registers = r))
        this.startRefresh()
      } else {
        this.stopRefresh()
        this.telegrams = []
        this.devices = []
        this.registers = []
      }
    })
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
        this.api.getSnifferTelegrams(this.busId, undefined, 100).subscribe((t) => (this.telegrams = t))
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
    this.config.tapDevice = this.tapDeviceControl.value ?? undefined
    this.config.baudRate = this.baudControl.value ?? undefined
    this.config.enabled = this.enabledControl.value ?? false
    this.api.postSnifferConfig(this.config).subscribe(() => {
      if (this.config.enabled && !this.state?.running) void this.start()
    })
  }

  start(): void {
    this.api.snifferStart(this.busId).subscribe(() => this.refresh())
  }

  stop(): void {
    this.api.snifferStop(this.busId).subscribe(() => this.refresh())
  }

  isRunning(): boolean {
    return this.state != undefined && this.state.running
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

  hexRow(rawHex: string): string {
    // rawHex is a hex string; insert spaces for readability.
    return rawHex.match(/.{1,2}/g)?.join(' ') ?? rawHex
  }

  static formatDirection(d: string): string {
    return d === 'request' ? '→' : '←'
  }
}
