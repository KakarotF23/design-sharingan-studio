# Design Release Gate

A release-level PASS requires fresh evidence.

- [ ] Claimed screens/states are enumerated.
- [ ] Every new/changed screen is registered.
- [ ] No unresolved CRITICAL finding in release scope.
- [ ] No unapproved IMPORTANT new design rule.
- [ ] Applicable default/loading/empty/error/locked/premium states are covered.
- [ ] Navigation regression: zero known.
- [ ] Accessibility regression: zero known.
- [ ] Rendered evidence is fresh after the final UI change.
- [ ] Intentional exceptions reference a Design Decision Record.
- [ ] Relevant functional checks pass.

Statuses:
- **PASS**
- **PASS WITH DEBT**
- **NOT VERIFIED**
- **BLOCKED**
