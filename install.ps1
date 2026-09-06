#requires -Version 7.0
<#
.SYNOPSIS
    Instalator Worker Board - buduje rozszerzenie VS Code z tego repozytorium,
    instaluje je w dostepnych edycjach VS Code i wdraza dwie zaleznosci zyjace
    poza repozytorium (wrapper worker-run.ps1 i skill external-workers) do
    ~/.claude/.

.OPIS
    Idempotentny, nieniszczacy. Mozna go uruchomic wielokrotnie - powtorne
    uruchomienie z identycznym stanem repozytorium i ~/.claude/ nie robi nic
    poza ponownym zbudowaniem i przeinstalowaniem rozszerzenia (uninstall +
    install jest zawsze wykonywany, bo VS Code potrafi zachowac stara kopie
    przy niezmienionym numerze wersji).

.PARAMETER SkipBuild
    Pomija npm ci/install, npm run build i vsce package. Uzywa najnowszego
    (wg czasu modyfikacji) pliku *.vsix znalezionego w katalogu repozytorium.

.PARAMETER DryRun
    Wykonuje wylacznie kontrole wymagan i odczyt stanu plikow docelowych.
    Wypisuje, co zostaloby zrobione w krokach B/C/D, ale niczego nie zmienia
    na dysku - zaden plik nie jest budowany, kopiowany ani nadpisywany, zadne
    rozszerzenie nie jest instalowane/odinstalowywane.

.PRZYKLADY
    pwsh -File install.ps1
    pwsh -File install.ps1 -DryRun
    pwsh -File install.ps1 -SkipBuild
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Sciezki bazowe -------------------------------------------------------------
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$DeployDir = Join-Path $RepoRoot 'deploy\claude'
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Text)
    Write-Host "  -> $Text"
}

