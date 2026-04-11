import { ulid } from 'ulid'

function createPrefixedId(prefix: string): string {
  return `${prefix}_${ulid()}`
}

export function generateJobId(): string {
  return createPrefixedId('job')
}

export function generateWorkerId(): string {
  return createPrefixedId('wrk')
}

export function generateEventId(): string {
  return createPrefixedId('evt')
}

export function generateArtifactId(): string {
  return createPrefixedId('art')
}
