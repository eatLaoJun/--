# Demo course service

Small repository used by ForgePilot's local demo and tests.

- `src/pagination.js` contains the reported defect.
- `tests/pagination.test.js` encodes the expected behavior and is protected.
- `scripts/repro-pagination.js` reproduces the defect on the baseline and is protected.

Run:

```bash
node --test tests/pagination.test.js
node scripts/repro-pagination.js
```
