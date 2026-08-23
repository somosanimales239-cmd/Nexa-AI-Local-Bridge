# Nexa AI Local Bridge 1.7.0

Windows companion for **Nexa AI Computer Bridge 6.0.0**.

## Primary architecture

`Hostinger Nexa AI Computer Bridge -> outbound polling by Nexa AI Local Bridge -> authorized Windows PC / Unity -> result back to Hostinger`

The Hostinger command queue is the **primary control transport**. Gmail/POP3S is retained only as an optional fallback and is not required for normal operation.

## Direct computer capabilities

The Hostinger queue can request, subject to the current web policy and local Allowed Folders:

- computer, drive, directory, process, GPU and CUDA status;
- `find_files`, `find_file`, `file_info`, `file_hash`, `read_file`;
- text/base64 writes, create/copy/move/delete paths;
- Hostinger -> PC and PC -> Hostinger file transfer without email;
- HTTPS downloads;
- CMD, PowerShell, Python, Git and general processes;
- local-process start/stop and Blender execution;
- desktop capture and URL opening;
- Unity status, refresh, capture, play/stop/pause, scene open/save, menu actions, Editor jobs and compile wait;
- transactional multi-action envelopes with rollback and optional Unity compile verification.

## Reliability and safety fixes in 1.7.0

- A durable Hostinger command ledger prevents a command from being executed again only because final-result delivery temporarily failed.
- If the app terminates while a command is in-flight and its outcome cannot be proven, Nexa reports the outcome as uncertain rather than automatically repeating a potentially destructive operation.
- Reusing a command UUID with different contents is rejected.
- Non-zero CMD/PowerShell/Python/Git/process exits fail the action by default instead of being reported as completed.
- Failed transactional jobs can return structured rollback details to Hostinger.
- File transfer uses chunking for larger PC -> Hostinger uploads.

Existing controls remain enforced:

- Bridge Enabled;
- Emergency Stop;
- individual Hostinger permissions;
- Full Computer Mode for high-control/shell/code actions;
- Allowed Folders with junction/symlink escape protection;
- transactional backups and rollback;
- Unity compile verification;
- local secret storage/redaction.

## Install once

Use `NEXA_AI_LOCAL_BRIDGE_V1_7_0_APP_BUILDER_READY.zip` in Nexa App Builder Pro and make one Windows build.

After installing the resulting Windows build:

1. Keep the existing Agent Endpoint and pairing token.
2. Keep the existing Allowed Folders and Unity Project Paths.
3. Connect to Hostinger.
4. The direct Hostinger queue begins polling automatically while connected.
5. The Email Remote Command Inbox can remain OFF unless you intentionally want the fallback transport.

The Unity integration version remains compatible with the current installed 1.6.2 plugin; this update does not require a Unity plugin rebuild solely for the new Hostinger transport.

## Validation

The source package passes the complete project validation chain:

- Node syntax checks for the Electron entry graph and services;
- Nexa App Builder delimiter/regex compatibility scan;
- delivery graph validation;
- project validation;
- baseline tests;
- implementation tests;
- acceptance tests.

The Windows EXE itself is produced by the existing Nexa App Builder/GitHub Windows build workflow after this source package is installed.
