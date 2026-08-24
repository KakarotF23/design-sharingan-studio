# SCREEN-REGISTRY.md Template

| Screen / State | Family | Inherits | Intentional exceptions | Required states | Evidence | Last verified |
|---|---|---|---|---|---|---|
| Home | Dashboard/Home | | | default, loading, error | | |

## Rules
- Every new or materially changed screen belongs to a family.
- Exceptions require a documented reason.
- “Looks nicer” is not a sufficient exception.
- Register applicable states, not only happy paths.
- Evidence must refer to actual current renders when available.
