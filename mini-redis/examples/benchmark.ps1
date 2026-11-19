param(
    [ValidateRange(1, 300)] [int]$Requests = 30,
    [string]$Url = 'http://127.0.0.1:8001/v1/report'
)

$ErrorActionPreference = 'Stop'

function Get-Median([double[]]$Samples) {
    $sorted = @($Samples | Sort-Object)
    $mid = [int][Math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2) {
        return $sorted[$mid]
    }
    return ($sorted[$mid - 1] + $sorted[$mid]) / 2
}

function Measure-Report([string]$Uri) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
    $clock.Stop()
    return @{ Cache = [string]$response.Headers['X-Cache']; Body = $response.Content; Ms = $clock.Elapsed.TotalMilliseconds }
}

$null = Measure-Report $Url
$null = Measure-Report ($Url + '?cache=off')
$bypass = @()
$hits = @()
for ($i = 0; $i -lt $Requests; ++$i) {
    $direct = Measure-Report ($Url + '?cache=off')
    $cached = Measure-Report $Url
    if ($direct.Cache -ne 'bypass' -or $cached.Cache -ne 'hit' -or $direct.Body -cne $cached.Body) {
        throw 'Expected identical report bodies and bypass/hit cache status in every measured pair.'
    }
    $bypass += $direct.Ms
    $hits += $cached.Ms
}

$directMedian = Get-Median $bypass
$hitMedian = Get-Median $hits
'Requests per mode: {0}' -f $Requests
'Without cache median: {0:F2} ms' -f $directMedian
'Mini Redis cache hit median: {0:F2} ms' -f $hitMedian
'Median speedup: {0:F2}x' -f ($directMedian / $hitMedian)
