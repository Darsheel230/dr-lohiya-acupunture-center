## Railway Deploy Steps

1. Create a new Railway project and deploy this folder or connect its GitHub repo.
2. In the service settings, keep the start command as `npm start`.
3. Add a volume and mount it to `/app/data`.
4. Add these environment variables:
   - `DATA_DIR=/app/data`
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD=<your-strong-password>`
5. Open `Networking -> Public Networking` and click `Generate Domain`.
6. Test the public URL for:
   - `/`
   - `/admin`
   - `/health`
7. If you want a branded domain, add a custom domain after the Railway domain is working.
8. Enable volume backups from the volume settings.

Notes:
- The app already listens on the host port automatically.
- The appointments database will be stored inside the mounted volume.
- Without a volume, SQLite data will be lost on redeploy or restart.
- The admin page is password-protected only when `ADMIN_PASSWORD` is set.
