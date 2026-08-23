# Nexa AI Local Bridge 1.6.3

Windows companion for Nexa AI Computer Bridge.

## 1.6.3 — Direct Remote Work Channel


### Gmail / DKIM interoperability fix

- Fixed RFC 6376 DKIM header oversigning verification. Gmail may intentionally list `From` more times in `h=` than the message contains; those nonexistent oversigned instances are null input, not a verification error.
- Fixed the DKIM-Signature canonicalization boundary so the signature field is hashed without a trailing CRLF, as required by RFC 6376.
- Added a real RSA cryptographic regression test for an oversigned `From` header so this exact Gmail failure cannot silently return.
- This fix preserves cryptographic DKIM verification; it does not weaken the sender allowlist, challenge, expiration, replay protection, Hostinger permission gates, Allowed Folders, backups or rollback.

### App Builder parser compatibility hardening

- Replaced the MIME encoded-word regex literal that Nexa App Builder's conservative local delimiter scanner misclassified as unterminated.
- Added a package-wide `validate:appbuilder` gate that mirrors the App Builder delimiter/regex scanner before any future build is dispatched.
- The final delivery is checked with both Node syntax validation and the actual PHP scanner logic recovered from the App Builder source used for this project.

This release keeps the working Hostinger + Unity + GitHub mirror from 1.5.0 and adds a separate, transactional Remote Command Inbox so remote work no longer depends on GitHub file-write permissions.

### New secure Remote Command Inbox

- Polls a dedicated POP3S mailbox over TLS.
- Accepts only messages with subject prefix `[NEXA-CMD]`.
- Enforces an allowlisted sender.
- Can require SPF/DKIM/DMARC pass evidence from received headers.
- Uses a rotating local channel challenge so copied or stale command packages are rejected.
- Enforces command IDs, expiration windows and replay protection.
- Stores mailbox password encrypted with Electron `safeStorage`.
- Never publishes mailbox credentials to Hostinger or GitHub.
- Writes only redacted command/result summaries into the mirrored `__NEXA__` status files.

### Remote work engine

A valid command package can perform permission-gated batches of actions, including:

- computer status, drives, folders and file reads;
- text and binary file writes;
- create/copy/move/delete paths;
- CMD, PowerShell, Python and Git commands;
- explicit process execution when Full Computer Mode is enabled;
- HTTPS file downloads into Allowed Folders;
- Unity refresh, capture, play/stop/pause, scene open/save;
- Unity menu item execution;
- Unity Editor jobs;
- wait for Unity compilation and collect real compiler diagnostics.

Every action still requires the corresponding Hostinger permission and is restricted to configured Allowed Folders where applicable.

### Transactional safety

- Multi-file jobs run as one transaction.
- Existing files/folders are backed up before mutation.
- Failed actions automatically roll back prior changes unless explicitly disabled.
- Optional Unity compile verification can automatically roll back a completed batch if real compiler errors appear.
- SHA-256 preconditions can protect files against overwriting concurrent local edits.
- Symlink/junction escapes outside Allowed Folders are blocked.
- Deleting or moving an Allowed Folder root itself is blocked.
- Backup transactions are capped to avoid accidental huge local copies.

### Unity integration

The Unity bridge can now receive explicit local requests for:

- AssetDatabase refresh;
- Scene/Game capture;
- Play/Stop/Pause/Unpause;
- open/save scene;
- execute Unity menu item;
- run a temporary Unity Editor job;
- wait for compilation and return clean diagnostics.

The 1.5.0 diagnostic improvements remain intact: Licensing/service noise is kept separate from real C#/shader compile errors.

### GitHub remains the read/verification mirror

GitHub Remote Workspace remains available for:

- C# scripts and Unity text assets;
- ProjectSettings / Packages;
- clean compile diagnostics;
- scene/game screenshots;
- verification snapshots that ChatGPT can inspect.

The old GitHub write-back switch remains only as a compatibility option. For direct remote work use the Remote Command Inbox instead, because it does not depend on ChatGPT's GitHub connector having repository file-write permission.

## One-time setup after installing 1.6.3

1. Keep your existing Hostinger pairing and Allowed Folders.
2. Keep your Unity Project Path configured.
3. Reinstall **Unity Integration** once from the Windows app so the Unity-side command handler is current.
4. Configure a dedicated POP3S mailbox in **Remote Command Inbox**.
5. Set the allowed sender email address.
6. Leave **Require authenticated sender** enabled unless your mail provider cannot expose SPF/DKIM/DMARC results through POP headers.
7. Test the mailbox from the app.
8. Enable **Remote Command Inbox**.
9. Keep the Hostinger permissions you want remote jobs to use enabled. Emergency Stop always overrides all remote work.

## Recommended operating mode

- GitHub workspace publishing: ON for read/verification snapshots.
- Legacy GitHub write-back: OFF.
- Remote Command Inbox: ON after mailbox test passes.
- Apply only the Hostinger permissions required for the current work.
- Use Full Computer Mode only when a job genuinely needs arbitrary process execution outside the narrower built-in actions.

## Validation

The 1.6.3 source package includes syntax checks, delivery graph validation, project validation, baseline tests, implementation tests and acceptance tests covering the Remote Command Inbox, transactional executor, Unity integration, diagnostics, security gates, path restrictions and rollback behavior.
