# Nexa AI Local Bridge 1.4.0

Windows companion for Nexa AI Computer Bridge.

## 1.4.0

Adds **GitHub Remote Workspace** on top of the working Hostinger + Unity mirror.

The authorized Unity project can now be published to a dedicated GitHub branch so a connected ChatGPT Plus GitHub connector can inspect the project directly. Optional write-back can apply approved remote text edits into the local Unity project.

### GitHub mirror includes

- C# scripts
- `.unity` scenes
- prefabs
- shaders / HLSL / shader graphs
- materials
- JSON / YAML / XML / ProjectSettings / Packages
- Unity Editor log and compile status
- Play Mode state
- project structure and binary-asset metadata
- Scene View and Game View PNG captures when Screenshots permission is enabled

### Write-back safety

- GitHub token is encrypted with Electron `safeStorage` and stays on the PC.
- Remote write-back requires both the local **Apply ChatGPT edits back to Unity** toggle and Hostinger **Write Files** permission.
- Writes are restricted to configured Unity project roots inside Allowed Folders.
- Only approved Unity text formats are written automatically.
- Local-vs-remote conflicts are never overwritten automatically.
- Remote file deletions are ignored by design.
- Generated `__NEXA__` data and `.nexa-bridge` files are never written back into the project from GitHub.

### Recommended GitHub target

- Repository: `somosanimales239-cmd/Nexa-AI-Local-Bridge`
- Workspace branch: `nexa-unity-workspace`
- Fine-grained token permission: **Contents: Read and write** for the selected repository.

The Hostinger mirror remains available and continues using the same pairing token and endpoint.
