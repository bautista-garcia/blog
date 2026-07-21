let counter = 0;

/** Unique id per page render, used to wire the label/checkbox toggle pair. */
export function nextSidenoteId(): string {
  counter += 1;
  return `sn-${counter}`;
}
