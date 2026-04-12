<#
.SYNOPSIS
    Windows Server Manager Agent - REST API Service
.DESCRIPTION
    A headless PowerShell REST API that provides remote management of:
    - Windows Updates (check, install, schedule, history)
    - Applications/Services (start, stop, list, monitor)
    - System Information (CPU, RAM, disk, uptime)
.NOTES
    Requires: PowerShell 5.1+, Run as Administrator
    Config:   config.json in same directory
#>

param(
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ============================================================
# CONFIGURATION
# ============================================================
if ([string]::IsNullOrEmpty($ConfigPath)) {
    $ConfigPath = Join-Path $scriptDir "config.json"
}

if (-not (Test-Path $ConfigPath)) {
    Write-Error "Config file not found: $ConfigPath. Run Install-Agent.ps1 first."
    exit 1
}

$config = Get-Content $ConfigPath | ConvertFrom-Json
$Port = $config.Port
$ApiKey = $config.ApiKey
$LogPath = $config.LogPath
$AllowedOrigins = $config.AllowedOrigins

if (-not (Test-Path $LogPath)) {
    New-Item -ItemType Directory -Path $LogPath -Force | Out-Null
}

# ============================================================
# LOGGING
# ============================================================
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logLine = "[$timestamp] [$Level] $Message"
    $logFile = Join-Path $LogPath "agent_$(Get-Date -Format 'yyyyMMdd').log"
    Add-Content -Path $logFile -Value $logLine
    Write-Host $logLine -ForegroundColor $(switch ($Level) {
        "ERROR" { "Red" }
        "WARN"  { "Yellow" }
        "INFO"  { "Green" }
        default { "White" }
    })
}

# ============================================================
# HELPER FUNCTIONS
# ============================================================
function Test-ApiKey {
    param($request)
    $authHeader = $request.Headers["X-API-Key"]
    if ($authHeader -eq $ApiKey) { return $true }
    
    $queryKey = $request.QueryString["apikey"]
    if ($queryKey -eq $ApiKey) { return $true }
    
    return $false
}

function Send-JsonResponse {
    param($response, $data, [int]$statusCode = 200)
    $json = $data | ConvertTo-Json -Depth 10 -Compress
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.StatusCode = $statusCode
    $response.ContentType = "application/json; charset=utf-8"
    $response.ContentLength64 = $buffer.Length
    
    # CORS headers
    $response.Headers.Add("Access-Control-Allow-Origin", "*")
    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
    
    $response.OutputStream.Write($buffer, 0, $buffer.Length)
    $response.OutputStream.Close()
}

function Send-ErrorResponse {
    param($response, [string]$message, [int]$statusCode = 500)
    Send-JsonResponse -response $response -data @{
        success = $false
        error   = $message
        timestamp = (Get-Date -Format "o")
    } -statusCode $statusCode
}

function Read-RequestBody {
    param($request)
    $reader = New-Object System.IO.StreamReader($request.InputStream)
    $body = $reader.ReadToEnd()
    $reader.Close()
    if ([string]::IsNullOrEmpty($body)) { return @{} }
    return $body | ConvertFrom-Json
}

# ============================================================
# ROUTE HANDLERS
# ============================================================

# --- System Info ---
function Get-SystemInfo {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
    $uptime = (Get-Date) - $os.LastBootUpTime
    
    return @{
        success = $true
        data = @{
            hostname     = $env:COMPUTERNAME
            os           = $os.Caption
            osVersion    = $os.Version
            architecture = $os.OSArchitecture
            uptime       = @{
                days    = [math]::Floor($uptime.TotalDays)
                hours   = $uptime.Hours
                minutes = $uptime.Minutes
                total_hours = [math]::Round($uptime.TotalHours, 1)
            }
            cpu = @{
                name        = $cpu[0].Name.Trim()
                cores       = $cpu[0].NumberOfCores
                threads     = $cpu[0].NumberOfLogicalProcessors
                usage       = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
            }
            memory = @{
                total_gb     = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
                free_gb      = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
                used_gb      = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2)
                usage_percent = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1)
            }
            disks = @($disk | ForEach-Object {
                @{
                    drive         = $_.DeviceID
                    label         = $_.VolumeName
                    total_gb      = [math]::Round($_.Size / 1GB, 2)
                    free_gb       = [math]::Round($_.FreeSpace / 1GB, 2)
                    used_gb       = [math]::Round(($_.Size - $_.FreeSpace) / 1GB, 2)
                    usage_percent = [math]::Round((($_.Size - $_.FreeSpace) / $_.Size) * 100, 1)
                }
            })
        }
        timestamp = (Get-Date -Format "o")
    }
}

