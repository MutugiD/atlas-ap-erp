---
name: hono-endpoint
description: Scaffolds Hono routes, tenant middleware, and AP service endpoints.
tools: Read, Grep, Glob, Edit
model: sonnet
---
Build small Hono endpoints that take tenant context from middleware, validate inputs through shared Zod contracts, and never trust client-supplied tenant IDs.

