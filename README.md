# ServerPilot — Remote Windows Server Manager

A headless, remote management tool for Windows Server. Manage **Windows Updates**, **start/stop applications**, control **Windows Services**, monitor **system health**, and view **event logs** — all from a beautiful web dashboard running on any device.

## Architecture

```
┌──────────────────────────┐          HTTPS (port 8443)         ┌──────────────────────────┐
│   Web Dashboard (UI)     │ ◄──────────────────────────────── │   Windows Server Agent   │
│   HTML/CSS/JavaScript    │          REST API + API Key        │   PowerShell Service     │
│   Any browser, any OS    │ ────────────────────────────────► │   Runs as Admin/Service  │
└──────────────────────────┘                                    └──────────────────────────┘
```

**Three components:**

| Component | Location | Technology | Purpose |
|-----------|----------|------------|---------|
| **Server Agent** | `server-agent/` | PowerShell 5.1+ | REST API running on the Windows Server |
| **Web Dashboard** | `dashboard/` | HTML/CSS/JS | UI you open in any browser to manage the server |
| **Uptime Monitor** | `monitor/` | Node.js | Background email alerter for server downtime |

---

## Features

### 🔄 Windows Updates
- View all pending updates with severity, size, and KB info
- Install individual or all updates with one click
- View complete update history
- Check Windows Update settings (Group Policy)
- Schedule recurring update tasks

### ⚡ Process Management
- View all running processes with CPU, memory, and thread info
- Start any application remotely by path
- Gracefully stop or force-kill processes
- Search/filter processes in real-time

### ⚙️ Windows Services
- List all services with status and start type
- Start, stop, and restart services
- Filter by Running/Stopped state
- Search services by name

### 📊 System Dashboard
- Real-time CPU, memory, and disk usage with visual bars
- Server uptime and OS information
- Reboot status (pending reboot detection)
- Schedule or cancel reboots remotely

### 📋 Event Log Viewer
- Browse System, Application, and Security logs
- Filter by severity: Critical, Error, Warning, Information
- View event details including source and message

### 📧 Uptime Monitoring & Email Alerts
- Continuous health checks against the server agent
- **Email notifications** when the server goes offline
- **Recovery alerts** with downtime duration when the server comes back
- Visual heartbeat timeline in the dashboard
- Configurable check intervals, failure thresholds, and alert cooldowns
- Supports Gmail, Outlook, Yahoo, or any SMTP server
- Interactive setup wizard (`node setup-config.js`)

---

## Quick Start

### 1. Set Up the Server Agent (on your Windows Server)

**Requirements:**
- Windows Server 2016+ (or Windows 10+)
- PowerShell 5.1+
- Administrator privileges

```powershell
# Copy the server-agent folder to your Windows Server, then:
cd C:\path\to\server-agent

# Run the installer as Administrator
powershell -ExecutionPolicy Bypass -File .\Install-Agent.ps1
```

The installer will:
1. Create `C:\ServerManagerAgent\` directory
2. Generate a secure API key (save this!)
3. Create a self-signed SSL certificate
4. Configure the Windows Firewall
5. Register the HTTPS URL prefix

**Save the API key** — you'll need it for the dashboard.

#### Start the Agent

```powershell
# Run directly (for testing)
powershell -ExecutionPolicy Bypass -File C:\ServerManagerAgent\ServerManagerAgent.ps1

# Or install as a Windows Service using NSSM (recommended for production)
# Download NSSM from https://nssm.cc/
nssm install ServerManagerAgent powershell.exe "-ExecutionPolicy Bypass -File C:\ServerManagerAgent\ServerManagerAgent.ps1"
nssm set ServerManagerAgent AppDirectory C:\ServerManagerAgent
nssm set ServerManagerAgent Start SERVICE_AUTO_START
nssm start ServerManagerAgent
```

### 2. Open the Web Dashboard

The dashboard is a static HTML/CSS/JS application — no build step needed.

**Option A: Open directly**
```
Open dashboard/index.html in any web browser
```

**Option B: Serve with any static HTTP server**
```bash
# Python
cd dashboard
python3 -m http.server 3000