# --- Windows Updates ---
function Get-PendingUpdates {
    Write-Log "Checking for pending Windows Updates..."
    try {
        $session = New-Object -ComObject Microsoft.Update.Session
        $searcher = $session.CreateUpdateSearcher()
        $results = $searcher.Search("IsInstalled=0")
        
        $updates = @($results.Updates | ForEach-Object {
            @{
                title       = $_.Title
                id          = $_.Identity.UpdateID
                severity    = if ($_.MsrcSeverity) { $_.MsrcSeverity } else { "Unspecified" }
                size_mb     = [math]::Round($_.MaxDownloadSize / 1MB, 2)
                categories  = @($_.Categories | ForEach-Object { $_.Name })
                is_downloaded = $_.IsDownloaded
                is_mandatory  = $_.IsMandatory
                description   = $_.Description
                kb_numbers    = @($_.KBArticleIDs)
                release_date  = if ($_.LastDeploymentChangeTime) { $_.LastDeploymentChangeTime.ToString("o") } else { $null }
            }
        })
        
        return @{
            success = $true
            data = @{
                count   = $updates.Count
                updates = $updates
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        Write-Log "Error checking updates: $_" -Level "ERROR"
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

function Get-UpdateHistory {
    param([int]$Count = 50)
    try {
        $session = New-Object -ComObject Microsoft.Update.Session
        $searcher = $session.CreateUpdateSearcher()
        $totalCount = $searcher.GetTotalHistoryCount()
        $history = $searcher.QueryHistory(0, [Math]::Min($Count, $totalCount))
        
        $entries = @($history | Where-Object { $_.Title } | ForEach-Object {
            @{
                title      = $_.Title
                date       = $_.Date.ToString("o")
                result     = switch ($_.ResultCode) {
                    0 { "Not Started" }
                    1 { "In Progress" }
                    2 { "Succeeded" }
                    3 { "Succeeded With Errors" }
                    4 { "Failed" }
                    5 { "Aborted" }
                    default { "Unknown" }
                }
                operation  = switch ($_.Operation) {
                    1 { "Installation" }
                    2 { "Uninstallation" }
                    default { "Other" }
                }
            }
        })
        
        return @{
            success = $true
            data = @{
                total   = $totalCount
                showing = $entries.Count
                history = $entries
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

function Install-PendingUpdates {
    param([string[]]$UpdateIds = @())
    try {
        Write-Log "Starting update installation..."
        $session = New-Object -ComObject Microsoft.Update.Session
        $searcher = $session.CreateUpdateSearcher()
        $results = $searcher.Search("IsInstalled=0")
        
        $updatesToInstall = New-Object -ComObject Microsoft.Update.UpdateColl
        
        foreach ($update in $results.Updates) {
            if ($UpdateIds.Count -eq 0 -or $UpdateIds -contains $update.Identity.UpdateID) {
                if (-not $update.EulaAccepted) { $update.AcceptEula() }
                $updatesToInstall.Add($update) | Out-Null
            }
        }
        
        if ($updatesToInstall.Count -eq 0) {
            return @{ success = $true; data = @{ message = "No updates to install"; installed = 0 }; timestamp = (Get-Date -Format "o") }
        }
        
        # Download updates first
        Write-Log "Downloading $($updatesToInstall.Count) updates..."
        $downloader = $session.CreateUpdateDownloader()
        $downloader.Updates = $updatesToInstall
        $downloadResult = $downloader.Download()
        
        # Install updates
        Write-Log "Installing $($updatesToInstall.Count) updates..."
        $installer = $session.CreateUpdateInstaller()
        $installer.Updates = $updatesToInstall
        $installResult = $installer.Install()
        
        $resultDetails = @()
        for ($i = 0; $i -lt $updatesToInstall.Count; $i++) {
            $resultDetails += @{
                title  = $updatesToInstall.Item($i).Title
                result = switch ($installResult.GetUpdateResult($i).ResultCode) {
                    2 { "Succeeded" }
                    3 { "Succeeded With Errors" }
                    4 { "Failed" }
                    default { "Unknown" }
                }
            }
        }
        
        $rebootRequired = $installResult.RebootRequired
        Write-Log "Installation complete. Reboot required: $rebootRequired"
        
        return @{
            success = $true
            data = @{
                installed       = $updatesToInstall.Count
                reboot_required = $rebootRequired
                results         = $resultDetails
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        Write-Log "Update installation error: $_" -Level "ERROR"
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

function Get-WindowsUpdateSettings {
    try {
        $auSettings = (New-Object -ComObject Microsoft.Update.AutoUpdate).Settings
        return @{
            success = $true
            data = @{
                notification_level = switch ($auSettings.NotificationLevel) {
                    0 { "Not Configured" }
                    1 { "Disabled" }
                    2 { "Notify Before Download" }
                    3 { "Notify Before Install" }
                    4 { "Scheduled Install" }
                    default { "Unknown" }
                }
                read_only = $auSettings.ReadOnly
                scheduled_day = switch ($auSettings.ScheduledInstallationDay) {
                    0 { "Every Day" }
                    1 { "Sunday" }
                    2 { "Monday" }
                    3 { "Tuesday" }
                    4 { "Wednesday" }
                    5 { "Thursday" }
                    6 { "Friday" }
                    7 { "Saturday" }
                }
                scheduled_time = $auSettings.ScheduledInstallationTime
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

# --- Process / Application Management ---
function Get-RunningProcesses {
    param([string]$Filter = "")
    $processes = Get-Process | Where-Object {
        if ($Filter) { $_.ProcessName -like "*$Filter*" -or $_.MainWindowTitle -like "*$Filter*" }
        else { $true }
    } | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 100

    $data = @($processes | ForEach-Object {
        @{
            name        = $_.ProcessName
            pid         = $_.Id
            cpu_seconds = [math]::Round($_.CPU, 2)
            memory_mb   = [math]::Round($_.WorkingSet64 / 1MB, 2)
            threads     = $_.Threads.Count
            title       = $_.MainWindowTitle
            start_time  = if ($_.StartTime) { $_.StartTime.ToString("o") } else { $null }
            responding  = $_.Responding
            path        = try { $_.Path } catch { $null }
        }
    })
    
    return @{
        success = $true
        data = @{
            count     = $data.Count
            processes = $data
        }
        timestamp = (Get-Date -Format "o")
    }
}

function Start-Application {
    param([string]$Path, [string]$Arguments = "", [string]$WorkingDirectory = "")
    try {
        if (-not (Test-Path $Path)) {
            return @{ success = $false; error = "Application not found: $Path"; timestamp = (Get-Date -Format "o") }
        }
        
        $startInfo = @{ FilePath = $Path }
        if ($Arguments) { $startInfo.ArgumentList = $Arguments.Split(" ") }
        if ($WorkingDirectory -and (Test-Path $WorkingDirectory)) { 
            $startInfo.WorkingDirectory = $WorkingDirectory 
        }
        
        $process = Start-Process @startInfo -PassThru
        Write-Log "Started application: $Path (PID: $($process.Id))"
        
        return @{
            success = $true
            data = @{
                pid  = $process.Id
                name = $process.ProcessName
                path = $Path
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        Write-Log "Error starting application: $_" -Level "ERROR"
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

function Stop-Application {
    param([int]$ProcessId, [switch]$Force)
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $name = $process.ProcessName
        
        if ($Force) {
            $process | Stop-Process -Force
        } else {
            $process.CloseMainWindow() | Out-Null
            if (-not $process.WaitForExit(5000)) {
                $process | Stop-Process -Force
            }
        }
        
        Write-Log "Stopped application: $name (PID: $ProcessId)"
        return @{
            success = $true
            data = @{
                message = "Process $name (PID: $ProcessId) stopped successfully"
                pid     = $ProcessId
                name    = $name
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        Write-Log "Error stopping process: $_" -Level "ERROR"
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

# --- Windows Services ---
function Get-ServicesList {
    param([string]$Filter = "")
    $services = Get-Service | Where-Object {
        if ($Filter) { $_.Name -like "*$Filter*" -or $_.DisplayName -like "*$Filter*" }
        else { $true }
    }
    
    $data = @($services | ForEach-Object {
        @{
            name         = $_.Name
            display_name = $_.DisplayName
            status       = $_.Status.ToString()
            start_type   = $_.StartType.ToString()
            can_stop     = $_.CanStop
        }
    })
    
    return @{
        success = $true
        data = @{
            count    = $data.Count
            services = $data
        }
        timestamp = (Get-Date -Format "o")
    }
}

function Set-ServiceAction {
    param([string]$ServiceName, [string]$Action)
    try {
        switch ($Action.ToLower()) {
            "start"   { Start-Service -Name $ServiceName }
            "stop"    { Stop-Service -Name $ServiceName -Force }
            "restart" { Restart-Service -Name $ServiceName -Force }
            default   { return @{ success = $false; error = "Invalid action: $Action" } }
        }
        
        $svc = Get-Service -Name $ServiceName
        Write-Log "Service $ServiceName action: $Action -> Status: $($svc.Status)"
        
        return @{
            success = $true
            data = @{
                name   = $svc.Name
                status = $svc.Status.ToString()
                action = $Action
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

# --- Scheduled Tasks ---
function Get-ScheduledUpdateTasks {
    $tasks = Get-ScheduledTask -TaskPath "\ServerManager\*" -ErrorAction SilentlyContinue
    if (-not $tasks) {
        return @{ success = $true; data = @{ count = 0; tasks = @() }; timestamp = (Get-Date -Format "o") }
    }
    
    $data = @($tasks | ForEach-Object {
        $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        @{
            name        = $_.TaskName
            state       = $_.State.ToString()
            last_run    = if ($info.LastRunTime) { $info.LastRunTime.ToString("o") } else { $null }
            next_run    = if ($info.NextRunTime) { $info.NextRunTime.ToString("o") } else { $null }
            last_result = $info.LastTaskResult
        }
    })
    
    return @{ success = $true; data = @{ count = $data.Count; tasks = $data }; timestamp = (Get-Date -Format "o") }
}

function New-ScheduledUpdateTask {
    param([string]$Name, [string]$Time, [string]$Frequency = "Daily")
    try {
        $taskPath = "\ServerManager\"
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$scriptDir\ServerManagerAgent.ps1`" -RunUpdates"
        
        $trigger = switch ($Frequency.ToLower()) {
            "daily"   { New-ScheduledTaskTrigger -Daily -At $Time }
            "weekly"  { New-ScheduledTaskTrigger -Weekly -At $Time -DaysOfWeek Sunday }
            "monthly" { New-ScheduledTaskTrigger -Daily -At $Time } # Simplified
            default   { New-ScheduledTaskTrigger -Daily -At $Time }
        }
        
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        
        Register-ScheduledTask -TaskName $Name -TaskPath $taskPath -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        
        Write-Log "Created scheduled task: $Name at $Time ($Frequency)"
        return @{
            success = $true
            data = @{ name = $Name; time = $Time; frequency = $Frequency; message = "Task created successfully" }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

# --- Reboot Management ---
function Get-RebootStatus {
    $rebootPending = $false
    $reasons = @()
    
    # Check Component Based Servicing
    if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") {
        $rebootPending = $true
        $reasons += "Component Based Servicing"
    }
    
    # Check Windows Update
    if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") {
        $rebootPending = $true
        $reasons += "Windows Update"
    }
    
    # Check PendingFileRename
    $pfr = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager" -Name "PendingFileRenameOperations" -ErrorAction SilentlyContinue
    if ($pfr) {
        $rebootPending = $true
        $reasons += "Pending File Rename"
    }
    
    return @{
        success = $true
        data = @{
            reboot_pending = $rebootPending
            reasons        = $reasons
        }
        timestamp = (Get-Date -Format "o")
    }
}

function Invoke-ScheduledReboot {
    param([int]$DelayMinutes = 5, [string]$Reason = "Scheduled maintenance reboot")
    try {
        shutdown /r /t ($DelayMinutes * 60) /c $Reason /d p:4:1
        Write-Log "Scheduled reboot in $DelayMinutes minutes: $Reason"
        return @{
            success = $true
            data = @{
                message       = "Reboot scheduled in $DelayMinutes minutes"
                delay_minutes = $DelayMinutes
                reason        = $Reason
            }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

function Stop-ScheduledReboot {
    try {
        shutdown /a
        Write-Log "Cancelled pending reboot"
        return @{ success = $true; data = @{ message = "Pending reboot cancelled" }; timestamp = (Get-Date -Format "o") }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

# --- Event Log ---
function Get-RecentEvents {
    param([string]$LogName = "System", [int]$Count = 50, [string]$Level = "")
    try {
        $filter = @{ LogName = $LogName; MaxEvents = $Count }
        if ($Level) {
            $levelNum = switch ($Level.ToLower()) {
                "critical"    { 1 }
                "error"       { 2 }
                "warning"     { 3 }
                "information" { 4 }
                default       { $null }
            }
            if ($levelNum) { $filter.Level = $levelNum }
        }
        
        $events = Get-WinEvent -FilterHashtable $filter -ErrorAction SilentlyContinue
        
        $data = @($events | ForEach-Object {
            @{
                id        = $_.Id
                level     = $_.LevelDisplayName
                source    = $_.ProviderName
                message   = $_.Message.Substring(0, [Math]::Min(500, $_.Message.Length))
                timestamp = $_.TimeCreated.ToString("o")
            }
        })
        
        return @{
            success = $true
            data = @{ count = $data.Count; events = $data }
            timestamp = (Get-Date -Format "o")
        }
    } catch {
        return @{ success = $false; error = $_.Exception.Message; timestamp = (Get-Date -Format "o") }
    }
}

# ============================================================
# HTTP LISTENER / ROUTER
# ============================================================
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("https://+:$Port/")
$listener.Start()

Write-Log "Server Manager Agent started on port $Port"
Write-Log "Endpoints available at https://<hostname>:$Port/api/..."

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $method = $request.HttpMethod
        $path = $request.Url.AbsolutePath.TrimEnd("/")
        
        Write-Log "$method $path" -Level "INFO"
        
        # Handle CORS preflight
        if ($method -eq "OPTIONS") {
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
            $response.Headers.Add("Access-Control-Max-Age", "86400")
            $response.StatusCode = 204
            $response.Close()
            continue
        }
        
        # Health check (no auth required)
        if ($path -eq "/api/health") {
            Send-JsonResponse -response $response -data @{
                success = $true
                data = @{
                    status  = "healthy"
                    version = "1.0.0"
                    uptime  = [math]::Round(((Get-Date) - (Get-Process -Id $PID).StartTime).TotalHours, 2)
                }
                timestamp = (Get-Date -Format "o")
            }
            continue
        }
        
        # Authentication check
        if (-not (Test-ApiKey -request $request)) {
            Write-Log "Unauthorized request from $($request.RemoteEndPoint)" -Level "WARN"
            Send-ErrorResponse -response $response -message "Unauthorized. Provide X-API-Key header." -statusCode 401
            continue
        }
        
        # Route requests
        try {
            $result = switch -Regex ($path) {
                # System
                "^/api/system/info$" {
                    if ($method -eq "GET") { Get-SystemInfo }
                }
                "^/api/system/reboot/status$" {
                    if ($method -eq "GET") { Get-RebootStatus }
                }
                "^/api/system/reboot$" {
                    if ($method -eq "POST") {
                        $body = Read-RequestBody -request $request
                        Invoke-ScheduledReboot -DelayMinutes ([int]($body.delay_minutes ?? 5)) -Reason ($body.reason ?? "Scheduled reboot")
                    }
                }
                "^/api/system/reboot/cancel$" {
                    if ($method -eq "POST") { Stop-ScheduledReboot }
                }
                "^/api/system/events$" {
                    if ($method -eq "GET") {
                        $logName = $request.QueryString["log"] ?? "System"
                        $count = [int]($request.QueryString["count"] ?? "50")
                        $level = $request.QueryString["level"] ?? ""
                        Get-RecentEvents -LogName $logName -Count $count -Level $level
                    }
                }
                
                # Windows Updates
                "^/api/updates/pending$" {
                    if ($method -eq "GET") { Get-PendingUpdates }
                }
                "^/api/updates/history$" {
                    if ($method -eq "GET") {
                        $count = [int]($request.QueryString["count"] ?? "50")
                        Get-UpdateHistory -Count $count
                    }
                }
                "^/api/updates/install$" {
                    if ($method -eq "POST") {
                        $body = Read-RequestBody -request $request
                        $ids = if ($body.update_ids) { $body.update_ids } else { @() }
                        Install-PendingUpdates -UpdateIds $ids
                    }
                }
                "^/api/updates/settings$" {
                    if ($method -eq "GET") { Get-WindowsUpdateSettings }
                }
                "^/api/updates/schedule$" {
                    if ($method -eq "GET") { Get-ScheduledUpdateTasks }
                    if ($method -eq "POST") {
                        $body = Read-RequestBody -request $request
                        New-ScheduledUpdateTask -Name $body.name -Time $body.time -Frequency ($body.frequency ?? "Daily")
                    }
                }
                
                # Processes
                "^/api/processes$" {
                    if ($method -eq "GET") {
                        $filter = $request.QueryString["filter"] ?? ""
                        Get-RunningProcesses -Filter $filter
                    }
                }
                "^/api/processes/start$" {
                    if ($method -eq "POST") {
                        $body = Read-RequestBody -request $request
                        Start-Application -Path $body.path -Arguments ($body.arguments ?? "") -WorkingDirectory ($body.working_directory ?? "")
                    }
                }
                "^/api/processes/stop$" {
                    if ($method -eq "POST") {
                        $body = Read-RequestBody -request $request
                        Stop-Application -ProcessId ([int]$body.pid) -Force:([bool]($body.force ?? $false))
                    }
                }
                
                # Services
                "^/api/services$" {
                    if ($method -eq "GET") {
                        $filter = $request.QueryString["filter"] ?? ""
                        Get-ServicesList -Filter $filter
                    }
                }
                "^/api/services/action$" {
                    if ($method -eq "POST") {
                        $body = Read-RequestBody -request $request
                        Set-ServiceAction -ServiceName $body.name -Action $body.action
                    }
                }
                
                default { $null }
            }
            
            if ($null -eq $result) {
                Send-ErrorResponse -response $response -message "Not Found: $method $path" -statusCode 404
            } else {
                Send-JsonResponse -response $response -data $result
            }
        } catch {
            Write-Log "Error processing $method $path : $_" -Level "ERROR"
            Send-ErrorResponse -response $response -message $_.Exception.Message -statusCode 500
        }
    }
} finally {
    $listener.Stop()
    Write-Log "Server Manager Agent stopped"
}
