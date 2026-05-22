const _cache = new Map();

export async function loadDataFile(path) {
  if (_cache.has(path)) return _cache.get(path);

  const res = await fetch(`./${path}?_=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);

  const data = await res.json();
  _cache.set(path, data);
  return data;
}

export function bustCache(path) {
  _cache.delete(path);
}
