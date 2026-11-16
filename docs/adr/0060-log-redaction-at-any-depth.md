# ADR-0060: Log redaction at any depth

- Status: accepted
- Date: 2026-11-16
- Builds on: ADR-0054 (provider keys in configuration), ADR-0058 (signed visitor addresses)

## Context

Logs must never hold credentials, session material or personal data. Until now the services
relied on a list of paths given to the logger (`LOG_REDACT_PATHS`). Two gaps:

- **Depth.** The logger's wildcard matches one level. `*.password` hides `user.password` but not
  `job.user.password`, so each depth of each name had to be listed, and a deeper one slipped
  through silently.
- **Text.** Paths only hide whole fields. A database URL with its password inside an error
  message, a token in a request URL, or an email address in a database error detail went to the
  log as written.

Staging is about to hold real addresses and real keys, so both gaps are closed first.

## Decision

Every log line passes through one function, `redactLogLine`, just before it is written. It works
on the **finished line**, so it covers everything the logger produces: logged objects, child
logger bindings, serialized requests, responses and errors, stack traces, and the message.

Two passes:

1. **Names, at any depth.** The line is parsed and every field with a sensitive name is replaced
   by `[REDACTED]`, however deeply nested, in arrays too.
   - Names are compared in lower case with punctuation removed: `set-cookie`, `setCookie` and
     `SET_COOKIE` are one name.
   - A fixed list (`authorization`, `cookie`, `email`, `recipients`, `body`, ...) and a list of
     endings (`...password`, `...token`, `...secret`, `...apiKey`, `...encryptionKey`, ...).
   - A field that is not set (`null`) stays visible: "no password given" is useful in a log.
2. **Text, anywhere.** Then, in every piece of text:
   - the password in a URL (`scheme://user:[REDACTED]@host`);
   - secret query parameters (`?token=[REDACTED]`);
   - `Bearer` and `Basic` credentials;
   - email addresses, masked to `a***@example.com`.

The path list stays as a first layer inside the logger. All services use one helper,
`redactingLogOptions()`, so they cannot drift apart.

### Why the finished line

The first attempt used the logger's own hooks for objects. It failed in two ways that tests
caught: the hook is not applied to child loggers, and applying it before the request serializer
emptied the request record. One pass over the finished line has neither problem and is simpler.

### Checked against real log lines

A real worker start-up was read through the new redaction before this was accepted. It showed two
readability faults, both fixed:

- package paths in stack traces (`pg-pool@3.14.0`) were masked as if they were email addresses.
  An address now needs a domain ending in letters;
- the worker logged its email adapter under the field `email`, which is always hidden. The field
  is now `emailSender`.

## Costs and limits

- **Cost.** Each line is parsed and written again. At this system's log volume that is
  negligible; it would be revisited before high-volume debug logging in production.
- **Over-redaction is accepted.** A field named `email` holding a settings object is hidden whole.
  Losing a little detail is the safe direction.
- **Names only go so far.** A secret stored under an unremarkable name (`value`, `data`) is not
  caught by the first pass. The text pass catches the common shapes. The rule for code remains:
  do not log secrets in the first place.
- **A password containing an unencoded `/`** inside a URL is not recognised as a URL password.
  The deployment scripts generate URL-safe passwords and encode typed ones (ADR-0059).
- **Not covered:** logs written by the platforms themselves (Cloud Run request logs, Vercel), and
  the two Next.js apps, which do not log request data.

## How it is tested

- **Names:** 24 spellings recognised; 13 look-alikes left alone (`emailSender`, `idempotencyKey`,
  `passwordless`).
- **Values:** nesting deeper than any listed path, arrays, cycles, very deep values, no change to
  the input.
- **Text:** URL passwords (including the Cloud SQL socket form), ports not mistaken for
  passwords, query parameters, bearer tokens, emails; a scrubbed JSON line stays valid JSON.
- **Through the real logger:** nested configuration, an error with credentials in its message,
  detail, cause and stack, child logger bindings, and ordinary content left intact.
- **Through the API server:** a request with a token in its URL and credentials in its headers is
  logged with its path and without the secrets.
- **Mutation checks:** 20 changes, 19 caught; the survivor was dead code, now removed.
