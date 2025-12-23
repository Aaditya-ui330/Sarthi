// /js/api.js

import { getIdToken } from './auth.js';

const isLocalhost =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1';
const DEFAULT_API_BASE = isLocalhost
  ? 'http://127.0.0.1:5000/api'
  : 'https://sarthi-backend.onrender.com/api'; // Set to your backend API base
const API_BASE = (window.__API_URL__ && window.__API_URL__.replace(/\/$/, '')) || DEFAULT_API_BASE;
const DEFAULT_TIMEOUT = 30000; // milliseconds

async function attachAuthHeader(headers = {}) {
  try {
    const token = typeof getIdToken === 'function' ? await getIdToken() : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch (e) {
    console.warn('getIdToken error', e);
  }
  return headers;
}

function buildUrl(path, params = {}) {
  const base = path.startsWith('/') ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
  if (!params || Object.keys(params).length === 0) return base;
  const urlObj = new URL(base, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      urlObj.searchParams.set(k, v);
    }
  });
  return urlObj.toString();
}

async function apiRequest(path, { method = 'GET', params = null, body = null, headers = {}, auth = true } = {}) {
  const url = buildUrl(path, params);
  if (auth) headers = await attachAuthHeader(headers);

  const options = { method, headers };

  if (body) {
    // Automatically handle JSON or FormData
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers = { 'Content-Type': 'application/json', ...options.headers };
      options.body = JSON.stringify(body);
    }
  }

  // Timeout support
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  options.signal = controller.signal;

  let response;
  try {
    response = await fetch(url, options);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const err = new Error(`API error ${response.status} ${response.statusText}`);
    err.status = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

const api = {
  get: (path, opts = {}) => apiRequest(path, { ...opts, method: 'GET' }),
  post: (path, body, opts = {}) => apiRequest(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts = {}) => apiRequest(path, { ...opts, method: 'PUT', body }),
  del: (path, opts = {}) => apiRequest(path, { ...opts, method: 'DELETE' })
};

export default api;
