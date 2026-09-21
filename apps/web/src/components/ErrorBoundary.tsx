import React from 'react'
import i18n from '../i18n'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Root-level React error boundary.
 *
 * Any render-time crash that would otherwise blank the whole page (e.g. the
 * Rules-of-Hooks violation fixed in bde107b — "Rendered more/fewer hooks than
 * during the previous render" unmounts the entire tree) degrades to this
 * screen instead.
 *
 * Deliberately dependency-free: no UI-kit components, no hooks, no context.
 * It must render even when everything above it in the import graph is broken.
 * i18n is used with defaultValue fallbacks so a missing/lazy locale bundle
 * never turns the crash screen into a second crash.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Full stack + component stack go to the console for bug reports
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    const t = (key: string, fallback: string) => i18n.t(key, { defaultValue: fallback })

    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
        <h1 className="text-lg font-semibold">{t('error.title', '界面出现异常')}</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {t('error.description', '渲染过程中发生了未捕获的错误。刷新页面通常可以恢复。')}
        </p>
        <pre className="w-full max-w-xl overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs text-muted-foreground">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('error.reload', '刷新页面')}
        </button>
      </div>
    )
  }
}
