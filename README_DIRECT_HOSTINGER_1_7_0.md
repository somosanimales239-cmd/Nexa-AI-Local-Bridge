# Nexa AI Local Bridge 1.7.0 — Direct Hostinger Control

This release makes the existing Hostinger command queue the **primary** remote-control transport. Email remains optional fallback only.

## Primary path

ChatGPT / browser client -> Nexa AI Computer Bridge on Hostinger -> outbound polling by Nexa AI Local Bridge -> authorized Windows PC -> result back to Hostinger.

## Added/finished in 1.7.0

- Full Hostinger queue accepts the existing file, shell, process and Unity executor actions.
- `find_files` / `find_file`, `file_info`, `file_hash`.
- `unity_status` plus the existing Unity refresh/play/stop/pause/capture/editor-job/compile actions.
- Hostinger Bridge file transfer without email:
  - `download_bridge_asset` puts a web-uploaded file into an Allowed Folder.
  - `upload_bridge_file` uploads a PC file back to Hostinger.
  - PC -> Hostinger uploads automatically use 3 MiB chunks for larger files.
- `capture_desktop` and `open_url` under the appropriate Hostinger permissions and Full Computer Mode.
- Shell/process actions now treat a non-zero exit code as an actual failed action by default. Use `allow_nonzero_exit: true` only when a non-zero exit is intentionally acceptable.
- A durable command ledger prevents temporary Hostinger result-delivery failures from re-running the same file/process command. Interrupted/uncertain commands are stopped rather than blindly repeated.
- Transactional `remote_envelope` allows up to 50 actions in one job and preserves rollback / Unity compile verification.
- Existing Allowed Folders, symlink/junction protection, per-capability Hostinger permissions, Full Computer Mode, Emergency Stop, safeStorage, Unity integration, diagnostics, GitHub mirror, DKIM email fallback and redaction remain intact.

## One build

Use the complete `NEXA_AI_LOCAL_BRIDGE_V1_7_0_APP_BUILDER_READY.zip` in Nexa App Builder Pro and build Windows once.

After installing, keep the existing Agent Endpoint, pairing token, Allowed Folders and Unity Project Paths. The local app already polls Hostinger's `commands.php` endpoint; no command mailbox is required for the primary path.
