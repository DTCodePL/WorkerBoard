#requires -Version 7.0
<#
.SYNOPSIS
    Wrapper do uruchamiania zewnetrznych workerow AI (Spark/muse w WSL, Codex natywnie)
    z zapisem stanu przebiegu dla panelu VS Code "Worker Board".

.OPIS
    Uruchamia worker jako proces potomny, strumieniuje jego stdout/stderr rownoczesnie
    na konsole i do pliku logu, oraz utrzymuje rekord JSON w
    %USERPROFILE%\.claude\worker-status\<id>.json przez caly czas trwania przebiegu.
    Kontrakt pliku stanu jest sztywny - czyta go panel VS Code, wiec KAZDE pole
    (nazwy, typy, wartosci status) musi zostac zachowane dokladnie tak, jak opisano
    w specyfikacji zadania.

.PRZYKLADY
    .\worker-run.ps1 -Engine spark -Title "Refaktor tokenow" `
        -BriefFile C:\tmp\brief.md -Repo D:\projects\MyApp

    .\worker-run.ps1 -Engine codex -Title "Test wrappera" `
        -BriefFile C:\tmp\brief.md -Repo D:\projects\MyApp `
        -Model gpt-5.6-luna -Effort low
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('spark', 'codex')]
    [string]$Engine,

    [Parameter(Mandatory)]
    [string]$Title,

    [Parameter(Mandatory)]
    [string]$BriefFile,

    [Parameter(Mandatory)]
    [string]$Repo,

    [string]$Model,

    [string]$Effort,

    [string[]]$Passthru
)

Set-StrictMode -Version Latest

# --- Funkcja: translacja sciezki Windows -> WSL --------------------------------
# "D:\projects\MyApp" -> "/mnt/d/projects/MyApp"
function ConvertTo-WslPath {
    param(
        [Parameter(Mandatory)]
        [string]$WindowsPath
    )

    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($full -notmatch '^[A-Za-z]:\\') {
        throw "Sciezka '$WindowsPath' nie jest bezwzgledna sciezka Windows (oczekiwano np. 'C:\...')."
    }

    $driveLetter = $full.Substring(0, 1).ToLowerInvariant()
    $rest = $full.Substring(2) -replace '\\', '/'
    return "/mnt/$driveLetter$rest"
}

# --- Funkcja: atomowy zapis rekordu stanu --------------------------------------
# Pisze do <id>.json.tmp, dopiero potem Move-Item -Force na <id>.json, zeby panel
# (odpytujacy katalog co 5 s) nigdy nie zobaczyl czesciowo zapisanego pliku.
function Write-WorkerState {
    param(
        [Parameter(Mandatory)]
        [string]$StatePath,

        [Parameter(Mandatory)]
        $StateObject
    )

    $tmpPath = "$StatePath.tmp"
    $json = $StateObject | ConvertTo-Json -Depth 5
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tmpPath, $json, $utf8NoBom)
    Move-Item -LiteralPath $tmpPath -Destination $StatePath -Force
}

# --- Walidacja wejscia (PRZED utworzeniem jakiegokolwiek rekordu stanu) --------
if (-not (Test-Path -LiteralPath $BriefFile -PathType Leaf)) {
    Write-Error "worker-run: plik briefu nie istnieje: $BriefFile"
    exit 1
}
if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
    Write-Error "worker-run: katalog repo nie istnieje: $Repo"
    exit 1
}

# Identyfikator konwersacji Claude Code, ktora uruchomila tego workera.
# Zmienna jest dziedziczona przez procesy potomne, wiec nie trzeba jej podawac
# recznie - panel grupuje dzieki niej workery pod ich konwersacja.
$sessionId = if ($env:CLAUDE_CODE_SESSION_ID) { $env:CLAUDE_CODE_SESSION_ID } else { $null }
$briefFull = (Resolve-Path -LiteralPath $BriefFile).ProviderPath
$repoFull = (Resolve-Path -LiteralPath $Repo).ProviderPath

# --- Domyslne model/effort per silnik ------------------------------------------
if ($Engine -eq 'spark') {
    if (-not $Model) { $Model = 'muse-spark-1.3-contributor' }
    if (-not $Effort) { $Effort = 'xhigh' }
}
else {
    if (-not $Model) { $Model = 'gpt-5.6-terra' }
    if (-not $Effort) { $Effort = 'medium' }
}

# --- Walidacja effortu Codexa PRZED uruchomieniem ------------------------------
# CLI nie sprawdza tego lokalnie - literowka przechodzi do API i wywala sie tam,
# po zuzyciu wiadomosci z limitu. Sprawdzamy sami.
if ($Engine -eq 'codex') {
    $standardEfforts = @('minimal', 'low', 'medium', 'high')
    $solOnlyEfforts = @('max', 'ultra')
    $allEfforts = $standardEfforts + $solOnlyEfforts

    if ($Effort -notin $allEfforts) {
        Write-Error "worker-run: nieznany effort Codexa '$Effort'. Dozwolone: $($allEfforts -join ', ')."
        exit 1
    }

    $isSolModel = $Model -match '(?i)sol'
    if (($Effort -in $solOnlyEfforts) -and -not $isSolModel) {
        Write-Error "worker-run: effort '$Effort' istnieje wylacznie na modelu gpt-5.6-sol. Model '$Model' obsluguje tylko: $($standardEfforts -join ', ')."
        exit 1
    }
}

# --- Katalogi stanu i logow -----------------------------------------------------
$stateDir = Join-Path $env:USERPROFILE '.claude\worker-status'
$logDir = Join-Path $stateDir 'logs'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Znana usterka srodowiska: SSL_CERT_FILE / NODE_EXTRA_CA_CERTS -------------
# Jesli wskazuja na nieistniejacy plik, usuwamy je TYLKO dla procesu potomnego -
# nigdy globalnie w sesji uzytkownika.
$certVarsToStrip = @('SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS') | Where-Object {
    $value = [System.Environment]::GetEnvironmentVariable($_)
    $value -and -not (Test-Path -LiteralPath $value)
}

# --- Budowa ProcessStartInfo per silnik -----------------------------------------
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$briefContent = $null

if ($Engine -eq 'spark') {
    $briefWsl = ConvertTo-WslPath -WindowsPath $briefFull
    $repoWsl = ConvertTo-WslPath -WindowsPath $repoFull

    # -d Ubuntu: domyslna dystrybucja WSL to docker-desktop, gdzie muse nie istnieje.
    # --trust-workspace: bez tego Spark pomija AGENTS.md i skille projektu po cichu.
    # --approval-mode never: inaczej worker zawiesi sie na pytaniu, ktorego nikt nie zobaczy.
    $bashCommand = "muse exec --prompt-file `"$briefWsl`" --workspace `"$repoWsl`" --trust-workspace --approval-mode never --reasoning-effort $Effort --model $Model"
    if ($Passthru -and $Passthru.Count -gt 0) {
        $bashCommand += ' ' + ($Passthru -join ' ')
    }

    $psi.FileName = 'wsl.exe'
    foreach ($a in @('-d', 'Ubuntu', '--', 'bash', '-lc', $bashCommand)) {
        $psi.ArgumentList.Add($a)
    }
}
else {
    # Brief podawany przez stdin - dlugi brief w cudzyslowach argumentu sie rozjezdza.
    $briefContent = [System.IO.File]::ReadAllText($briefFull)
    $psi.RedirectStandardInput = $true

    $psi.FileName = 'codex.cmd'
    $codexArgs = @(
        'exec',
        '-s', 'workspace-write',
        '--skip-git-repo-check',
        '-C', $repoFull,
        '-m', $Model,
        '-c', "model_reasoning_effort=`"$Effort`""
    )
    if ($Passthru -and $Passthru.Count -gt 0) {
        $codexArgs += $Passthru
    }
    $codexArgs += '-'

    foreach ($a in $codexArgs) {
        $psi.ArgumentList.Add($a)
    }
}

foreach ($varName in $certVarsToStrip) {
    Write-Verbose "worker-run: usuwam $varName dla procesu potomnego (wskazuje na nieistniejacy plik)."
    $psi.EnvironmentVariables.Remove($varName)
}

# --- Stan wspoldzielony miedzy try i finally ------------------------------------
$proc = $null
$id = $null
$statePath = $null
$logPath = $null
$startedAtDt = $null
$writer = $null
$outSub = $null
$errSub = $null
$outputQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$runError = $null
$exitCode = $null

try {
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.EnableRaisingEvents = $true
    $null = $proc.Start()

    $startedAtDt = [DateTime]::UtcNow
    # id: <engine>-<yyyyMMdd-HHmmss>-<pid>. Dla Sparka pid to PID wsl.exe po stronie
    # Windows - to jest to, co panel potrafi sprawdzic i zabic.
    $id = "$Engine-$($startedAtDt.ToString('yyyyMMdd-HHmmss'))-$($proc.Id)"
    $statePath = Join-Path $stateDir "$id.json"
    $logPath = Join-Path $logDir "$id.log"

    if ($Engine -eq 'codex') {
        $proc.StandardInput.Write($briefContent)
        $proc.StandardInput.Close()
    }

    $outSub = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $outputQueue -Action {
        if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) }
    }
    $errSub = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $outputQueue -Action {
        if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue('[stderr] ' + $EventArgs.Data) }
    }
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    $runningState = [ordered]@{
        schemaVersion = 1
        id            = $id
        engine        = $Engine
        model         = $Model
        effort        = $Effort
        title         = $Title
        repo          = $repoFull
        briefPath     = $briefFull
        sessionId     = $sessionId
        pid           = $proc.Id
        startedAt     = $startedAtDt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        finishedAt    = $null
        exitCode      = $null
        status        = 'running'
        logPath       = $logPath
    }
    Write-WorkerState -StatePath $statePath -StateObject $runningState

    $writer = [System.IO.StreamWriter]::new($logPath, $false, [System.Text.UTF8Encoding]::new($false))
    $writer.AutoFlush = $true

    $line = $null
    # Petla z Start-Sleep jest miejscem, w ktorym Ctrl+C przerywa wykonanie -
    # PowerShell wstrzymuje Start-Sleep natychmiast i odwija stos do finally.
    while (-not $proc.HasExited) {
        while ($outputQueue.TryDequeue([ref]$line)) {
            Write-Host $line
            $writer.WriteLine($line)
        }
        Start-Sleep -Milliseconds 150
    }

    # Doczytanie ewentualnych linii, ktore dotarly tuz po zakonczeniu procesu.
    Start-Sleep -Milliseconds 300
    while ($outputQueue.TryDequeue([ref]$line)) {
        Write-Host $line
        $writer.WriteLine($line)
    }
}
catch {
    $runError = $_
}
finally {
    if ($outSub) { Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue }
    if ($errSub) { Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue }
    if ($writer) {
        try { $writer.Close() } catch { }
    }

    $finishedAtDt = [DateTime]::UtcNow
    $status = 'failed'

    if ($proc) {
        if (-not $proc.HasExited) {
            # Proces wciaz dziala mimo wyjscia z petli - wyjatek albo przerwanie Ctrl+C.
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                $proc.WaitForExit(3000) | Out-Null
            }
            catch { }
            $status = 'killed'
            try { $exitCode = $proc.ExitCode } catch { $exitCode = $null }
        }
        else {
            $exitCode = $proc.ExitCode
            $status = if ($exitCode -eq 0) { 'done' } else { 'failed' }
        }
    }

    if ($id -and $statePath) {
        $finalState = [ordered]@{
            schemaVersion = 1
            id            = $id
            engine        = $Engine
            model         = $Model
            effort        = $Effort
            title         = $Title
            repo          = $repoFull
            briefPath     = $briefFull
            sessionId     = $sessionId
            pid           = $proc.Id
            startedAt     = $startedAtDt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            finishedAt    = $finishedAtDt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            exitCode      = $exitCode
            status        = $status
            logPath       = $logPath
        }
        Write-WorkerState -StatePath $statePath -StateObject $finalState

        $duration = $finishedAtDt - $startedAtDt
        Write-Host ("worker-run: id={0} status={1} czas={2:N1}s log={3}" -f $id, $status, $duration.TotalSeconds, $logPath)
    }
    elseif ($runError) {
        Write-Error "worker-run: proces nie zostal uruchomiony: $($runError.Exception.Message)"
    }
}

if (-not $id -and $runError) {
    exit 1
}
exit ($exitCode ?? 1)
