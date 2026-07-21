/** Prefix a site-internal path with the configured base URL. */
export function href(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return `${base}${path.replace(/^\//, '')}`;
}
