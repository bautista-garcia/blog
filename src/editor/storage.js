const RECOVERY_PREFIX = 'blog-editor:recovery:';
const PREFERENCE_PREFIX = 'blog-editor:preference:';

function safeParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function loadRecovery(repo, key) {
  return safeParse(localStorage.getItem(`${RECOVERY_PREFIX}${repo}:${key}`));
}

export function saveRecovery(repo, key, value) {
  localStorage.setItem(
    `${RECOVERY_PREFIX}${repo}:${key}`,
    JSON.stringify({ ...value, savedAt: new Date().toISOString() }),
  );
}

export function clearRecovery(repo, key) {
  localStorage.removeItem(`${RECOVERY_PREFIX}${repo}:${key}`);
}

export function getPreference(key, fallback) {
  return safeParse(localStorage.getItem(`${PREFERENCE_PREFIX}${key}`), fallback);
}

export function setPreference(key, value) {
  localStorage.setItem(`${PREFERENCE_PREFIX}${key}`, JSON.stringify(value));
}
