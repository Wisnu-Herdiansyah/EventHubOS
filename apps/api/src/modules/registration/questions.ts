import { z } from 'zod';

/**
 * Registration questions (ADR-0041): typed, plain-text questions on the sign-up form, defined in
 * the event's settings, and the answers a visitor gives. Answers are personal data: they are
 * validated here against the event's current questions and never logged or audited.
 */
export const MAX_QUESTIONS = 10;
export const QUESTION_TYPES = ['short_text', 'long_text', 'choice', 'yes_no'] as const;

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use a single line of plain text.');

export const questionSchema = z
  .object({
    /** Stable key of the answers; keep it when rewording the question. */
    id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Use lowercase letters, digits and hyphens.'),
    type: z.enum(QUESTION_TYPES),
    label: line(200).min(1, 'Write the question.'),
    help: line(200).optional(),
    required: z.boolean(),
    /** Choice questions only: 2–20 distinct options. */
    options: z.array(line(100).min(1, 'Options cannot be empty.')).max(20).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.type === 'choice') {
      if (!q.options || q.options.length < 2) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Give at least two options.' });
      } else if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be different.' });
      }
    } else if (q.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only choice questions have options.',
      });
    }
  })
  .meta({ id: 'RegistrationQuestion' });

export type Question = z.infer<typeof questionSchema>;

export const questionsSchema = z
  .array(questionSchema)
  .max(MAX_QUESTIONS)
  .superRefine((qs, ctx) => {
    const seen = new Set<string>();
    qs.forEach((q, i) => {
      if (seen.has(q.id)) {
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Question IDs must be unique.' });
      }
      seen.add(q.id);
    });
  });

/** Questions as stored in event settings; anything that no longer validates counts as none. */
export function storedQuestions(value: unknown): Question[] {
  const parsed = questionsSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** A visitor's answers, keyed by question ID: text, the chosen option, or yes/no. */
export const answersInput = z
  .record(z.string().max(40), z.union([z.string().max(2000), z.boolean()]))
  .refine((a) => Object.keys(a).length <= MAX_QUESTIONS, 'Too many answers.')
  .meta({ id: 'RegistrationAnswers' });

export type Answers = Record<string, string | boolean>;

// eslint-disable-next-line no-control-regex
const MULTILINE_OK = /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/;

/**
 * Checks answers against the event's questions. Returns field issues (paths under
 * `body.answers.<id>`) and the cleaned answers: trimmed, empty optional answers dropped, and
 * nothing for questions the event does not ask.
 */
export function checkAnswers(
  questions: Question[],
  raw: Record<string, string | boolean>,
): { answers: Answers; issues: Array<{ path: string; message: string }> } {
  const issues: Array<{ path: string; message: string }> = [];
  const answers: Answers = {};
  const known = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      issues.push({ path: `body.answers.${key}`, message: 'This question is not asked.' });
    }
  }
  for (const q of questions) {
    const path = `body.answers.${q.id}`;
    const value = raw[q.id];
    if (q.type === 'yes_no') {
      if (value === undefined) {
        if (q.required) issues.push({ path, message: 'Answer yes or no.' });
      } else if (typeof value !== 'boolean') {
        issues.push({ path, message: 'Answer yes or no.' });
      } else {
        answers[q.id] = value;
      }
      continue;
    }
    if (value !== undefined && typeof value !== 'string') {
      issues.push({ path, message: 'Answer with text.' });
      continue;
    }
    const text = (value ?? '').trim();
    if (!text) {
      if (q.required) issues.push({ path, message: 'This question needs an answer.' });
      continue;
    }
    if (q.type === 'choice') {
      if (!q.options?.includes(text)) issues.push({ path, message: 'Choose one of the options.' });
      else answers[q.id] = text;
      continue;
    }
    const max = q.type === 'short_text' ? 200 : 2000;
    // eslint-disable-next-line no-control-regex
    const ok = q.type === 'short_text' ? /^[^\u0000-\u001f\u007f]*$/ : MULTILINE_OK;
    if (text.length > max) issues.push({ path, message: `Keep it under ${max} characters.` });
    else if (!ok.test(text)) issues.push({ path, message: 'Use plain text.' });
    else answers[q.id] = text;
  }
  return { answers, issues };
}
