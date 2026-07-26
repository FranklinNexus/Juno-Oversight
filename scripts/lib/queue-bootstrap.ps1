$script:JunoQueueWriter = Join-Path (Split-Path -Parent $PSScriptRoot) "write-queue.mjs"

function Submit-JunoQueueCandidate {
  param(
    [Parameter(Mandatory = $true)][string]$Workbench,
    [Parameter(Mandatory = $true)][string]$Yaml,
    [string]$BackupPrefix,
    [switch]$IfMissing
  )

  $candidatePath = Join-Path ([System.IO.Path]::GetTempPath()) ("juno-queue-{0}.yaml" -f [guid]::NewGuid().ToString("N"))
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  try {
    [System.IO.File]::WriteAllText($candidatePath, $Yaml, $utf8NoBom)
    $nodeArgs = @(
      $script:JunoQueueWriter,
      "--yaml", $candidatePath,
      "--out", (Join-Path $Workbench "queue/now.yaml")
    )
    if ($BackupPrefix) { $nodeArgs += @("--backup-prefix", $BackupPrefix) }
    if ($IfMissing) { $nodeArgs += "--if-missing" }
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Strict queue submission failed with exit code $LASTEXITCODE"
    }
  } finally {
    Remove-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue
  }
}
