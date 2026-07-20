# Development Rules

## Architecture Rules

- System architecture is Modular Monolith.
- Backend owns all business logic.
- Frontend only sends commands and displays queries.
- Database is the source of truth.

## Inventory Rules

- No direct stock editing.
- Every inventory change happens through Movement.
- Movement is immutable.
- Quantity calculations are derived.

## Code Rules

- No duplicated business logic.
- Every important action requires audit.
- Every command requires validation.
- Every database change requires migration.

## Quality Rules

- No feature is complete without:
  - Validation
  - Error handling
  - Audit trail
  - Testing

## AI Working Rules

AI must:
- Explain before major changes.
- Follow existing architecture.
- Not redesign without approval.
- Keep documentation updated.
