<#
.SYNOPSIS
  Seed the LOCAL MySQL database with a copy of the LIVE database.

.DESCRIPTION
  Dumps the live database with mysqldump and loads the dump into the local
  `insurancedb`, so local development runs on realistic data instead of the
  demo accounts `npm run db:setup` creates.

  Connection details come from the server's .env file (an environment variable
  of the same name, when set, wins - handy for throw-away test databases):

    source (dump) : LIVE_DB_HOST LIVE_DB_PORT LIVE_DB_USER LIVE_DB_PASSWORD LIVE_DB_NAME
    target (load) : DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME

  Two ways in:

    * normal - connect to the live server (Hostinger only allows this after the
      client IP is whitelisted under hPanel -> Databases -> Remote MySQL);
    * -FromFile - use a .sql export downloaded from phpMyAdmin instead, which
      needs no whitelisting.

  After loading, transient/session tables are cleared (see -KeepSessions) and
  `db/setup.js` runs first so the target schema matches the server code.

.PARAMETER FromFile
  Import an existing .sql file instead of running mysqldump.

.PARAMETER SchemaOnly
  Dump the structure only, without any rows.

.PARAMETER DataOnly
  Dump rows only (`--no-create-info --skip-triggers`), keeping the local schema
  that `db/setup.js` created.

.PARAMETER Tables
  Dump only these tables (schema + rows, unless -DataOnly).

.PARAMETER NoImport
  Stop after the dump; the .sql file is left on disk.

.PARAMETER KeepSessions
  Do not empty the `tokens` table (live login tokens would then be valid
  locally until they expire).

.PARAMETER DryRun
  Print what would run, without running it.

.PARAMETER Force
  Allow importing into a database that is not on this machine.

.EXAMPLE
  npm run db:seed:live

.EXAMPLE
  npm run db:seed:file -- C:\Downloads\u174622325_InsuranceDB.sql

.EXAMPLE
  powershell -NoProfile -File db/seed-from-live.ps1 -Tables insurance,brokers -DataOnly
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$FromFile = "",
  [switch]$SchemaOnly,
  [switch]$DataOnly,
  [string[]]$Tables = @(),
  [switch]$NoImport,
  [switch]$KeepSessions,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $repoRoot ".env"

# ---------------------------------------------------------------------------
# .env parsing (a tiny reader: no dependency, tolerates the hand-edited file)
# ---------------------------------------------------------------------------
function Get-EnvMap {
  param([string]$Path)

  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed -eq "" -or $trimmed.StartsWith("#") -or $trimmed.StartsWith("//")) { continue }
    $m = [regex]::Match($trimmed, "^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
    if (-not $m.Success) { continue }
    $value = $m.Groups[2].Value.Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$m.Groups[1].Value] = $value
  }
  return $map
}

$envMap = Get-EnvMap -Path $envPath

# An environment variable beats .env, so tests can point at a scratch database.
function Get-Setting {
  param([string]$Name, [string]$Fallback = "")

  $fromEnv = [Environment]::GetEnvironmentVariable($Name)
  if ($fromEnv) { return $fromEnv }
  if ($envMap.ContainsKey($Name) -and $envMap[$Name]) { return $envMap[$Name] }
  return $Fallback
}

# ---------------------------------------------------------------------------
# MySQL client tools (PATH first, then the Windows install, then Program Files)
# ---------------------------------------------------------------------------
function Find-MySqlTool {
  param([string]$Name)

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($root in $roots) {
    $mysqlDir = Join-Path $root "MySQL"
    if (-not (Test-Path -LiteralPath $mysqlDir)) { continue }
    $found = Get-ChildItem -LiteralPath $mysqlDir -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "bin\$Name.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Sort-Object -Descending |
      Select-Object -First 1
    if ($found) { return $found }
  }
  throw "$Name.exe not found. Install MySQL 8 (or add its bin folder to PATH)."
}

