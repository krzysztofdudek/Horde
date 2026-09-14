# 092 · wave-close template always prints a stale Escalated: 0 line

**Status:** done
**Kind:** cleanup
**Priority:** 3
**Tier:** standard
**Tags:** proces
**Files:** templates/wave-close.md
**Found by:** worker 003, while removing the seat model's remaining writers
**Where:**

## What


## Why


## Acceptance


## Evidence

- **ran:** grep -n 'Escalated' skills/horde/templates/wave-close.md · **saw:** **Escalated (pre-6.0.0 legacy):** {{escalated}} — relabeled, not removed, since the field still reads real legacy data for repos migrating from pre-6.0.0 state

