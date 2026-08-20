# Nexa AI Local Bridge 1.2.0

Windows companion for Nexa AI Computer Bridge on Hostinger.

## Runtime

- Outbound HTTPS pairing to `api/agent.php`.
- Encrypted pairing token through Electron `safeStorage`.
- Heartbeat every 20 seconds with PC, Windows, local IPv4 and GPU information.
- Hostinger policy synchronization for Bridge Enabled, Emergency Stop, Full Computer Mode and per-capability permissions.
- Read-only Hostinger command queue support for computer status, drives, directory listings, text-file reads, process inventory, GPU status and CUDA status.
- Local Allowed Folders policy for file-system reads.
- System tray, reconnect, auto-connect and optional Start with Windows.

## Nexa App Builder Pro delivery contract

Version 1.2.0 is packaged for the Windows target expected by Nexa App Builder Pro:

- NSIS Installer
- Portable EXE
- Windows ZIP
- ASAR enabled
- delivery validator
- project validator
- baseline tests
- implementation tests
- acceptance tests
- Electron UI smoke test

The included Windows workflow is copied from the current Nexa App Builder Pro Windows workflow template so the project and the control panel use the same delivery contract.
