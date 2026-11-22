param([int]$Runs = 12)
$ErrorActionPreference = "Stop"

$dotnet = (Get-Command dotnet).Source
& $dotnet build "Server\Server.csproj" -v q --nologo
if ($LASTEXITCODE -ne 0) { throw "server build failed" }
& $dotnet build "Client\Client.csproj" -v q --nologo
if ($LASTEXITCODE -ne 0) { throw "client build failed" }

$env:DOTNET_HOST_PATH = $dotnet
$lines = @()
for ($i = 1; $i -le $Runs; $i++) {
    & $dotnet "Client\bin\Debug\net10.0\Client.dll" "Server\bin\Debug\net10.0\Server.dll" 2>&1 |
        ForEach-Object { $lines += "run=$i $_" }
}
$lines | Set-Content "run.log" -Encoding utf8
$lines | Select-String -Pattern "negotiated|callToolAsTask|callToolWithPolling|plain call"
