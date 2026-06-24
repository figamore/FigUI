import { useEffect, useMemo, useRef } from 'react'

const LINE_HEIGHT_PX = 18
const MAX_LINE_ROWS = 20000

interface Props {
  text: string | null
  loading?: boolean
  activeLine: number | null
  followActiveLine?: boolean
  className?: string
}

function activeRowClass(isActive: boolean) {
  return isActive
    ? 'bg-accent/30 border-l-[3px] border-accent shadow-[inset_0_0_0_1px_rgba(var(--accent-rgb),0.25)]'
    : 'border-l-[3px] border-transparent hover:bg-elevated/60'
}

export function GCodeTextPanel({
  text,
  loading = false,
  activeLine,
  followActiveLine = true,
  className = '',
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeLineRef = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => (text ? text.split('\n') : []), [text])
  const useLineRows = lines.length > 0 && lines.length <= MAX_LINE_ROWS

  useEffect(() => {
    if (!followActiveLine || activeLine == null) return
    const row = activeLineRef.current
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    const container = scrollRef.current
    if (container && !useLineRows) {
      container.scrollTop = Math.max(0, (activeLine - 1) * LINE_HEIGHT_PX - container.clientHeight / 2)
    }
  }, [activeLine, followActiveLine, useLineRows, text])

  return (
    <div className={`flex flex-col min-h-0 bg-bg ${className}`}>
      <div className="shrink-0 px-3 py-1.5 border-b border-border text-[11px] uppercase tracking-wide text-text-muted font-semibold flex items-center justify-between gap-2">
        <span>G-code</span>
        {activeLine != null && (
          <span className="normal-case tracking-normal font-mono text-accent text-[10px]">
            Line {activeLine}
          </span>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        {loading && (
          <div className="p-3 text-sm text-text-muted">Loading source…</div>
        )}
        {!loading && !text && (
          <div className="p-3 text-sm text-text-muted">
            No source text available. Load a file to view G-code here.
          </div>
        )}
        {!loading && text && useLineRows && (
          <div className="py-1 font-mono text-[11px] leading-[18px]">
            {lines.map((line, index) => {
              const lineNo = index + 1
              const isActive = activeLine === lineNo
              return (
                <div
                  key={lineNo}
                  ref={isActive ? activeLineRef : undefined}
                  className={`flex gap-2 px-2 ${activeRowClass(isActive)}`}
                >
                  <span className={`w-9 shrink-0 text-right tabular-nums select-none ${isActive ? 'text-accent font-bold' : 'text-text-dim'}`}>
                    {lineNo}
                  </span>
                  <span className={`flex-1 min-w-0 whitespace-pre-wrap break-all ${isActive ? 'text-text-primary font-semibold' : 'text-text-primary'}`}>
                    {line || ' '}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {!loading && text && !useLineRows && (
          <div className="relative py-1">
            {activeLine != null && (
              <div
                aria-hidden="true"
                className="absolute left-0 right-0 bg-accent/30 border-l-[3px] border-accent pointer-events-none z-0"
                style={{
                  top: `${(activeLine - 1) * LINE_HEIGHT_PX + 4}px`,
                  height: `${LINE_HEIGHT_PX}px`,
                }}
              />
            )}
            <pre className="relative z-[1] px-3 font-mono text-[11px] leading-[18px] whitespace-pre-wrap break-all text-text-primary">
              {text}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
