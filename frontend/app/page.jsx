'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const STORAGE_KEY = 'bezier-path-state'
const SVG_W = 800
const SVG_H = 600

// Convert browser client coords to SVG viewBox coords
function clientToSVG(e, svgEl) {
  const rect = svgEl.getBoundingClientRect()
  const scaleX = SVG_W / rect.width 
  const scaleY = SVG_H / rect.height
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  }
}

// Format a number: up to 2 decimal places, no trailing zeros
function fmt(n) {
  return parseFloat(n.toFixed(2)).toString()
}

// Build the SVG path d attribute string
function buildPathD(anchors, isClosed) {
  if (anchors.length === 0) return ''

  const f = fmt
  const parts = [`M ${f(anchors[0].ax)} ${f(anchors[0].ay)}`]

  for (let i = 1; i < anchors.length; i++) {
    const p = anchors[i - 1]
    const c = anchors[i]
    parts.push(
      `C ${f(p.outHx)} ${f(p.outHy)} ${f(c.inHx)} ${f(c.inHy)} ${f(c.ax)} ${f(c.ay)}`
    )
  }

  if (isClosed && anchors.length >= 2) {
    const last = anchors[anchors.length - 1]
    const first = anchors[0]
    parts.push(
      `C ${f(last.outHx)} ${f(last.outHy)} ${f(first.inHx)} ${f(first.inHy)} ${f(first.ax)} ${f(first.ay)} Z`
    )
  }

  return parts.join(' ')
}

function defaultState() {
  return { anchors: [], isClosed: false }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return defaultState()
}

