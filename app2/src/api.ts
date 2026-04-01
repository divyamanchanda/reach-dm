const API =
  import.meta.env.VITE_API_URL || 'https://reach-dm-production.up.railway.app'
const PREFIX = '/api'

export function apiUrl(path: string) {
  return `${API}${PREFIX}${path.startsWith('/') ? path : `/${path}`}`
}

export { API }
