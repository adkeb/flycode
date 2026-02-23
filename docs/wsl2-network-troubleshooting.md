# WSL2 Network Troubleshooting

## Symptom: extension cannot connect to `127.0.0.1:39393`

1. Confirm service is running in WSL2:

```bash
ss -lntp | rg 39393
```

2. Confirm service binds to localhost only:

Expected listener address is `127.0.0.1:39393`.

3. Verify Windows browser can reach it:
- Open `http://127.0.0.1:39393/v1/health` in Windows browser.
- If it fails, restart WSL:

```powershell
wsl --shutdown
```

Then start service again.

4. Check Windows firewall or local security software rules.

5. If you customized port, update extension options `Local Service URL`.

## Symptom: path not allowed

- Ensure your target file path is inside `allowed_roots` in `~/.flycode/policy.yaml`.
- For Windows paths, service auto-maps `C:\...` to `/mnt/c/...`.

## Symptom: writes always require confirmation

- Policy key `write.require_confirmation_default` controls default behavior.
- Extension key `confirmWritesEnabled` can disable confirmation only if policy allows (`write.allow_disable_confirmation: true`).
