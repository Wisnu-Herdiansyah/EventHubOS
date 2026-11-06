/** Reads a text field from submitted form data. File parts are never accepted as text. */
export function formText(form: FormData, key: string, { trim = true } = {}): string {
  const value = form.get(key);
  if (typeof value !== 'string') return '';
  return trim ? value.trim() : value;
}

/** Never sent back to the browser in form state. */
const NEVER_ECHOED = new Set(['password', 'token', 'idempotencyKey', 'next']);

/**
 * The text a user submitted, so a failed form can be refilled (React resets uncontrolled forms
 * after every action). Secrets and framework fields (`$ACTION_*`) are excluded.
 */
export function submittedValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string' || key.startsWith('$') || NEVER_ECHOED.has(key)) continue;
    values[key] ??= value;
  }
  return values;
}
