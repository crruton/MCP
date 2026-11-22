param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$MavenHome = $env:MAVEN_HOME
)
$ErrorActionPreference = "Stop"

if (-not $JavaHome) { throw "JAVA_HOME is not set (JDK 21+ required)" }
if (-not $MavenHome) { throw "MAVEN_HOME is not set (Maven 3.9+ required)" }

$env:JAVA_HOME = $JavaHome
$env:PATH = "$JavaHome\bin;$MavenHome\bin;$env:PATH"

Push-Location $PSScriptRoot
try {
    & "$MavenHome\bin\mvn.cmd" -B -q -DskipTests compile dependency:build-classpath "-Dmdep.outputFile=cp.txt"
    if ($LASTEXITCODE -ne 0) { throw "maven build failed" }

    $cp = (Get-Content "cp.txt" -Raw).Trim()
    # stderr of the child is normal output here (server logs), so do not treat it as a failure
    $ErrorActionPreference = "Continue"
    & "$JavaHome\bin\java.exe" -cp "target\classes;$cp" expf.Client 2>&1 | Tee-Object -FilePath "run.log"
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($code -ne 0) { throw "client exited with $code" }
}
finally {
    Pop-Location
}
