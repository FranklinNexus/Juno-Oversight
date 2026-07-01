# Activate Node 22 for Juno Overseer / Cursor SDK orchestrator.
nvm use 22.13.1
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing Node 22.13.1..."
  nvm install 22.13.1
  nvm use 22.13.1
}
corepack enable 2>$null
corepack prepare pnpm@10.13.1 --activate 2>$null
node -v
pnpm -v
