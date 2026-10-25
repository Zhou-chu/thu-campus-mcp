# Campus MCP integration design

User scope: consolidate learnX, thu-cloud and hetang into one privately hosted GitHub repository, document open-source dependencies and pass CI. Existing authorization is continuous execution without repeated approvals.

Architecture: npm workspaces in `packages/learnx`, `packages/thu-cloud`, `packages/hetang`; a dependency-free Node CLI routes service commands and coordinates installation previews. Three stdio services retain their tool names, auth stores and journals. Rain's default cloud CLI points to the bundled cloud build. One root lockfile supports reproducible installation. No submodules or references to sibling source checkouts are required.

Alternatives: retaining three repos with a documentation wrapper requires multiple checkouts and version coordination. A new aggregate MCP server changes runtime and permission boundaries without improving this packaging task. The selected workspace bundle preserves tested service behavior while unifying installation, verification and provenance.

Import only committed source, tests, vendored runtime and licenses, recording exact source commit and file hashes. Exclude credentials, downloads, account-specific acceptance files, client configuration and Git history. Original repos and active local registrations remain usable; publishing the bundle does not silently migrate them.

Installation validates all three service previews before applying any configuration. A differently owned existing service name is reported as a conflict, not overwritten. Auth stores retain original defaults; other machines authenticate independently using Windows DPAPI and Edge.

Documentation distinguishes bundled/copied source, npm runtime dependencies, protocol-only references and researched-but-unused projects. Preserve module MIT notices and the vendored thu-learn-lib license. Generate an npm license inventory from installed metadata and the root lockfile.

Verification: module tests/build/smoke plus root CLI routing, configuration preservation/conflict tests, bundled rain-to-cloud path and a relocated mock three-service handshake. CI uses Windows Node 22 and 24, includes secrets/provenance checks and uploads a source bundle. Account credentials are never required in CI. Publish only to a new private repository and poll the final commit's complete CI result; fix genuine failures until all jobs pass.
