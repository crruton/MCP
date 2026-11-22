# Прогоняет все эксперименты по порядку и складывает логи в experiments/logs/.
# Требуется: Node.js 24.x, Go 1.27+, .NET SDK 10, Rust 1.100+ (GNU target), JDK 21+, Maven 3.9+.
#
#   powershell -ExecutionPolicy Bypass -File experiments\run-all.ps1
#   powershell -ExecutionPolicy Bypass -File experiments\run-all.ps1 -Only exp0,expA
#
param(
    [string[]]$Only = @('exp0', 'expA', 'expB', 'expC', 'expD', 'expE', 'expF'),
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$MavenHome = $env:MAVEN_HOME,
    [string]$RustSdk = $env:RUST_SDK_DIR
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Step($name, $block) {
    Write-Host "== $name" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $block
    $sw.Stop()
    Write-Host "   ok, $([int]$sw.Elapsed.TotalSeconds) s" -ForegroundColor Green
}

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "$cmd not found. $hint"
    }
}

if ($Only -contains 'exp0') {
    Step 'exp0_probe (13 HTTP probes)' {
        Need 'node' 'Install Node.js 24.x'
        Push-Location (Join-Path $root 'exp0_probe')
        try { node probe.mjs *>&1 | Tee-Object (Join-Path $logs 'exp0.log') } finally { Pop-Location }
    }
}

if ($Only -contains 'expA') {
    Step 'expA_polling (45 runs)' {
        Need 'node' 'Install Node.js 24.x'
        Push-Location (Join-Path $root 'expA_polling')
        try { node run.mjs *>&1 | Tee-Object (Join-Path $logs 'expA.log') } finally { Pop-Location }
    }
}

if ($Only -contains 'expB') {
    Step 'expB_crash (6 scenarios)' {
        Need 'node' 'Install Node.js 24.x'
        Push-Location (Join-Path $root 'expB_crash')
        try { node run.mjs *>&1 | Tee-Object (Join-Path $logs 'expB.log') } finally { Pop-Location }
    }
}

if ($Only -contains 'expC') {
    Step 'expC_go (client + server over stdio)' {
        Need 'go' 'Install Go 1.27+'
        Push-Location (Join-Path $root 'expC_go')
        try { go run . *>&1 | Tee-Object (Join-Path $logs 'expC.log') } finally { Pop-Location }
    }
}

if ($Only -contains 'expD') {
    Step 'expD_csharp (Tasks server + polling client)' {
        Need 'dotnet' 'Install .NET SDK 10'
        Push-Location (Join-Path $root 'expD_csharp')
        try { & (Join-Path $root 'expD_csharp\run.ps1') *>&1 | Tee-Object (Join-Path $logs 'expD.log') } finally { Pop-Location }
    }
}

if ($Only -contains 'expE') {
    Step 'expE_rust (rmcp task examples)' {
        Need 'cargo' 'Install Rust 1.100+ with the x86_64-pc-windows-gnu target'
        if (-not $RustSdk) {
            Write-Host '   skipped: set RUST_SDK_DIR to a checkout of rust-sdk at tag rmcp-v3.11.0' -ForegroundColor Yellow
        }
        else {
            Push-Location $RustSdk
            try {
                cargo run -p mcp-client-examples --example clients_task_stdio *>&1 |
                    Tee-Object (Join-Path $logs 'expE.log')
            }
            finally { Pop-Location }
        }
    }
}

if ($Only -contains 'expF') {
    Step 'expF_java (modern client + server over stdio)' {
        if (-not $JavaHome -or -not $MavenHome) {
            Write-Host '   skipped: set JAVA_HOME (JDK 21+) and MAVEN_HOME (Maven 3.9+)' -ForegroundColor Yellow
        }
        else {
            & (Join-Path $root 'expF_java\run.ps1') -JavaHome $JavaHome -MavenHome $MavenHome *>&1 |
                Tee-Object (Join-Path $logs 'expF.log')
        }
    }
}

Write-Host "`nAll done. Logs: $logs" -ForegroundColor Cyan
