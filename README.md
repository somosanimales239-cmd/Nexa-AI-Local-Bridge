# Nexa AI Local Bridge 1.2.2


## 1.2.2 Windows DNS resilience fix

- Replaces the Electron/Node `fetch()` bridge transport with deterministic native HTTP/1.1 requests.
- Forces IPv4 for production HTTPS endpoints to match the Windows connectivity path validated with `curl.exe --http1.1`.
- Uses `Connection: close` and disables connection reuse for Hostinger CDN compatibility.
- Raises heartbeat/queue timeouts from 9 seconds to 20 seconds (25 seconds for command result submission).
- Reports DNS, reset, refused, timeout, and TLS failures separately instead of a generic timeout.


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

Version 1.2.2 is packaged for the Windows target expected by Nexa App Builder Pro:

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
