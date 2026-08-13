import { describe, it, expect } from 'vitest'
import { initialInstanceIndex } from '../selectInstance'

const instances = [
  { _action_timestamp: 'ts-a', action_duration: 900 },
  { _action_timestamp: 'ts-b', action_duration: 500 },
  { _action_timestamp: 'ts-c', action_duration: 100 },
]

describe('initialInstanceIndex', () => {
  it('returns 0 (slowest) when no timestamp is requested', () => {
    expect(initialInstanceIndex(instances, '')).toBe(0)
    expect(initialInstanceIndex(instances, undefined)).toBe(0)
  })

  it('returns the index of the matching instance', () => {
    expect(initialInstanceIndex(instances, 'ts-b')).toBe(1)
    expect(initialInstanceIndex(instances, 'ts-c')).toBe(2)
  })

  it('falls back to 0 when the timestamp matches nothing', () => {
    expect(initialInstanceIndex(instances, 'ts-missing')).toBe(0)
  })

  it('is safe on empty / nullish instance lists', () => {
    expect(initialInstanceIndex([], 'ts-a')).toBe(0)
    expect(initialInstanceIndex(null, 'ts-a')).toBe(0)
  })
})
