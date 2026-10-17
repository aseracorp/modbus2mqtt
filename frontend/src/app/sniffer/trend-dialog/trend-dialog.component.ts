import { Component, ElementRef, Input, OnDestroy, ViewChild, AfterViewInit, output } from '@angular/core'
import { CommonModule } from '@angular/common'
import { MatIcon } from '@angular/material/icon'
import { MatIconButton } from '@angular/material/button'
import { MatTooltip } from '@angular/material/tooltip'
import { ApiService } from '../../services/api-service'
import { TranslationService } from '../../services/translation.service'
import { SnifferRegisterRow } from '@shared/server'

/**
 * Trend popup for a single sniffer register. Fetches the response history of
 * the register (timestamps + raw words) from the backend and renders an
 * interactive SVG line chart with zoom / pan / time-range selection.
 *
 * The chart is dependency-free: plain SVG with a linear x (time) / y (value)
 * mapping. Wheel zooms, drag pans, "Fit" resets the visible time range and
 * "1h/6h/24h" presets bound the window.
 */
@Component({
  selector: 'app-trend-dialog',
  imports: [CommonModule, MatIcon, MatIconButton, MatTooltip],
  standalone: true,
  template: `
    <div class="trend-overlay" (click)="closeOnBackdrop($event)">
      <div class="trend-card" (click)="$event.stopPropagation()">
        <div class="trend-header">
          <span class="trend-title">
            {{ reg.description || reg.entityName || ('Register ' + reg.address) }}
            <span class="trend-sub">slave {{ reg.slaveId }} · addr {{ reg.address }} · {{ reg.uom || '' }}</span>
          </span>
          <div class="trend-actions">
            <button mat-icon-button [matTooltip]="t('sniffer.trendFit')" (click)="fit()"><mat-icon>zoom_out_map</mat-icon></button>
            <button mat-icon-button [matTooltip]="t('sniffer.trend1h')" (click)="preset(3600)">1h</button>
            <button mat-icon-button [matTooltip]="t('sniffer.trend6h')" (click)="preset(6 * 3600)">6h</button>
            <button mat-icon-button [matTooltip]="t('sniffer.trend24h')" (click)="preset(24 * 3600)">24h</button>
            <button mat-icon-button [matTooltip]="'Close'" (click)="close()"><mat-icon>close</mat-icon></button>
          </div>
        </div>
        <div class="trend-body">
          @if (loading) {
            <div class="trend-empty">{{ t('sniffer.trendLoading') }}</div>
          } @else if (points.length === 0) {
            <div class="trend-empty">{{ t('sniffer.trendNoData') }}</div>
          } @else {
            <svg #chart class="trend-svg" [attr.viewBox]="'0 0 ' + width + ' ' + height"
                 (wheel)="onWheel($event)" (mousedown)="onMouseDown($event)" (mousemove)="onMouseMove($event)" (mouseup)="onMouseUp($event)" (mouseleave)="onMouseUp($event)">
              <!-- y grid -->
              @for (gy of yGrid; track gy) {
                <line [attr.x1]="padL" [attr.x2]="width - padR" [attr.y1]="yPos(gy)" [attr.y2]="yPos(gy)" class="trend-grid"/>
                <text [attr.x]="padL - 5" [attr.y]="yPos(gy) + 3" class="trend-tick" text-anchor="end">{{ fmtY(gy) }}</text>
              }
              <!-- x grid (time) -->
              @for (gx of xGrid; track gx) {
                <line [attr.x1]="xPos(gx)" [attr.x2]="xPos(gx)" [attr.y1]="padT" [attr.y2]="height - padB" class="trend-grid"/>
                <text [attr.x]="xPos(gx)" [attr.y]="height - padB + 14" class="trend-tick" text-anchor="middle">{{ fmtX(gx) }}</text>
              }
              <!-- area + line -->
              <polygon [attr.points]="areaPoints" class="trend-area"/>
              <polyline [attr.points]="linePoints" class="trend-line"/>
              <!-- hover -->
              @if (hoverIdx >= 0) {
                <line [attr.x1]="xPos(points[hoverIdx].t)" [attr.x2]="xPos(points[hoverIdx].t)" [attr.y1]="padT" [attr.y2]="height - padB" class="trend-hover"/>
                <circle [attr.cx]="xPos(points[hoverIdx].t)" [attr.cy]="yPos(points[hoverIdx].v)" r="3.5" class="trend-dot"/>
                <text [attr.x]="xPos(points[hoverIdx].t)" [attr.y]="padT + 12" class="trend-hover-label" text-anchor="middle">
                  {{ fmtX(points[hoverIdx].t) }} — {{ fmtY(points[hoverIdx].v) }}
                </text>
              }
            </svg>
            <div class="trend-range">
              <span>{{ fmtX(viewFrom) }}</span>
              <span>→</span>
              <span>{{ fmtX(viewTo) }}</span>
              <span class="trend-count">{{ points.length }} {{ t('sniffer.trendPoints') }}</span>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
    .trend-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 1200; }
    .trend-card { background: var(--surface, #fff); color: var(--text, #1a1a1a); border-radius: 10px; width: min(92vw, 860px); box-shadow: 0 10px 40px rgba(0,0,0,.4); display: flex; flex-direction: column; }
    .trend-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid rgba(128,128,128,.25); gap: 8px; }
    .trend-title { font-weight: 600; display: flex; flex-direction: column; line-height: 1.25; }
    .trend-sub { font-weight: 400; opacity: .7; font-size: 12px; }
    .trend-actions { display: flex; align-items: center; gap: 2px; }
    .trend-body { padding: 14px; min-height: 260px; }
    .trend-svg { width: 100%; height: 320px; display: block; cursor: grab; user-select: none; touch-action: none; }
    .trend-svg.dragging { cursor: grabbing; }
    .trend-grid { stroke: rgba(128,128,128,.18); stroke-width: 1; }
    .trend-tick { fill: rgba(128,128,128,.85); font-size: 11px; }
    .trend-line { fill: none; stroke: #3f51b5; stroke-width: 2; }
    .trend-area { fill: rgba(63,81,181,.12); stroke: none; }
    .trend-hover { stroke: rgba(128,128,128,.4); stroke-dasharray: 3 3; }
    .trend-dot { fill: #3f51b5; }
    .trend-hover-label { fill: #333; font-size: 12px; font-weight: 600; background: rgba(255,255,255,.7); }
    .trend-empty { text-align: center; padding: 60px 0; opacity: .6; }
    .trend-range { display: flex; justify-content: center; gap: 8px; margin-top: 6px; font-size: 12px; opacity: .8; align-items: center; }
    .trend-count { opacity: .6; }
    `,
  ],
})
export class TrendDialogComponent implements AfterViewInit, OnDestroy {
  @Input() busId = 0
  @Input() reg!: SnifferRegisterRow

