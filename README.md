# Nexa AI Local Bridge v1.1.0

Windows-side companion for **Nexa AI Computer Bridge Hostinger v2**.

## v1.1.0

- Keeps the real HTTPS heartbeat/pairing connection from v1.0.0.
- Reads the command endpoint advertised by Hostinger.
- Polls the real Hostinger Command Queue every 5 seconds while connected.
- Executes only the phase-1 read-only action allowlist.
- Returns structured results/errors to Hostinger.
- Adds local **Allowed Folders**. `list_directory` and `read_file` cannot leave these roots.
- Adds a local Current Hostinger Command panel.
- Preserves Emergency Stop, Bridge Enabled and Read Files policy gates.
- Does not add arbitrary CMD, PowerShell, Python or file-writing execution.

## Phase-1 commands

- `computer_status`
- `list_drives`
- `list_directory`
- `read_file` (text only, max 256 KiB)
- `get_processes`
- `get_gpu_status`
- `get_cuda_status`

## First end-to-end test

1. Update Hostinger with `NEXA_AI_COMPUTER_BRIDGE_HOSTINGER_V2.zip`.
2. Build/install this v1.1.0 project.
3. Pair it to your existing Hostinger Agent Endpoint/token.
4. Add `D:\\N3D` (or another test folder) to Allowed Folders and save local security.
5. In Hostinger enable Read Files.
6. Queue `list_directory` for the same folder.
7. The result should return to the Hostinger Commands panel.
