import { describe, it, expect } from 'vitest'
import {
  objectStatusStateForDurationTier,
  tagDesignForAnomalyTier,
} from '../sapStatus'

describe('objectStatusStateForDurationTier', () => {
  it('maps duration tiers to ObjectStatus states', () => {
    expect(objectStatusStateForDurationTier('good')).toBe('Positive')
    expect(objectStatusStateForDurationTier('neutral')).toBe('Critical')
    expect(objectStatusStateForDurationTier('watch')).toBe('Critical')
    expect(objectStatusStateForDurationTier('warn')).toBe('Critical')
    expect(objectStatusStateForDurationTier('bad')).toBe('Negative')
  })

  it('falls back to None for null/unknown', () => {
    expect(objectStatusStateForDurationTier(null)).toBe('None')
    expect(objectStatusStateForDurationTier('nope')).toBe('None')
  })
})

describe('tagDesignForAnomalyTier', () => {
  it('maps anomaly tiers 1/2/3 to Tag designs', () => {
    expect(tagDesignForAnomalyTier(1)).toBe('Negative')
    expect(tagDesignForAnomalyTier(2)).toBe('Critical')
    expect(tagDesignForAnomalyTier(3)).toBe('Information')
  })

  it('falls back to Neutral for anything else', () => {
    expect(tagDesignForAnomalyTier(0)).toBe('Neutral')
    expect(tagDesignForAnomalyTier(undefined)).toBe('Neutral')
  })
})