export default function BezierEditor() {
  const [state, setState] = useState(defaultState)
  const [mode, setMode] = useState('draw')

  const svgRef = useRef(null)
  const stateRef = useRef(state)
  const modeRef = useRef(mode)
  const dragRef = useRef(null)

  // Hydrate from localStorage once on mount
  useEffect(() => {
    setState(loadState())
  }, [])

  // Keep refs in sync and persist on every state change
  useEffect(() => {
    stateRef.current = state
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // Expose window.__getAnchor for tests
  useEffect(() => {
    window.__getAnchor = (id) => {
      const anchor = stateRef.current.anchors[id - 1]
      if (!anchor) return null
      return {
        ax: anchor.ax,
        ay: anchor.ay,
        inHx: anchor.inHx,
        inHy: anchor.inHy,
        outHx: anchor.outHx,
        outHy: anchor.outHy,
        type: anchor.type,
      }
    }
    return () => {
      delete window.__getAnchor
    }
  }, [])

  // ── Mutations ────────────────────────────────────────────────────────────────

  const addAnchor = useCallback((x, y) => {
    setState((prev) => {
      if (prev.isClosed) return prev

      const anchors = prev.anchors.map((a) => ({ ...a }))

      if (anchors.length === 0) {
        // First anchor: handles initialized at anchor position
        anchors.push({ ax: x, ay: y, inHx: x, inHy: y, outHx: x, outHy: y, type: 'smooth' })
      } else {
        const prevA = anchors[anchors.length - 1]
        const dx = x - prevA.ax
        const dy = y - prevA.ay

        // Set previous anchor's out-handle (1/3 toward new anchor)
        prevA.outHx = prevA.ax + dx / 3
        prevA.outHy = prevA.ay + dy / 3

        // New anchor's in-handle (2/3 along from prev)
        const inHx = x - dx / 3
        const inHy = y - dy / 3
        // New anchor's out-handle: mirror of in-handle for smooth node
        const outHx = x + dx / 3
        const outHy = y + dy / 3

        anchors.push({ ax: x, ay: y, inHx, inHy, outHx, outHy, type: 'smooth' })
      }

      return { ...prev, anchors }
    })
  }, [])

  const closePath = useCallback(() => {
    setState((prev) => {
      if (prev.isClosed || prev.anchors.length < 3) return prev

      const anchors = prev.anchors.map((a) => ({ ...a }))
      const last = anchors[anchors.length - 1]
      const first = anchors[0]

      // Set closing segment handles
      const dx = first.ax - last.ax
      const dy = first.ay - last.ay
      last.outHx = last.ax + dx / 3
      last.outHy = last.ay + dy / 3
      first.inHx = first.ax - dx / 3
      first.inHy = first.ay - dy / 3

      return { ...prev, anchors, isClosed: true }
    })
  }, [])

  const clearPath = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setState(defaultState())
  }, [])

  const exportPath = useCallback(() => {
    const { anchors, isClosed } = stateRef.current
    const d = buildPathD(anchors, isClosed)
    navigator.clipboard.writeText(d).catch(() => {})
  }, [])

  const toggleNodeType = useCallback((anchorIdx) => {
    setState((prev) => {
      const anchors = prev.anchors.map((a) => ({ ...a }))
      const a = anchors[anchorIdx]
      if (a.type === 'smooth') {
        a.type = 'cusp'
      } else {
        a.type = 'smooth'
        // Snap in-handle to mirror of out-handle
        a.inHx = 2 * a.ax - a.outHx
        a.inHy = 2 * a.ay - a.outHy
      }
      return { ...prev, anchors }
    })
  }, [])

  // ── Pointer / click handlers ─────────────────────────────────────────────────

  const handleSVGPointerDown = useCallback((e) => {
    if (modeRef.current !== 'select') return

    const testId = e.target.getAttribute('data-testid') || ''
    if (!testId) return

    const svg = svgRef.current
    const coords = clientToSVG(e, svg)
    const anchors = stateRef.current.anchors

    if (testId.startsWith('anchor-')) {
      const id = parseInt(testId.split('-')[1], 10)
      const anchorIdx = id - 1
      const anchor = anchors[anchorIdx]
      if (!anchor) return
      e.preventDefault()
      dragRef.current = {
        active: true,
        type: 'anchor',
        anchorIdx,
        startSVGX: coords.x,
        startSVGY: coords.y,
        startAx: anchor.ax,
        startAy: anchor.ay,
        startInHx: anchor.inHx,
        startInHy: anchor.inHy,
        startOutHx: anchor.outHx,
        startOutHy: anchor.outHy,
      }
      svg.setPointerCapture(e.pointerId)
    } else if (testId.startsWith('handle-')) {
      const parts = testId.split('-')
      const id = parseInt(parts[1], 10)
      const handleType = parts[2] // 'in' or 'out'
      const anchorIdx = id - 1
      const anchor = anchors[anchorIdx]
      if (!anchor) return
      e.preventDefault()
      dragRef.current = {
        active: true,
        type: 'handle',
        anchorIdx,
        handleType,
        startSVGX: coords.x,
        startSVGY: coords.y,
        startAx: anchor.ax,
        startAy: anchor.ay,
        startInHx: anchor.inHx,
        startInHy: anchor.inHy,
        startOutHx: anchor.outHx,
        startOutHy: anchor.outHy,
      }
      svg.setPointerCapture(e.pointerId)
    }
  }, [])

  const handleSVGPointerMove = useCallback((e) => {
    const drag = dragRef.current
    if (!drag?.active) return

    const coords = clientToSVG(e, svgRef.current)
    const dx = coords.x - drag.startSVGX
    const dy = coords.y - drag.startSVGY

    setState((prev) => {
      const anchors = prev.anchors.map((a) => ({ ...a }))
      const a = anchors[drag.anchorIdx]

      if (drag.type === 'anchor') {
        a.ax = drag.startAx + dx
        a.ay = drag.startAy + dy
        a.inHx = drag.startInHx + dx
        a.inHy = drag.startInHy + dy
        a.outHx = drag.startOutHx + dx
        a.outHy = drag.startOutHy + dy
      } else if (drag.type === 'handle') {
        if (drag.handleType === 'out') {
          a.outHx = drag.startOutHx + dx
          a.outHy = drag.startOutHy + dy
          if (a.type === 'smooth') {
            a.inHx = 2 * a.ax - a.outHx
            a.inHy = 2 * a.ay - a.outHy
          }
        } else {
          a.inHx = drag.startInHx + dx
          a.inHy = drag.startInHy + dy
          if (a.type === 'smooth') {
            a.outHx = 2 * a.ax - a.inHx
            a.outHy = 2 * a.ay - a.inHy
          }
        }
      }

      return { ...prev, anchors }
    })
  }, [])

  const handleSVGPointerUp = useCallback((e) => {
    if (dragRef.current?.active) {
      dragRef.current = null
      try {
        svgRef.current?.releasePointerCapture(e.pointerId)
      } catch {}
    }
  }, [])

  const handleSVGClick = useCallback(
    (e) => {
      if (modeRef.current !== 'draw') return
      if (stateRef.current.isClosed) return
      // Don't add anchor if clicking on an anchor or handle element
      const testId = e.target.getAttribute('data-testid') || ''
      if (testId.startsWith('anchor-') || testId.startsWith('handle-')) return
      const coords = clientToSVG(e, svgRef.current)
      addAnchor(coords.x, coords.y)
    },
    [addAnchor]
  )

  const handleAnchorClick = useCallback(
    (e, anchorIdx) => {
      e.stopPropagation()
      if (modeRef.current !== 'draw') return
      // Clicking anchor-1 with ≥3 anchors closes the path
      if (
        anchorIdx === 0 &&
        stateRef.current.anchors.length >= 3 &&
        !stateRef.current.isClosed
      ) {
        closePath()
      }
    },
    [closePath]
  )

  const handleAnchorDblClick = useCallback(
    (e, anchorIdx) => {
      e.stopPropagation()
      toggleNodeType(anchorIdx)
    },
    [toggleNodeType]
  )

  // ── Render ───────────────────────────────────────────────────────────────────

  const pathD = buildPathD(state.anchors, state.isClosed)
  const n = state.anchors.length

  const btnBase = {
    padding: '6px 14px',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  }

  const activeBtn = {
    ...btnBase,
    backgroundColor: '#1d6ef5',
    color: '#fff',
    fontWeight: '700',
  }

  const inactiveBtn = {
    ...btnBase,
    backgroundColor: '#e0e0e0',
    color: '#333',
    fontWeight: '400',
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '16px', userSelect: 'none' }}>
      {/* Toolbar */}
      <div style={{ marginBottom: '12px', display: 'flex', gap: '8px' }}>
        <button
          data-testid="draw-mode-btn"
          aria-pressed={mode === 'draw'}
          onClick={() => setMode('draw')}
          style={mode === 'draw' ? activeBtn : inactiveBtn}
        >
          Draw
        </button>
        <button
          data-testid="select-mode-btn"
          aria-pressed={mode === 'select'}
          onClick={() => setMode('select')}
          style={mode === 'select' ? activeBtn : inactiveBtn}
        >
          Select
        </button>
        <button data-testid="clear-btn" onClick={clearPath} style={inactiveBtn}>
          Clear
        </button>
        <button data-testid="export-btn" onClick={exportPath} style={inactiveBtn}>
          Export
        </button>
      </div>
      <svg
        data-testid="svg-canvas"
        ref={svgRef}
        width={SVG_W}
        height={SVG_H}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        preserveAspectRatio="none"
        style={{
          border: '1px solid #ccc',
          background: '#fafafa',
          cursor: mode === 'draw' ? 'crosshair' : 'default',
          display: 'block',
        }}
        onClick={handleSVGClick}
        onPointerDown={handleSVGPointerDown}
        onPointerMove={handleSVGPointerMove}
        onPointerUp={handleSVGPointerUp}
      >
        {/* Live path */}
        <path
          data-testid="svg-path"
          d={pathD}
          fill="none"
          stroke="#333"
          strokeWidth="2"
        />

        {/* Anchors and handles */}
        {state.anchors.map((anchor, idx) => {
          const id = idx + 1
          const isFirst = idx === 0
          // First anchor's in-handle not shown on open path (no effect on curve)
          const showInHandle = !isFirst || state.isClosed
          // Out-handles always shown (needed for dragging even on last anchor)
          const showOutHandle = true

          return (
            <g key={id}>
              {/* Handle arms (non-interactive lines) */}
              {showInHandle && (
                <line
                  x1={anchor.ax}
                  y1={anchor.ay}
                  x2={anchor.inHx}
                  y2={anchor.inHy}
                  stroke="#aaa"
                  strokeWidth="1"
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {showOutHandle && (
                <line
                  x1={anchor.ax}
                  y1={anchor.ay}
                  x2={anchor.outHx}
                  y2={anchor.outHy}
                  stroke="#aaa"
                  strokeWidth="1"
                  style={{ pointerEvents: 'none' }}
                />
              )}

              {/* In-handle circle */}
              {showInHandle && (
                <circle
                  data-testid={`handle-${id}-in`}
                  data-hx={anchor.inHx}
                  data-hy={anchor.inHy}
                  cx={anchor.inHx}
                  cy={anchor.inHy}
                  r={5}
                  fill="#fff"
                  stroke="#4488ff"
                  strokeWidth="1.5"
                  style={{ cursor: mode === 'select' ? 'grab' : 'default' }}
                />
              )}

              {/* Out-handle circle */}
              {showOutHandle && (
                <circle
                  data-testid={`handle-${id}-out`}
                  data-hx={anchor.outHx}
                  data-hy={anchor.outHy}
                  cx={anchor.outHx}
                  cy={anchor.outHy}
                  r={5}
                  fill="#fff"
                  stroke="#4488ff"
                  strokeWidth="1.5"
                  style={{ cursor: mode === 'select' ? 'grab' : 'default' }}
                />
              )}

              {/* Anchor square (rendered last so it's on top) */}
              <rect
                data-testid={`anchor-${id}`}
                data-ax={anchor.ax}
                data-ay={anchor.ay}
                data-node-type={anchor.type}
                x={anchor.ax - 6}
                y={anchor.ay - 6}
                width={12}
                height={12}
                fill="#fff"
                stroke="#333"
                strokeWidth="1.5"
                style={{ cursor: mode === 'select' ? 'move' : 'default' }}
                onClick={(e) => handleAnchorClick(e, idx)}
                onDoubleClick={(e) => handleAnchorDblClick(e, idx)}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
