# Local Overleaf CE for development

```sh
echo "OLR_DEV_INVITE_TOKEN_SECRET=$(openssl rand -base64 32)" > dev/overleaf-ce/.env   # once
docker compose -f dev/overleaf-ce/compose.yml up -d
```

Then open http://localhost:8090/launchpad to create the first admin (the e2e setup does this itself).
Port: `OLR_DEV_PORT`. Image: `OLR_DEV_OVERLEAF_IMAGE` (default `sharelatex/sharelatex:latest`).
`docker compose -f dev/overleaf-ce/compose.yml down` stops it; adding `-v` **deletes all its data**.
