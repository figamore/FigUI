import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import { useResizeHandle } from '../hooks/useResizeHandle'

type CollapseToward = 'left' | 'right' | 'up' | 'down'

interface ResizeHandleProps {
  direction?: 'horizontal' | 'vertical'
  collapseToward?: CollapseToward
  collapsed?: boolean
  onCollapseToggle?: () => void
  onDelta: (delta: number) => void
  onDragStart?: () => void
  onDragEnd?: () => void
  dragging?: boolean
}

export function ResizeHandle({
  direction = 'horizontal',
  collapseToward,
  collapsed = false,
  onCollapseToggle,
  onDelta,
  onDragStart,
  onDragEnd,
  dragging = false,
}: ResizeHandleProps) {
  const { onMouseDown, onTouchStart } = useResizeHandle(direction, onDelta, onDragStart, onDragEnd)
  const isH = direction === 'horizontal'

  const CollapseIcon =
    collapseToward === 'left'  ? (collapsed ? ChevronRight : ChevronLeft)  :
    collapseToward === 'right' ? (collapsed ? ChevronLeft  : ChevronRight) :
    collapseToward === 'up'    ? (collapsed ? ChevronDown  : ChevronUp)    :
                                 (collapsed ? ChevronUp    : ChevronDown)

  return (
    <div
      role="separator"
      aria-orientation={isH ? 'vertical' : 'horizontal'}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      className={[
        'resize-handle',
        isH ? 'resize-handle--h' : 'resize-handle--v',
        dragging ? 'resize-handle--dragging' : '',
      ].join(' ')}
    >
      <div className="resize-handle__line" />
      {collapseToward && onCollapseToggle ? (
        <button
          className="resize-handle__btn"
          onClick={e => { e.stopPropagation(); onCollapseToggle() }}
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
          tabIndex={-1}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          <CollapseIcon size={10} strokeWidth={2.5} />
        </button>
      ) : (
        <div className="resize-handle__grip" aria-hidden="true">
          <span /><span /><span />
        </div>
      )}
    </div>
  )
}
