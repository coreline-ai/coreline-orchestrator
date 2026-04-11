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

export function generateSessionId(): string {
  return createPrefixedId('sess')
}

export function generateEventId(): string {
  return createPrefixedId('evt')
}

export function generateArtifactId(): string {
  return createPrefixedId('art')
}

export function generateExecutorId(): string {
  return createPrefixedId('exec')
}