# Windows PowerShell 5.1 turns anything a native tool writes to stderr into a
# terminating error while $ErrorActionPreference is "Stop". mysql/mysqldump use
# stderr for warnings, so run them with "Continue" and inspect the exit code.
function Invoke-Native {
  param([string]$FilePath, [string[]]$Arguments)

  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

# The MySQL 8 client queries information_schema.COLUMN_STATISTICS, which MariaDB
# (the shared-hosted live server) does not have. Disable it when supported.
function Test-MySqlDumpOption {
  param([string]$Tool, [string]$Option)

  $help = Invoke-Native $Tool @("--help")
  return [bool](($help.Output | Out-String) -match [regex]::Escape($Option))
}

# ---------------------------------------------------------------------------
# Resolve source (live) and target (local) connections
# ---------------------------------------------------------------------------
$liveName = Get-Setting "LIVE_DB_NAME"
$liveHost = Get-Setting "LIVE_DB_HOST"
$liveUser = Get-Setting "LIVE_DB_USER"
$livePass = Get-Setting "LIVE_DB_PASSWORD"
$livePort = Get-Setting "LIVE_DB_PORT"

# No LIVE_DB_* block yet? Treat DB_* as the source (e.g. a staging box).
if (-not $liveHost -or -not $liveName) {
  Write-Host "No LIVE_DB_* settings in .env; using DB_* as the source." -ForegroundColor Yellow
  $liveName = Get-Setting "DB_NAME" "insurancedb"
  $liveHost = Get-Setting "DB_HOST" "localhost"
  $liveUser = Get-Setting "DB_USER" "root"
  $livePass = Get-Setting "DB_PASSWORD"
  $livePort = Get-Setting "DB_PORT" "3306"
}

$targetName = Get-Setting "DB_NAME" "insurancedb"
$targetHost = Get-Setting "DB_HOST" "localhost"
$targetUser = Get-Setting "DB_USER" "root"
$targetPass = Get-Setting "DB_PASSWORD"
$targetPort = Get-Setting "DB_PORT" "3306"

foreach ($pair in @(
  @("LIVE_DB_NAME", $liveName), @("LIVE_DB_USER", $liveUser),
  @("LIVE_DB_PASSWORD", $livePass), @("DB_NAME", $targetName),
  @("DB_USER", $targetUser), @("DB_PASSWORD", $targetPass)
)) {
  if (-not $pair[1]) { throw "$($pair[0]) is not set in .env (or the environment)." }
}

$localHosts = @("localhost", "127.0.0.1", "::1", ".")
$targetIsLocal = $localHosts -contains $targetHost
$sameDatabase =
  ($liveHost -eq $targetHost) -and
  ("$livePort" -eq "$targetPort") -and
  ($liveName -eq $targetName)

if ($sameDatabase) {
  throw "Source and target are the same database ($liveHost`:$livePort/$liveName). Refusing to dump it into itself."
}
if (-not $targetIsLocal -and -not $Force) {
  throw "Target $targetHost`:$targetPort/$targetName is not local. Pass -Force if that is really intended."
}
if ($SchemaOnly -and $DataOnly) { throw "-SchemaOnly and -DataOnly are mutually exclusive." }

Write-Host "Source (live): $liveUser@$liveHost`:$livePort/$liveName"
Write-Host "Target (local): $targetUser@$targetHost`:$targetPort/$targetName"

# ---------------------------------------------------------------------------
# Dump file
# ---------------------------------------------------------------------------
$backupDir = Join-Path $repoRoot "backups"

if ($FromFile) {
  $resolved = Resolve-Path -LiteralPath $FromFile -ErrorAction SilentlyContinue
  if (-not $resolved) { throw "Dump file not found: $FromFile" }
  $dumpFile = $resolved.Path
} else {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $dumpFile = Join-Path $backupDir "$liveName-$stamp.sql"
}

$dumpArgs = @(
  "--no-tablespaces",
  "--single-transaction",
  "--quick",
  "--skip-lock-tables",
  "--set-gtid-purged=OFF",
  "--default-character-set=utf8mb4",
  "--result-file=$dumpFile"
)
if ($SchemaOnly) { $dumpArgs += "--no-data" }
if ($DataOnly) { $dumpArgs += @("--no-create-info", "--skip-triggers") }
$dumpArgs += $liveName
if ($Tables.Count -gt 0) { $dumpArgs += $Tables }

# ---------------------------------------------------------------------------
# Temporary option files - keeps the passwords out of the process arguments
# ---------------------------------------------------------------------------
$tempFiles = @()

function New-OptionFile {
  param([string]$Prefix, [string]$HostName, [string]$Port, [string]$UserName, [string]$Password)

  $path = Join-Path $env:TEMP "$Prefix-$([guid]::NewGuid().ToString('N')).cnf"
  $content = "[client]`r`nhost=$HostName`r`nport=$Port`r`nuser=$UserName`r`npassword=$Password`r`n"
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
  $script:tempFiles += $path
  return $path
}


# ---------------------------------------------------------------------------
# Dump, import, scrub
# ---------------------------------------------------------------------------
$mysql = $null
$mysqldump = $null

try {
  # ---- 1) dump ----------------------------------------------------------
  if (-not $FromFile) {
    $mysqldump = Find-MySqlTool "mysqldump"

    $dumpColumnsStatistics = Test-MySqlDumpOption $mysqldump "--column-statistics"
    if ($dumpColumnsStatistics) {
      $dumpArgs = @("--column-statistics=0") + $dumpArgs
    }

    if ($DryRun) {
      Write-Host "DRY RUN: $mysqldump $($dumpArgs -join ' ')"
    } else {
      New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
      $sourceCnf = New-OptionFile "seed-source" $liveHost $livePort $liveUser $livePass

      Write-Host "Dumping $liveName to $dumpFile ..."
      $dumpResult = Invoke-Native $mysqldump (@("--defaults-extra-file=$sourceCnf") + $dumpArgs)
      $dumpCode = $dumpResult.ExitCode

      if ($dumpCode -ne 0) {
        # Shared hosting often lacks PROCESS/RELOAD, and an older server may
        # reject --set-gtid-purged / --no-tablespaces. Retry with the minimum.
        Write-Warning "mysqldump failed (exit $dumpCode); retrying with minimal flags."
        Write-Host ($dumpResult.Output | Out-String)

        $minimal = @(
          "--defaults-extra-file=$sourceCnf",
          "--single-transaction",
          "--quick",
          "--default-character-set=utf8mb4",
          "--result-file=$dumpFile"
        )
        if ($dumpColumnsStatistics) { $minimal += "--column-statistics=0" }
        if ($SchemaOnly) { $minimal += "--no-data" }
        if ($DataOnly) { $minimal += @("--no-create-info", "--skip-triggers") }
        $minimal += $liveName
        if ($Tables.Count -gt 0) { $minimal += $Tables }

        $dumpResult = Invoke-Native $mysqldump $minimal
        $dumpCode = $dumpResult.ExitCode
        if ($dumpCode -ne 0) {
          throw ("mysqldump failed (exit $dumpCode).`n" + ($dumpResult.Output | Out-String))
        }
      }

      $size = (Get-Item -LiteralPath $dumpFile).Length
      Write-Host ("Dump written: {0:N0} bytes" -f $size) -ForegroundColor Green
      if ($size -lt 1024) { Write-Warning "The dump is suspiciously small; open it and check for errors." }
    }
  } else {
    Write-Host "Using existing dump: $dumpFile"
  }

  if ($NoImport) {
    Write-Host "Skipping import (-NoImport)."
    return
  }

  # ---- 2) schema, then import -------------------------------------------
  $mysql = Find-MySqlTool "mysql"

  if ($DryRun) {
    Write-Host "DRY RUN: node --env-file=.env db/setup.js"
    Write-Host "DRY RUN: mysql <target> -e `"source $($dumpFile -replace '\\', '/')`""
    return
  }

  $targetCnf = New-OptionFile "seed-target" $targetHost $targetPort $targetUser $targetPass

  # setup.js creates the database when it is missing and brings its schema up to
  # what the server code expects; the dump then drops and refills those tables.
  Write-Host "Ensuring $targetName exists and its schema is current ..."
  Push-Location $repoRoot
  try {
    $setupResult = Invoke-Native "node" @("--env-file=.env", "db/setup.js")
    $setupResult.Output | Out-Host
    if ($setupResult.ExitCode -ne 0) { throw "db/setup.js failed (exit $($setupResult.ExitCode))." }
  } finally {
    Pop-Location
  }

  # `source` takes a file name; copy space-y paths to TEMP and use forward slashes.
  $importPath = $dumpFile
  if ($importPath -match "\s") {
    $importPath = Join-Path $env:TEMP "seed-import-$([guid]::NewGuid().ToString('N')).sql"
    Copy-Item -LiteralPath $dumpFile -Destination $importPath
    $script:tempFiles += $importPath
  }
  $sourceSql = "source " + ($importPath -replace "\\", "/")

  Write-Host "Importing into $targetName ..."
  $importResult = Invoke-Native $mysql @(
    "--defaults-extra-file=$targetCnf",
    "--default-character-set=utf8mb4",
    "--init-command=SET FOREIGN_KEY_CHECKS=0",
    $targetName,
    "-e", $sourceSql
  )
  if ($importResult.ExitCode -ne 0) {
    throw ("Import failed (exit $($importResult.ExitCode)).`n" + ($importResult.Output | Out-String))
  }
  Write-Host "Import finished." -ForegroundColor Green

  # ---- 3) scrub session / outbound-mail state ---------------------------
  $scrub = @()
  if (-not $KeepSessions) {
    $scrub += "TRUNCATE TABLE tokens"
  }
  # A pending reply copied from live would be re-sent to a real customer by the
  # local server, and copied billing state would back-bill when billing is on.
  $scrub += "DELETE FROM email_outbox"
  $scrub += "DELETE FROM app_settings WHERE name LIKE 'billing%'"

  if ($scrub.Count -gt 0) {
    $scrubSql = ($scrub -join "; ") + ";"
    $scrubResult = Invoke-Native $mysql @(
      "--defaults-extra-file=$targetCnf",
      "--force",
      "--default-character-set=utf8mb4",
      $targetName,
      "-e", $scrubSql
    )
    $scrubResult.Output | Out-Host
    Write-Host "Cleared session/outbound-mail state." -ForegroundColor Green
  }

  # ---- 4) verify --------------------------------------------------------
  $countSql = @"
SELECT 'insurance' AS tbl, COUNT(*) AS rows_ FROM insurance
UNION ALL SELECT 'brokers', COUNT(*) FROM brokers
UNION ALL SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'cash_transactions', COUNT(*) FROM cash_transactions
UNION ALL SELECT 'broker_balance_movements', COUNT(*) FROM broker_balance_movements
UNION ALL SELECT 'tokens', COUNT(*) FROM tokens
UNION ALL SELECT 'email_outbox', COUNT(*) FROM email_outbox
"@
  Write-Host "Row counts in $targetName`:"
  $countResult = Invoke-Native $mysql @(
    "--defaults-extra-file=$targetCnf",
    "--table",
    $targetName,
    "-e", $countSql
  )
  $countResult.Output | Out-Host
} finally {
  foreach ($file in $tempFiles) {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

