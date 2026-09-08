// Minimal GitHub Contents API client used by the /editor subsite.
// Everything the editor does — list, read, create, update, delete, upload —
// is a commit to the repo through these endpoints.

const API = 'https://api.github.com';

export function createClient({ token, owner, repo, branch }) {
  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function request(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: { ...baseHeaders, ...(options.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || `GitHub API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  const repoPath = `/repos/${owner}/${repo}`;
  const contentPath = (path) => `${repoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  return {
    /** Cheap auth/permission check. */
    test: () => request(repoPath),

    listPosts: () => request(`${repoPath}/contents/src/content/posts?ref=${encodeURIComponent(branch)}`),

    getFile: (path, ref = branch) => request(`${contentPath(path)}?ref=${encodeURIComponent(ref)}`),

    listCommits: (path) =>
      request(
        `${repoPath}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=20`,
      ),

    /** Create or update a file. Pass `sha` to update an existing file. */
    putFile: (path, contentBase64, message, sha) =>
      request(contentPath(path), {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: contentBase64,
          branch,
          ...(sha ? { sha } : {}),
        }),
      }),

    deleteFile: (path, message, sha) =>
      request(contentPath(path), {
        method: 'DELETE',
        body: JSON.stringify({ message, sha, branch }),
      }),
  };
}

/** Unicode-safe base64 encode (for post text). */
export function textToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Unicode-safe base64 decode (GitHub returns content with newlines). */
export function base64ToText(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Read a File/Blob as raw base64 (no data: URL prefix). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