function Write-Planned {
    param([string]$Text)
    Write-Host "  [DryRun] $Text" -ForegroundColor DarkYellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host "BLAD: $Text" -ForegroundColor Red
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
        throw "Nie znaleziono package.json w '$RepoRoot'. Uruchamiasz skrypt z wlasciwego katalogu repozytorium?"
    }
    $pkgJson = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    $ExtensionId = "$($pkgJson.publisher).$($pkgJson.name)"
    $expectedVsixName = "$($pkgJson.name)-$($pkgJson.version).vsix"

    Write-Host "Worker Board - instalator" -ForegroundColor Green
    Write-Host "Repozytorium: $RepoRoot"
    Write-Host "Wersja w package.json: $($pkgJson.version)  (identyfikator rozszerzenia: $ExtensionId)"
    if ($DryRun) {
        Write-Host "Tryb: -DryRun (nic nie zostanie zmienione na dysku)" -ForegroundColor Yellow
    }

    # =============================================================================
    # A. Kontrola wymagan wstepnych
    # =============================================================================
    Write-Section 'A. Kontrola wymagan wstepnych'

    $requirements = [System.Collections.Generic.List[object]]::new()
    $hardMissing = [System.Collections.Generic.List[string]]::new()
    $softWarnings = [System.Collections.Generic.List[string]]::new()

    function Add-Requirement {
        param([string]$Name, [string]$Type, [bool]$Ok, [string]$Details)
        $requirements.Add([pscustomobject]@{
            Wymaganie = $Name
            Typ       = $Type
            Status    = if ($Ok) { 'OK' } else { 'BRAK' }
            Szczegoly = $Details
        })
    }

    # --- Node.js (twarde, >= 20) ---
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeVerRaw = (& node --version).Trim()
        if ($nodeVerRaw -match '^v(\d+)\.') {
            $nodeMajor = [int]$Matches[1]
            $nodeOk = $nodeMajor -ge 20
            Add-Requirement 'Node.js (>= 20)' 'Twarde' $nodeOk "znaleziono $nodeVerRaw"
            if (-not $nodeOk) {
                $hardMissing.Add("Node.js $nodeVerRaw jest za stary (wymagane >= 20).")
            }
        }
        else {
            Add-Requirement 'Node.js (>= 20)' 'Twarde' $false "nie udalo sie rozpoznac wersji z '$nodeVerRaw'"
            $hardMissing.Add("Nie udalo sie rozpoznac wersji Node.js z wyjscia '$nodeVerRaw'.")
        }
    }
    else {
        Add-Requirement 'Node.js (>= 20)' 'Twarde' $false 'nie znaleziono w PATH'
        $hardMissing.Add('Nie znaleziono node w PATH.')
    }

    # --- npm (twarde) ---
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        $npmVerRaw = (& npm --version).Trim()
        Add-Requirement 'npm' 'Twarde' $true "znaleziono $npmVerRaw"
    }
    else {
        Add-Requirement 'npm' 'Twarde' $false 'nie znaleziono w PATH'
        $hardMissing.Add('Nie znaleziono npm w PATH.')
    }

    # --- CLI VS Code: co najmniej jedno z code / code-insiders (twarde) ---
    $codeCmd = Get-Command code -ErrorAction SilentlyContinue
    $codeInsidersCmd = Get-Command code-insiders -ErrorAction SilentlyContinue
    $vsCodeEditionNames = [System.Collections.Generic.List[string]]::new()
    if ($codeCmd) { $vsCodeEditionNames.Add('code') }
    if ($codeInsidersCmd) { $vsCodeEditionNames.Add('code-insiders') }
    $hasAnyVsCode = $vsCodeEditionNames.Count -gt 0
    Add-Requirement 'CLI VS Code (code lub code-insiders)' 'Twarde' $hasAnyVsCode $(
        if ($hasAnyVsCode) { "znaleziono: $($vsCodeEditionNames -join ', ')" } else { 'nie znaleziono zadnego' }
    )
    if (-not $hasAnyVsCode) {
        $hardMissing.Add("Brak CLI 'code' i 'code-insiders' w PATH - nie da sie zainstalowac rozszerzenia.")
    }

    # --- WSL Ubuntu + muse, potrzebne tylko dla Sparka (miekkie) ---
    $wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
    $museFound = $false
    $museDetail = ''
    if ($wslCmd) {
        $distros = @()
        try {
            $distros = (wsl.exe -l -q 2>$null) | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ }
        }
        catch {
            $distros = @()
        }
        if ($distros -contains 'Ubuntu') {
            try {
                $museCheck = (wsl.exe -d Ubuntu -- bash -lc 'command -v muse' 2>$null)
                if ($LASTEXITCODE -eq 0 -and $museCheck) {
                    $museFound = $true
                    $museDetail = "znaleziono: $($museCheck.Trim())"
                }
                else {
                    $museDetail = "WSL Ubuntu jest, ale brak polecenia 'muse' w niej"
                }
            }
            catch {
                $museDetail = "nie udalo sie sprawdzic polecenia 'muse' w WSL Ubuntu"
            }
        }
        else {
            $museDetail = "brak dystrybucji WSL 'Ubuntu' (dostepne: $(if ($distros.Count -gt 0) { $distros -join ', ' } else { 'brak' }))"
        }
    }
    else {
        $museDetail = 'nie znaleziono wsl.exe w PATH'
    }
    Add-Requirement 'WSL Ubuntu + muse (Spark)' 'Miekkie' $museFound $museDetail
    if (-not $museFound) {
        $softWarnings.Add("nie znaleziono 'muse' w WSL Ubuntu: workery Spark nie beda dzialac, reszta panelu tak.")
    }

    # --- codex w PATH, potrzebne tylko dla Codexa (miekkie) ---
    $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
    Add-Requirement 'codex w PATH (Codex)' 'Miekkie' ([bool]$codexCmd) $(
        if ($codexCmd) { "znaleziono: $($codexCmd.Source)" } else { 'nie znaleziono w PATH' }
    )
    if (-not $codexCmd) {
        $softWarnings.Add("nie znaleziono 'codex' w PATH: workery Codex nie beda dzialac, reszta panelu tak.")
    }

    $requirements | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

    foreach ($w in $softWarnings) {
        Write-Host "OSTRZEZENIE: $w" -ForegroundColor Yellow
    }

    if ($hardMissing.Count -gt 0) {
        Write-Host ''
        Write-Fail 'brakuje twardych wymagan, przerywam:'
        foreach ($m in $hardMissing) { Write-Host "  - $m" -ForegroundColor Red }
        exit 1
    }

    # =============================================================================
    # B. Budowa pakietu
    # =============================================================================
    Write-Section 'B. Budowa pakietu'

    $vsixPath = $null

    if ($SkipBuild) {
        $existingVsix = Get-ChildItem -LiteralPath $RepoRoot -Filter '*.vsix' -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if (-not $existingVsix) {
            Write-Fail "-SkipBuild podano, ale w '$RepoRoot' nie ma zadnego pliku .vsix."
            exit 1
        }
        $vsixPath = $existingVsix.FullName
        Write-Step "Pomijam budowe (-SkipBuild). Uzywam najnowszego pakietu: $($existingVsix.Name) (zmodyfikowany $($existingVsix.LastWriteTime))"
    }
    elseif ($DryRun) {
        $hasLock = Test-Path -LiteralPath (Join-Path $RepoRoot 'package-lock.json')
        Write-Planned $(if ($hasLock) { 'npm ci' } else { 'npm install (brak package-lock.json)' })
        Write-Planned 'npm run build'
        Write-Planned "npx @vscode/vsce package  (oczekiwany plik: $expectedVsixName)"
        $vsixPath = Join-Path $RepoRoot $expectedVsixName
    }
    else {
        Push-Location $RepoRoot
        try {
            if (Test-Path -LiteralPath (Join-Path $RepoRoot 'package-lock.json')) {
                Write-Step 'npm ci'
                npm ci
                if ($LASTEXITCODE -ne 0) { throw "npm ci zakonczyl sie kodem $LASTEXITCODE." }
            }
            else {
                Write-Step 'npm install (brak package-lock.json)'
                npm install
                if ($LASTEXITCODE -ne 0) { throw "npm install zakonczyl sie kodem $LASTEXITCODE." }
            }

            Write-Step 'npm run build'
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build zakonczyl sie kodem $LASTEXITCODE." }

            # Manifest ma juz komplet pol (repository, license, plik LICENSE), wiec vsce
            # pakuje bez pytan interaktywnych - flagi obejscia nie sa juz potrzebne.
            Write-Step 'npx @vscode/vsce package'
            npx @vscode/vsce package
            if ($LASTEXITCODE -ne 0) { throw "vsce package zakonczyl sie kodem $LASTEXITCODE." }
        }
        finally {
            Pop-Location
        }

        $vsixFull = Join-Path $RepoRoot $expectedVsixName
        if (-not (Test-Path -LiteralPath $vsixFull)) {
            throw "Po 'vsce package' oczekiwano pliku '$expectedVsixName' w '$RepoRoot', ale go nie ma. Sprawdz name/version w package.json."
        }
        $vsixPath = $vsixFull
        Write-Step "Zbudowano: $expectedVsixName"
    }

    # =============================================================================
    # C. Instalacja rozszerzenia
    # =============================================================================
    Write-Section 'C. Instalacja rozszerzenia'

    $editions = [System.Collections.Generic.List[object]]::new()
    if ($codeCmd) { $editions.Add([pscustomobject]@{ Cli = 'code'; Label = 'VS Code' }) }
    if ($codeInsidersCmd) { $editions.Add([pscustomobject]@{ Cli = 'code-insiders'; Label = 'VS Code Insiders' }) }

    $installedEditions = [System.Collections.Generic.List[string]]::new()

    foreach ($ed in $editions) {
        if ($DryRun) {
            Write-Planned "$($ed.Label): $($ed.Cli) --uninstall-extension $ExtensionId (blad ignorowany, gdy nie bylo zainstalowane)"
            Write-Planned "$($ed.Label): $($ed.Cli) --install-extension `"$vsixPath`" --force"
            $installedEditions.Add($ed.Label)
            continue
        }

        Write-Step "$($ed.Label): odinstalowanie poprzedniej wersji (jesli byla)"
        & $ed.Cli --uninstall-extension $ExtensionId *> $null

        Write-Step "$($ed.Label): instalacja $(Split-Path -Leaf $vsixPath)"
        & $ed.Cli --install-extension $vsixPath --force
        if ($LASTEXITCODE -ne 0) {
            throw "Instalacja rozszerzenia w $($ed.Label) zakonczyla sie kodem $LASTEXITCODE."
        }
        $installedEditions.Add($ed.Label)
    }

    # =============================================================================
    # D. Wdrozenie zaleznosci do ~/.claude/
    # =============================================================================
    Write-Section "D. Wdrozenie zaleznosci do $ClaudeHome"

    $claudeDirs = @(
        (Join-Path $ClaudeHome 'bin'),
        (Join-Path $ClaudeHome 'skills\external-workers'),
        (Join-Path $ClaudeHome 'worker-status'),
        (Join-Path $ClaudeHome 'worker-status\logs')
    )
    foreach ($dir in $claudeDirs) {
        if (Test-Path -LiteralPath $dir) { continue }
        if ($DryRun) {
            Write-Planned "utworzenie katalogu: $dir"
        }
        else {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            Write-Step "utworzono katalog: $dir"
        }
    }

    $deployMap = @(
        [pscustomobject]@{
            Label  = 'worker-run.ps1'
            Source = Join-Path $DeployDir 'bin\worker-run.ps1'
            Dest   = Join-Path $ClaudeHome 'bin\worker-run.ps1'
        },
        [pscustomobject]@{
            Label  = 'SKILL.md (external-workers)'
            Source = Join-Path $DeployDir 'skills\external-workers\SKILL.md'
            Dest   = Join-Path $ClaudeHome 'skills\external-workers\SKILL.md'
        }
    )

    $backups = [System.Collections.Generic.List[string]]::new()
    $deployedPaths = [System.Collections.Generic.List[string]]::new()

    foreach ($item in $deployMap) {
        $src = $item.Source
        $dst = $item.Dest
        $label = $item.Label

        if (-not (Test-Path -LiteralPath $src)) {
            throw "Brak pliku zrodlowego w repozytorium: $src"
        }

        if (-not (Test-Path -LiteralPath $dst)) {
            if ($DryRun) {
                Write-Planned "$label : brak pliku docelowego -> skopiuje z repo do $dst"
            }
            else {
                Copy-Item -LiteralPath $src -Destination $dst -Force
                Write-Step "$label : utworzono $dst"
            }
            $deployedPaths.Add($dst)
            continue
        }

        $srcHash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash

        if ($srcHash -eq $dstHash) {
            Write-Step "$label : bez zmian"
            $deployedPaths.Add($dst)
            continue
        }

        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupPath = "$dst.backup-$timestamp"

        if ($DryRun) {
            Write-Planned "$label : plik docelowy rozni sie od repozytorium -> kopia zapasowa $backupPath, potem nadpisanie wersja z repo"
        }
        else {
            Copy-Item -LiteralPath $dst -Destination $backupPath -Force
            Copy-Item -LiteralPath $src -Destination $dst -Force
            Write-Step "$label : plik docelowy rozni sie od repozytorium. Zarchiwizowano do $backupPath, nadpisano wersja z repo."
            $backups.Add($backupPath)
        }
        $deployedPaths.Add($dst)
    }

    # =============================================================================
    # E. Podsumowanie
    # =============================================================================
    Write-Section 'E. Podsumowanie'

    if ($DryRun) {
        Write-Host 'Tryb -DryRun: nic nie zostalo zmienione na dysku. Powyzsza lista to plan dzialan.'
    }
    else {
        Write-Host "Zainstalowana wersja: $($pkgJson.version)  (identyfikator rozszerzenia: $ExtensionId)"
        Write-Host "Edycje VS Code: $(if ($installedEditions.Count -gt 0) { $installedEditions -join ', ' } else { 'brak' })"
        Write-Host 'Wdrozone pliki:'
        foreach ($p in $deployedPaths) { Write-Host "  - $p" }
        if ($backups.Count -gt 0) {
            Write-Host 'Utworzone kopie zapasowe:'
            foreach ($b in $backups) { Write-Host "  - $b" }
        }
        else {
            Write-Host 'Kopie zapasowe: brak (pliki docelowe byly identyczne z repozytorium albo nie istnialy wczesniej)'
        }
        Write-Host ''
        Write-Host 'NASTEPNY KROK:' -ForegroundColor Yellow
        Write-Host '  1. W VS Code: Ctrl+Shift+P -> "Developer: Reload Window"'
        Write-Host '  2. View -> Output -> wybierz kanal "Worker Board"'
        Write-Host "  3. Powinien pojawic sie wpis: `"Worker Board $($pkgJson.version) uruchomiony`""
    }

    exit 0
}
catch {
    Write-Fail $_.Exception.Message
    exit 1
}
