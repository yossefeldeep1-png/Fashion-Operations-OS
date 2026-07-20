# Database Foundation

## Database Engine
PostgreSQL 15

## Architecture
Single database modular monolith.

## Schema Strategy

product
purchasing
inbound
inventory
quality
fulfillment
reverse
control
admin
platform

## Common Fields

Every table should contain:

id UUID v7
code
status
version
created_at
updated_at
created_by
updated_by
deleted_at
warehouse_id

## Rules

- Foreign keys enforced
- No physical delete for important data
- Audit required
- Inventory transactions immutable
