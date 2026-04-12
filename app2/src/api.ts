const API = (
  import.meta.env.VITE_API_URL || 'https://reach-dm-production.up.railway.app'
).replace(/\/api\/?$/, '')
const PREFIX = '/api'

export function apiUrl(path: string) {
  return `${API}${PREFIX}${path.startsWith('/') ? path : `/${path}`}`
}

export async function uploadPublicPhoto(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch(`${API}${PREFIX}/public/upload`, {
    method: 'POST',
    body: fd,
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || 'Photo upload failed')
  }
  const data = (await r.json()) as { photo_url?: string }
  if (!data.photo_url) throw new Error('No photo_url in response')
  return data.photo_url
}

export { API }
