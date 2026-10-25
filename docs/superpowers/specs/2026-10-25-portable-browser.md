# Portable browser and single-entry MCP

User requires an internal independent lightweight browser, portable distribution, one MCP configuration and durable logins. Prior authorization: execute without step confirmations, retain local accounts, publish private repo and keep CI passing.

Use a project-local pinned Playwright Chromium runtime, downloaded once by setup; no Edge/Chrome dependency or extra Electron app. A shared browser workspace persists under each Windows user's `.thu-campus-mcp/browser`. A filesystem lease prevents competing profile owners. Browser profile, encrypted DPAPI storage snapshots and service token stores stay out of Git and release artifacts. Session cookies/localStorage/IndexedDB survive normal close/reopen; expiry/revocation remains server-controlled.

New `@thu-campus/browser` workspace provides runtime detection/install, profile/vault and status/reset primitives. Three existing browser login adapters use this profile and conditional credential commits; explicit `--channel` remains an optional compatibility escape hatch. Browser login can reuse a configured account, with a short headless recovery mode. Root broker owns detached browser open/login jobs so MCP calls return promptly and a client shutdown does not close a login window. No unauthenticated debugging endpoint is exposed.

Root `serve` aggregates the 46 existing tools through MCP SDK stdio clients, preserving original schemas, results and prompts, plus browser status/open/login tools. Read-only AUTH_REQUIRED may try one bounded headless restoration from an explicitly bound browser profile, then retry that read once. Writes are never replayed. Account switch/logout invalidates pending commits; restoration must not substitute another cloud/rain account. LearnX recovery requires matching profile binding and current store version; interactive account changes are explicit.

Unified installer registers one `thu-campus` entry in four clients, preserving existing state/output env and backing up client files. Existing split registrations are removed only when recognized as this bundle's owned entries. Split mode remains compatible. Existing users' auth files are not migrated or deleted.

Setup prepares dependencies, builds and installs one browser. Runtime path is resolved relative to the checkout so moved directories work after updating a single MCP command path. README covers new-user single-entry setup, first login, automatic reuse/recovery, browser lifecycle, upgrade/move, reset/logout, offline use and limits. Source ZIP stays credential-free; optional prepared bundle includes runtime/compiled code and installation metadata but never profiles.

Alternatives rejected: OS Edge/WebView2 violates independent-browser requirement; bundling Electron duplicates Node/UI runtime; only retaining API cookies misses shared SSO/session storage.
