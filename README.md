# Nexa AI Local Bridge 1.5.0

Windows companion for Nexa AI Computer Bridge.

## 1.5.0 — Unity Diagnostics Quality Update

This release keeps the existing Hostinger + Unity + GitHub Remote Workspace workflow and improves the diagnostic layer so Unity service noise is no longer reported as gameplay/compiler failure.

### Clean compiler diagnostics

- Unity Licensing / entitlement 404 messages are no longer counted as C# compile errors.
- Real compiler errors are detected with narrow Unity/C# patterns instead of a broad generic `Error:` match.
- Repeated identical compiler errors are deduplicated and keep an occurrence count.
- Unity plugin compiler messages and Editor.log compiler messages are merged safely.
- `compile_error_count` now represents distinct real compile errors.
- `compile_error_occurrences` preserves how many times those errors appeared.

### Unity service issues are separate

The mirror now publishes service/environment issues separately from compile errors:

- Unity Licensing
- Package Manager
- Unity Services
- connectivity/service diagnostics

`__NEXA__/diagnostics.json` contains the clean diagnostic summary, while `__NEXA__/unity-status.json` contains the full current Unity state.

### Security hardening

The mirrored `__NEXA__/UnityEditor.log` is now sanitized before it leaves the PC. The sanitizer redacts common sensitive values including:

- Unity `-accessToken`
- Bearer authorization values
- GitHub PAT formats
- Nexa pairing-token patterns
- public-workspace secret keys
- API-key style values
- the Windows username portion of `C:\Users\...`

The local Unity Editor log itself is not modified.

### Unity integration plugin 1.5.0

Reinstall **Unity Integration** once after installing this release.

The plugin now:

- clears stale compiler errors when a new compilation starts;
- records compilation phase and last update;
- deduplicates compiler errors at the Unity source;
- reports its plugin version;
- writes capture result/error state;
- uses the current Unity object-search API on Unity 2022.2+ to avoid the obsolete `FindObjectOfType` warning.

### Existing 1.4.0 features retained

- Hostinger secure heartbeat and policy
- Unity project mirror
- Scene View and Game View captures
- GitHub Remote Workspace publishing
- optional guarded text write-back
- conflict protection
- Electron `safeStorage` for local secrets
