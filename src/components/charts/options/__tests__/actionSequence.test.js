import { describe, it, expect } from 'vitest'
import {
  PHASE_COLORS,
  PHASE_LEGEND,
  phaseGroupOf,
} from '../actionSequence'

describe('phaseGroupOf', () => {
  it('maps base phase keys to their own group', () => {
    expect(phaseGroupOf('offset')).toBe('offset')
    expect(phaseGroupOf('backend')).toBe('backend')
    expect(phaseGroupOf('render')).toBe('render')
  })

  it('collapses every network sub-phase into the network group', () => {
    expect(phaseGroupOf('network-full')).toBe('network')
    expect(phaseGroupOf('network-wait')).toBe('network')
    expect(phaseGroupOf('network-cdn')).toBe('network')
  })
})

describe('PHASE_LEGEND', () => {
  it('has the four screenshot categories with matching colors', () => {
    expect(PHASE_LEGEND.map((p) => p.key)).toEqual([
      'offset',
      'backend',
      'network',
      'render',
    ])
    expect(PHASE_LEGEND.map((p) => p.label)).toEqual([
      'Offset',
      'Backend',
      'Network wait',
      'Render',
    ])
    for (const entry of PHASE_LEGEND) {
      expect(entry.color).toBe(PHASE_COLORS[entry.key])
    }
  })
})
