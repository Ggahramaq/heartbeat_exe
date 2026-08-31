const entries = new Map()

export async function cached(key, ttlMs, loader) {
  const now = Date.now()
  const entry = entries.get(key)
  if (entry?.value !== undefined && entry.expiresAt > now) return entry.value
  if (entry?.promise) return entry.promise

  const promise = loader()
    .then((value) => {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs })
      return value
    })
    .catch((error) => {
      entries.delete(key)
      throw error
    })

  entries.set(key, { promise, expiresAt: now + ttlMs })
  return promise
}
