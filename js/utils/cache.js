const PREFIX = 'dash_cache_';

export const cache = {
  set(key, data, ttlMs) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({
        data,
        expires: ttlMs ? Date.now() + ttlMs : null,
      }));
    } catch { /* quota exceeded — skip cache */ }
  },

  get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const { data, expires } = JSON.parse(raw);
      if (expires && Date.now() > expires) {
        localStorage.removeItem(PREFIX + key);
        return null;
      }
      return data;
    } catch { return null; }
  },

  remove(key) {
    localStorage.removeItem(PREFIX + key);
  },

  clear() {
    Object.keys(localStorage)
      .filter(k => k.startsWith(PREFIX))
      .forEach(k => localStorage.removeItem(k));
  },
};
