# Fashion Operations OS Architecture

## Vision
Enterprise fashion warehouse and operations system.

## Architecture Decision
Modular Monolith

## Database
PostgreSQL 15

## Main Contexts

- Product
- Purchasing
- Inbound
- Inventory
- Quality
- Fulfillment
- Reverse
- Control
- Admin
- Platform

## Core Truth

Inventory truth is based on:
- Immutable Movement
- Lot tracking
- Audit history
- Derived inventory calculations

## Frontend
React based operational workbench

## Backend
API driven business logic

## Rule
UI owns no business logic.
