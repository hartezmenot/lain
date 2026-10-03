# ADR-001: API field naming

The API speaks snake_case JSON (`display_name`, `avatar_url`), because the
mobile client and the data warehouse already do. The web client converts to
camelCase at the boundary, in one place (`normalizeUser` and friends in
`src/api.js`), and nowhere else.
