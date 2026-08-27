# Nexora Server (persistent storage)

## Run locally
```bash
cd nexora_server
node server.js
```

## Data
All data is saved in `data/db.json` (atomic write).

- merchants (shops)
- products (with shop_id, sold_out, image_uri / image_uris)
- orders + status
- shop_meta (logo_uri, banner_uri, rating)

## Important for Render
Free Render disk can reset on redeploy. For production use a paid persistent disk
or MongoDB/Postgres. Local / VPS keeps `data/db.json` forever.

## API key
Must match both Android apps `Config.API_KEY`:
`TTRHsRQivU8HkpF2X5wHdqKw8-10TSpQ`
