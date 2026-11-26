# ADR-0073: Recovery objectives: at most 5 minutes of data lost, back within 4 hours

- Status: accepted
- Date: 2026-11-26
- Closes: D8 (RPO and RTO)

## Context

Production needs stated recovery objectives before launch: how much data may be lost (RPO) and
how long EventHub may be down (RTO) after the database fails or data is damaged. The database is
Cloud SQL for PostgreSQL 16, Enterprise edition, in `asia-southeast1` (ADR-0055, ADR-0056).
Decided with the product owner on 2026-11-26.

## Decision

| Objective | Target          | How                                                                                        |
| --------- | --------------- | ------------------------------------------------------------------------------------------ |
| **RPO**   | **≤ 5 minutes** | Point-in-time recovery from the write-ahead log, kept 7 days                               |
| **RTO**   | **≤ 4 hours**   | Restore to a new instance at a chosen moment, point the services at it, verify; no standby |

### Cloud SQL settings (staging and production)

- Point-in-time recovery **on**, transaction logs kept **7 days** (Enterprise allows 1 to 7
  days, at no extra charge for the logs:
  [Google](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/configure-pitr)).
- Daily automated backups, **8 kept** (Google recommends one more backup than days of logs),
  in the same region.
- **No high-availability standby.** A zone failure is recovered by restoring, within the 4-hour
  target. A standby would roughly double the database cost; it becomes the next step if the
  4-hour target is ever too long.
- The commands are in `docs/operations/staging-setup.md`. The product owner runs them; nothing
  here changes a live project.

### Restore drill

Every quarter, and after any change to the backup settings, restore production to a new
instance at a point from the previous day, then run the migration check and a read of each
tenant table. Record the time it took. A drill longer than 4 hours is an incident to act on.

## Consequences

- At most 7 days back: damage found later than that cannot be undone from Cloud SQL. The audit
  log (ADR-0074 retention) shows what happened, but it is not a backup.
- The 4-hour target assumes someone is reachable to start the restore. On-call arrangements are
  not part of this decision.
