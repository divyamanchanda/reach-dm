const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const PREFIX = '/api'

export function apiUrl(path: string) {
  return `${API}${PREFIX}${path.startsWith('/') ? path : `/${path}`}`
}

export { API }
