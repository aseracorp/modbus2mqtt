import { Component, inject } from '@angular/core'
import { RouterLink, RouterLinkActive } from '@angular/router'
import { CommonModule } from '@angular/common'
import { MatIcon } from '@angular/material/icon'
import { MatTooltip } from '@angular/material/tooltip'
import { AuthService } from '../services/auth.service'

function currentTheme(): string {
  try {
    const saved = localStorage.getItem('m2m-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  return 'dark'
}

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.css'],
  imports: [CommonModule, RouterLink, RouterLinkActive, MatIcon, MatTooltip],
})
export class HeaderComponent {
  auth = inject(AuthService)
  theme = currentTheme()

  toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset['theme'] = this.theme
    try {
      localStorage.setItem('m2m-theme', this.theme)
    } catch {
      /* ignore */
    }
  }
}
