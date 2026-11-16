# ADR-0061: Database TLS means `verify-full`, stated once

- Status: accepted
- Date: 2026-11-16
- Changes: the TLS half of ADR-0057 (the Cloud SQL socket half is unchanged)

## Context

In staging and production a database URL to a network address had to carry `sslmode=require`,
`verify-ca` or `verify-full` (ADR-0057). Three problems, the last two found by asking the driver
what it does with each spelling:

1. **`require` is about to mean less.** Today the driver verifies the server's certificate and
   name for `require` and `verify-ca`. It warns that its next major version will follow libpq,
   where `require` verifies nothing. An upgrade would have weakened every connection silently.
2. **A repeated `sslmode` could switch TLS off.** The driver uses the last one; the check read the
   first. `?sslmode=verify-full&sslmode=disable` passed the check and connected in the clear.
3. **`uselibpqcompat=true` already weakens `require`.** With it, `sslmode=require` connects
   without verifying the certificate. The check accepted it.

Nothing is deployed yet, so no running system was exposed. Staging will use the Cloud SQL socket
(ADR-0057), which this rule does not touch.

## Decision

A network database URL is accepted in staging and production only when:

- it has **exactly one** `sslmode`, and it is **`verify-full`**: the server's certificate chain and
  its name are both checked;
- it has **no `uselibpqcompat`** parameter, with any value;
- it has **no `ssl`** parameter.

A CA file (`sslrootcert`) and client certificates remain allowed: they do not weaken verification.

Everything else is refused at start-up with an error that names the setting and never the URL.
Local and CI are unchanged.

## How it is tested

- **Unit:** the accepted forms, and 13 refused ones: weaker modes, other spellings, repeated
  `sslmode` in both orders, the compatibility switch, an `ssl` switch.
- **Driver parity:** 69 URL variants (every pair of modes, and each mode with each extra
  parameter) are given to the real driver. Whatever the rule accepts, the driver must connect over
  the network and verify the server. Exactly two variants are accepted.
- **The gaps themselves:** the two spellings above, and one more, are shown to be unverified in the
  driver and refused by the rule.
- **Mutation checks:** 8 changes, 7 caught; the survivor is equivalent (with exactly one `sslmode`,
  first and last are the same).

## Consequences

- Anyone connecting over the network must have a certificate the client can verify: a public CA,
  or the provider's CA passed with `sslrootcert`.
- The driver upgrade no longer changes what an accepted URL means. The parity test still runs
  against whichever driver version is installed.