# Node.js
npx serve dashboard -l 3000

# Or use VS Code Live Server, etc.
```

### 3. Connect

1. Enter your server's IP address or hostname
2. Enter the port (default: `8443`)
3. Enter the API key from the installer
4. Click **Connect**

> **Note:** Since the agent uses a self-signed SSL certificate, you may need to visit  
> `https://<server-ip>:8443/api/health` in your browser first and accept the certificate warning.

---

## API Reference

All endpoints require the `X-API-Key` header (except `/api/health`).

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check (no auth) |
| `GET` | `/api/system/info` | CPU, memory, disk, uptime |
| `GET` | `/api/system/reboot/status` | Check if reboot is pending |
| `POST` | `/api/system/reboot` | Schedule a reboot |
| `POST` | `/api/system/reboot/cancel` | Cancel pending reboot |
| `GET` | `/api/system/events` | Event log entries |

### Windows Updates
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/updates/pending` | List pending updates |
| `GET` | `/api/updates/history` | Update install history |
| `POST` | `/api/updates/install` | Install updates |
| `GET` | `/api/updates/settings` | Windows Update settings |
| `GET/POST` | `/api/updates/schedule` | Manage scheduled tasks |

### Processes
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/processes` | List running processes |
| `POST` | `/api/processes/start` | Start an application |
| `POST` | `/api/processes/stop` | Stop a process |

### Services
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/services` | List Windows Services |
| `POST` | `/api/services/action` | Start/Stop/Restart a service |

---

## Configuration

The agent config is stored at `C:\ServerManagerAgent\config.json`:

```json
{
    "Port": 8443,
    "ApiKey": "your-generated-api-key",
    "AllowedOrigins": ["*"],
    "LogPath": "C:\\ServerManagerAgent\\logs",
    "MaxLogSizeMB": 50
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `Port` | HTTPS port for the API | `8443` |
| `ApiKey` | Authentication key | Auto-generated |
| `AllowedOrigins` | CORS allowed origins | `["*"]` |
| `LogPath` | Directory for log files | `C:\ServerManagerAgent\logs` |
| `MaxLogSizeMB` | Max log file size | `50` |

---

## Security Considerations

- **HTTPS Only** — All traffic is encrypted with TLS via a self-signed certificate
- **API Key Auth** — Every request (except health check) requires a valid API key
- **Firewall** — The installer only opens the port on Domain and Private network profiles
- **Run as Service** — Use NSSM to run as LOCAL SERVICE for least privilege
- **Restrict Origins** — Set `AllowedOrigins` in config.json to your dashboard's domain in production

### Hardening for Production

1. Replace the self-signed cert with a proper CA-signed certificate
2. Restrict `AllowedOrigins` to specific domains
3. Use a strong, rotated API key
4. Consider placing behind a reverse proxy (e.g., IIS, nginx)
5. Enable Windows audit logging

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cannot reach server" | Verify the agent is running, firewall port is open, and you can ping the server |
| Certificate error in browser | Visit `https://<ip>:8443/api/health` and accept the self-signed cert |
| "Unauthorized" | Check your API key matches `config.json` on the server |
| Updates not showing | Ensure the agent runs as Administrator (required for Windows Update COM) |
| Services won't start/stop | Agent must run with elevated privileges |

---

## Project Structure

```
testProject/
├── server-agent/
│   ├── Install-Agent.ps1        # One-time setup script
│   └── ServerManagerAgent.ps1   # The REST API agent
│
├── dashboard/
│   ├── index.html               # Main dashboard page
│   ├── styles.css               # Design system & styles
│   ├── api.js                   # API client library
│   └── app.js                   # Application controller
│
├── monitor/
│   ├── package.json             # Dependencies (nodemailer)
│   ├── config.json              # Server + email settings
│   ├── server-monitor.js        # Uptime checker + email alerter
│   └── setup-config.js          # Interactive setup wizard
│
└── README.md                    # This file
```

---

## License

MIT
