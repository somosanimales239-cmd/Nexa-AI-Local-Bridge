# Nexa AI Local Bridge 1.3.0

Windows companion for Nexa AI Computer Bridge on Hostinger.

## Remote Unity Workspace

Version 1.3.0 adds an explicitly authorized Unity project mirror so a secret public Hostinger URL can be inspected from a ChatGPT Plus conversation without MCP.

Mirrored information includes:
- complete relevant Unity project structure (Assets, Packages, ProjectSettings and other project files; cache folders such as Library/Temp are excluded)
- C# scripts
- .unity scenes
- prefabs
- shaders / shader graphs / HLSL / compute shaders
- materials
- JSON, YAML, XML, asmdef, input actions and project settings
- Unity Editor log tail
- compilation errors
- Play Mode / compilation / active-scene state
- Scene View and Game View PNG captures through the optional Nexa Unity Editor integration
- metadata for binary assets such as textures, audio and 3D models

## Security
- outbound HTTPS only
- pairing token stays encrypted through Electron safeStorage
- Unity Project Paths must also be inside local Allowed Folders
- Hostinger Read Files permission is required for workspace sync
- Hostinger Screenshots permission is required to upload visual captures
- public workspace is a mirror, not unrestricted C:/D:/ access
- Emergency Stop blocks workspace uploads

## Workflow
1. Connect to Hostinger.
2. Add Allowed Folders.
3. Add one or more Unity Project Paths.
4. Enable Remote Unity Workspace sync.
5. For visual captures, enable Screenshots on Hostinger and click Install Unity Integration.
6. Keep Unity open and let the new Editor script compile.
7. Click Capture Unity Views and then Sync Now, or enable automatic captures/sync.
8. Generate the secret public workspace link from the Hostinger dashboard and share that exact URL with ChatGPT.