  @ViewChild('chart') chartRef?: ElementRef<SVGSVGElement>

  points: { t: number; v: number }[] = []
  loading = true

  // Chart geometry
  width = 820
  height = 320
  padL = 52
  padR = 14
  padT = 28
  padB = 30

  // Visible time window (epoch seconds)
  viewFrom = 0
  viewTo = 0
  minT = 0
  maxT = 0
  minV = 0
  maxV = 1

  // Interaction
  private dragging = false
  private dragStartX = 0
  private dragStartFrom = 0
  private dragStartTo = 0
  private hoverIdx = -1
  private subs: { close: () => void } | undefined

  constructor(
    private api: ApiService,
    private translation: TranslationService
  ) {}

  t = (key: string) => this.translation.map()[key] ?? key

  ngAfterViewInit(): void {
    this.load()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close()
    }
    document.addEventListener('keydown', onKey)
    this.subs = { close: () => document.removeEventListener('keydown', onKey) }
  }

  ngOnDestroy(): void {
    this.subs?.close()
  }

  private load(): void {
    this.loading = true
    this.api.getSnifferRegisterHistory(this.busId, this.reg.slaveId, this.reg.address, 2000).subscribe({
      next: (rows) => {
        // Aggregieren: pro Zeitpunkt den ersten Wert nehmen (addr zeigt auf den
        // ersten Reg-Wert; für quantity>1 könnten weitere Spalten existieren).
        this.points = rows
          .map((r) => ({ t: r.timestamp, v: r.values && r.values.length > 0 ? r.values[0] : NaN }))
          .filter((p) => !Number.isNaN(p.v))
          .reverse() // newest first vom Backend -> chronologisch
        if (this.points.length > 0) {
          this.minT = this.points[0].t
          this.maxT = this.points[this.points.length - 1].t
          this.fit()
        }
        this.loading = false
      },
      error: () => {
        this.loading = false
      },
    })
  }

  private computeYRange(): void {
    const visible = this.points.filter((p) => p.t >= this.viewFrom && p.t <= this.viewTo)
    if (visible.length === 0) return
    let lo = Infinity
    let hi = -Infinity
    for (const p of visible) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    if (lo === hi) {
      lo -= 1
      hi += 1
    }
    const pad = (hi - lo) * 0.08
    this.minV = lo - pad
    this.maxV = hi + pad
  }

  /** Reset the visible window to the full data range. */
  fit(): void {
    if (this.points.length === 0) return
    this.viewFrom = this.minT
    this.viewTo = this.maxT
    this.computeYRange()
  }

  /** Bound the window to the last `seconds` before maxT. */
  preset(seconds: number): void {
    if (this.points.length === 0) return
    this.viewTo = this.maxT
    this.viewFrom = Math.max(this.minT, this.maxT - seconds)
    this.computeYRange()
  }

  // ---- geometry ----
  private xPos(t: number): number {
    const span = this.viewTo - this.viewFrom || 1
    return this.padL + ((t - this.viewFrom) / span) * (this.width - this.padL - this.padR)
  }
  private yPos(v: number): number {
    const span = this.maxV - this.minV || 1
    return this.padT + (1 - (v - this.minV) / span) * (this.height - this.padT - this.padB)
  }
  private tFromX(x: number): number {
    const span = this.viewTo - this.viewFrom || 1
    const frac = (x - this.padL) / (this.width - this.padL - this.padR)
    return this.viewFrom + frac * span
  }

  get linePoints(): string {
    return this.points
      .filter((p) => p.t >= this.viewFrom && p.t <= this.viewTo)
      .map((p) => `${this.xPos(p.t).toFixed(1)},${this.yPos(p.v).toFixed(1)}`)
      .join(' ')
  }
  get areaPoints(): string {
    const pts = this.points.filter((p) => p.t >= this.viewFrom && p.t <= this.viewTo)
    if (pts.length === 0) return ''
    const bottom = this.height - this.padB
    return `${this.xPos(pts[0].t).toFixed(1)},${bottom} ` + pts.map((p) => `${this.xPos(p.t).toFixed(1)},${this.yPos(p.v).toFixed(1)}`).join(' ') + ` ${this.xPos(pts[pts.length - 1].t).toFixed(1)},${bottom}`
  }

  get xGrid(): number[] {
    const n = 5
    const out: number[] = []
    for (let i = 0; i <= n; i++) {
      out.push(this.viewFrom + ((this.viewTo - this.viewFrom) * i) / n)
    }
    return out
  }
  get yGrid(): number[] {
    const n = 4
    const out: number[] = []
    for (let i = 0; i <= n; i++) {
      out.push(this.minV + ((this.maxV - this.minV) * i) / n)
    }
    return out
  }

  fmtY(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(2)
  }
  fmtX(t: number): string {
    const d = new Date(t * 1000)
    const span = this.viewTo - this.viewFrom
    if (span > 6 * 3600) return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // ---- interaction ----
  onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    const t = this.tFromX(x * (this.width / rect.width))
    const factor = e.deltaY > 0 ? 1.25 : 0.8
    const span = this.viewTo - this.viewFrom
    const newSpan = Math.max(5, span * factor)
    const frac = (t - this.viewFrom) / span
    this.viewFrom = t - newSpan * frac
    this.viewTo = this.viewFrom + newSpan
    this.clampView()
    this.computeYRange()
  }

  onMouseDown(e: MouseEvent): void {
    this.dragging = true
    this.chartRef?.nativeElement.classList.add('dragging')
    this.dragStartX = e.clientX
    this.dragStartFrom = this.viewFrom
    this.dragStartTo = this.viewTo
  }
  onMouseMove(e: MouseEvent): void {
    if (this.dragging) {
      const rect = (this.chartRef?.nativeElement.getBoundingClientRect() as DOMRect) ?? new DOMRect()
      const spanT = this.viewTo - this.viewFrom
      const pxSpan = this.width - this.padL - this.padR
      const dt = ((e.clientX - this.dragStartX) * spanT) / pxSpan
      this.viewFrom = this.dragStartFrom - dt
      this.viewTo = this.dragStartTo - dt
      this.clampView()
      this.computeYRange()
    } else if (e.currentTarget) {
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
      const x = e.clientX - rect.left
      const t = this.tFromX(x * (this.width / rect.width))
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < this.points.length; i++) {
        const d = Math.abs(this.points[i].t - t)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      this.hoverIdx = best
    }
  }
  onMouseUp(): void {
    this.dragging = false
    this.chartRef?.nativeElement.classList.remove('dragging')
  }
  private clampView(): void {
    if (this.points.length === 0) return
    const span = this.viewTo - this.viewFrom
    if (this.viewFrom < this.minT) {
      this.viewFrom = this.minT
      this.viewTo = this.minT + span
    }
    if (this.viewTo > this.maxT) {
      this.viewTo = this.maxT
      this.viewFrom = this.maxT - span
    }
  }

  closeOnBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.close()
  }
  close(): void {
    this.subs?.close()
    this.subs = undefined
    // Parent removes us from the DOM.
    this.closed.emit()
  }
  /** Emitted when the popup should be removed (close button / Escape / backdrop). */
  readonly closed = output<void>()
}
