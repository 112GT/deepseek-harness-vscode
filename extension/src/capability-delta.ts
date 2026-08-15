import type { HarnessCapabilitiesSnapshot } from './runner/runner'

export function capabilityDelta(previous: HarnessCapabilitiesSnapshot | undefined, next: HarnessCapabilitiesSnapshot): string {
  if (previous === undefined) {
    return 'Loaded ' + String(next.providers.length) + ' providers, ' + String(next.skills.length) + ' Skills, ' + String(next.presets.length) + ' presets and ' + String(next.subagents.length) + ' sub-agents.'
  }
  const changes = [
    namedDelta('providers', previous.providers, next.providers, value => value, value => value),
    namedDelta('Skills', previous.skills, next.skills, value => value.name, value => value.name + '\u0000' + (value.description ?? '') + '\u0000' + String(value.modelInvocable)),
    namedDelta('presets', previous.presets, next.presets, value => value.id, value => value.id + '\u0000' + value.name + '\u0000' + (value.description ?? '') + '\u0000' + (value.broken ?? '')),
    namedDelta('sub-agents', previous.subagents, next.subagents, value => value.id, value => value.id + '\u0000' + (value.status ?? '')),
  ].filter((value): value is string => value !== undefined)
  return changes.length === 0 ? 'No capability changes detected.' : changes.join(' · ')
}

function namedDelta<T>(label: string, previous: readonly T[], next: readonly T[], key: (value: T) => string, signature: (value: T) => string): string | undefined {
  const before = new Map(previous.map(value => [key(value), signature(value)]))
  const after = new Map(next.map(value => [key(value), signature(value)]))
  let added = 0
  let removed = 0
  let updated = 0
  for (const [entry, value] of after) {
    if (!before.has(entry)) added += 1
    else if (before.get(entry) !== value) updated += 1
  }
  for (const entry of before.keys()) {
    if (!after.has(entry)) removed += 1
  }
  if (added === 0 && removed === 0 && updated === 0) return undefined
  const parts = []
  if (added > 0) parts.push('+' + String(added))
  if (removed > 0) parts.push('−' + String(removed))
  if (updated > 0) parts.push('updated ' + String(updated))
  return label + ' ' + parts.join(', ')
}
