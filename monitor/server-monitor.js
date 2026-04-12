/**
 * ServerPilot — Uptime Monitor & Email Alerter
 * 
 * Continuously monitors the Windows Server agent health endpoint.
 * Sends email alerts when the server goes offline and when it recovers.
 * 
 * Run on any always-on machine (NOT on the Windows Server itself).
 * 
 * Usage:
 *   1. Edit config.json with your server + email settings
 *   2. npm install
 *   3. npm start
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found. Copy config.example.json and fill in your settings.');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Validate required fields
if (config.server.host === 'YOUR_SERVER_IP' || config.server.apiKey === 'YOUR_API_KEY') {
    console.error('❌ Please update config.json with your actual server host and API key.');
    process.exit(1);
}

// ============================================================
// STATE
// ============================================================
const state = {
    isOnline: null,           // null = unknown, true = online, false = offline
    consecutiveFailures: 0,
    lastAlertSent: null,
    lastCheckTime: null,
    lastOnlineTime: null,
    totalChecks: 0,
    totalDowntime: 0,
    downtimeStart: null,
    history: [],              // last 100 check results
};

// ============================================================
// LOGGING
// ============================================================
const LOG_PATH = path.join(__dirname, config.logging?.file || 'monitor.log');

function log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    
    const colors = {
        INFO: '\x1b[36m',    // Cyan
        OK: '\x1b[32m',      // Green
        WARN: '\x1b[33m',    // Yellow
        ERROR: '\x1b[31m',   // Red
        ALERT: '\x1b[35m',   // Magenta
    };
    
    console.log(`${colors[level] || ''}${line}\x1b[0m`);
    
    // Append to log file
    try {
        const stats = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH) : { size: 0 };
        const maxSize = (config.logging?.maxSizeMB || 10) * 1024 * 1024;
        
        if (stats.size > maxSize) {
            // Rotate log
            const backupPath = LOG_PATH + '.old';
            if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            fs.renameSync(LOG_PATH, backupPath);
        }
        
        fs.appendFileSync(LOG_PATH, line + '\n');
    } catch (e) {
        // Don't crash on log write failure
    }
}

// ============================================================
// HEALTH CHECK
// ============================================================
function checkHealth() {
    return new Promise((resolve) => {
        const timeoutMs = (config.monitoring?.timeoutSeconds || 10) * 1000;
        
        const options = {
            hostname: config.server.host,
            port: config.server.port || 8443,
            path: '/api/health',
            method: 'GET',
            timeout: timeoutMs,
            rejectUnauthorized: false, // Allow self-signed certs
            headers: {
                'X-API-Key': config.server.apiKey,
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.success && json.data?.status === 'healthy') {
                        resolve({
                            online: true,
                            responseTime: Date.now() - startTime,
                            version: json.data.version,
                            agentUptime: json.data.uptime,
                        });
                    } else {
                        resolve({
                            online: false,
                            reason: 'Health check returned unhealthy status',
                            responseTime: Date.now() - startTime,
                        });
                    }
                } catch (e) {
                    resolve({
                        online: false,
                        reason: `Invalid response: ${e.message}`,
                        responseTime: Date.now() - startTime,
                    });
                }
            });
        });

        const startTime = Date.now();

        req.on('error', (err) => {
            resolve({
                online: false,
                reason: err.code === 'ECONNREFUSED' ? 'Connection refused — agent may not be running'
                    : err.code === 'ENOTFOUND' ? 'Host not found — check server address'
                    : err.code === 'ETIMEDOUT' ? 'Connection timed out — server unreachable'
                    : err.code === 'ECONNRESET' ? 'Connection reset — server may have crashed'
                    : `${err.code || err.message}`,
                responseTime: Date.now() - startTime,
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                online: false,
                reason: 'Request timed out',
                responseTime: timeoutMs,
            });
        });

        req.end();
    });
}

// ============================================================
// EMAIL ALERTS
// ============================================================
let transporter = null;

function initEmail() {
    if (!config.email?.enabled) {
        log('INFO', 'Email alerts are disabled in config');
        return false;
    }

    try {
        transporter = nodemailer.createTransport({
            host: config.email.smtp.host,
            port: config.email.smtp.port,
            secure: config.email.smtp.secure,
            auth: config.email.smtp.auth,
        });
        log('INFO', `Email configured via ${config.email.smtp.host}:${config.email.smtp.port}`);
        return true;
    } catch (error) {
        log('ERROR', `Failed to configure email: ${error.message}`);
        return false;
    }
}

async function sendAlert(type, details) {
    if (!transporter || !config.email?.enabled) return;

    // Cooldown check — don't spam
    if (type === 'offline' && state.lastAlertSent) {
        const cooldownMs = (config.monitoring?.cooldownMinutes || 30) * 60 * 1000;
        if (Date.now() - state.lastAlertSent < cooldownMs) {
            log('INFO', `Alert suppressed (cooldown: ${config.monitoring.cooldownMinutes}min)`);
            return;
        }
    }

    const isOffline = type === 'offline';
    const serverLabel = `${config.server.host}:${config.server.port}`;
    const now = new Date();

    const subject = isOffline
        ? `🔴 ALERT: Server ${serverLabel} is OFFLINE`
        : `🟢 RECOVERED: Server ${serverLabel} is back ONLINE`;

    const downtimeDuration = state.downtimeStart 
        ? formatDuration(Date.now() - state.downtimeStart) 
        : 'Unknown';

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: -apple-system, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 0; margin: 0; }
            .container { max-width: 560px; margin: 0 auto; padding: 32px 24px; }
            .header { text-align: center; padding: 24px; border-radius: 12px; margin-bottom: 24px;
                background: ${isOffline ? 'linear-gradient(135deg, #7f1d1d, #991b1b)' : 'linear-gradient(135deg, #064e3b, #065f46)'}; }
            .header h1 { margin: 0; font-size: 22px; color: white; }
            .header .icon { font-size: 48px; margin-bottom: 8px; }
            .card { background: #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 16px; border: 1px solid #334155; }
            .card h3 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; }
            .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1e293b22; }
            .row:last-child { border-bottom: none; }
            .label { color: #94a3b8; font-size: 14px; }
            .value { font-weight: 600; font-size: 14px; color: #f1f5f9; }
            .value.danger { color: #f87171; }
            .value.success { color: #34d399; }
            .footer { text-align: center; font-size: 12px; color: #64748b; margin-top: 24px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="icon">${isOffline ? '🔴' : '🟢'}</div>
                <h1>${isOffline ? 'Server Offline Alert' : 'Server Recovered'}</h1>
            </div>
            <div class="card">
                <h3>Server Details</h3>
                <div class="row"><span class="label">Server</span><span class="value">${serverLabel}</span></div>
                <div class="row"><span class="label">Status</span><span class="value ${isOffline ? 'danger' : 'success'}">${isOffline ? '⬤ OFFLINE' : '⬤ ONLINE'}</span></div>
                <div class="row"><span class="label">Detected At</span><span class="value">${now.toLocaleString()}</span></div>
                ${isOffline 
                    ? `<div class="row"><span class="label">Failed Checks</span><span class="value danger">${state.consecutiveFailures}</span></div>
                       <div class="row"><span class="label">Reason</span><span class="value danger">${details.reason || 'Unknown'}</span></div>
                       <div class="row"><span class="label">Last Online</span><span class="value">${state.lastOnlineTime ? state.lastOnlineTime.toLocaleString() : 'Unknown'}</span></div>`
                    : `<div class="row"><span class="label">Downtime</span><span class="value success">${downtimeDuration}</span></div>
                       <div class="row"><span class="label">Agent Version</span><span class="value">${details.version || '—'}</span></div>`}
            </div>
            <div class="card">
                <h3>Monitoring Stats</h3>
                <div class="row"><span class="label">Total Checks</span><span class="value">${state.totalChecks}</span></div>
                <div class="row"><span class="label">Check Interval</span><span class="value">${config.monitoring.checkIntervalSeconds}s</span></div>
                <div class="row"><span class="label">Failure Threshold</span><span class="value">${config.monitoring.failureThreshold}</span></div>
            </div>
            <div class="footer">
                Sent by ServerPilot Monitor &bull; ${now.toISOString()}
            </div>
        </div>
    </body>
    </html>`;

    try {
        await transporter.sendMail({
            from: config.email.from,
            to: config.email.to.join(', '),
            subject,
            html,
        });
        state.lastAlertSent = Date.now();
        log('ALERT', `${type.toUpperCase()} alert email sent to ${config.email.to.join(', ')}`);
    } catch (error) {
        log('ERROR', `Failed to send email: ${error.message}`);
    }
}

// ============================================================
// MONITORING LOOP
// ============================================================
async function runCheck() {
    state.totalChecks++;
    state.lastCheckTime = new Date();
    
    const result = await checkHealth();
    
    // Store in history (keep last 100)
    state.history.push({
        timestamp: state.lastCheckTime,
        ...result,
    });
    if (state.history.length > 100) state.history.shift();

    if (result.online) {
        // === SERVER IS ONLINE ===
        const wasOffline = state.isOnline === false;
        state.consecutiveFailures = 0;
        state.lastOnlineTime = new Date();

        if (config.logging?.verbose) {
            log('OK', `Server healthy (${result.responseTime}ms, agent v${result.version})`);
        }

        if (wasOffline) {
            log('OK', `✅ SERVER RECOVERED after ${formatDuration(Date.now() - state.downtimeStart)}`);
            
            if (config.email?.sendRecoveryAlerts) {
                await sendAlert('recovered', result);
            }
            
            state.downtimeStart = null;
        }

        state.isOnline = true;

    } else {
        // === SERVER IS OFFLINE ===
        state.consecutiveFailures++;
        
        log('WARN', `Health check failed (${state.consecutiveFailures}/${config.monitoring.failureThreshold}): ${result.reason}`);

        if (state.consecutiveFailures >= config.monitoring.failureThreshold) {
            if (state.isOnline !== false) {
                // Transition from online → offline
                state.isOnline = false;
                state.downtimeStart = Date.now();
                log('ERROR', `🔴 SERVER OFFLINE — ${result.reason}`);
                await sendAlert('offline', result);
            } else {
                // Already offline, maybe re-alert after cooldown
                await sendAlert('offline', result);
            }
        }
    }
}

async function startMonitoring() {
    const interval = (config.monitoring?.checkIntervalSeconds || 60) * 1000;
    const serverLabel = `${config.server.host}:${config.server.port}`;

    console.log('');
    console.log('\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m║       ServerPilot — Uptime Monitor               ║\x1b[0m');
    console.log('\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m');
    console.log('');
    
    log('INFO', `Monitoring server: ${serverLabel}`);
    log('INFO', `Check interval: ${config.monitoring.checkIntervalSeconds}s`);
    log('INFO', `Failure threshold: ${config.monitoring.failureThreshold} consecutive failures`);
    log('INFO', `Alert cooldown: ${config.monitoring.cooldownMinutes} minutes`);
    log('INFO', `Email alerts: ${config.email?.enabled ? 'ENABLED' : 'DISABLED'}`);
    
    if (config.email?.enabled) {
        log('INFO', `Alert recipients: ${config.email.to.join(', ')}`);
    }

    // Verify email on startup
    if (config.email?.enabled && transporter) {
        try {
            await transporter.verify();
            log('OK', 'SMTP connection verified successfully');
        } catch (error) {
            log('ERROR', `SMTP verification failed: ${error.message}`);
            log('WARN', 'Email alerts may not work. Check your SMTP credentials.');
        }
    }

    console.log('');
    log('INFO', 'Starting monitoring loop... (Ctrl+C to stop)');
    console.log('');

    // Initial check
    await runCheck();

    // Continuous monitoring
    setInterval(runCheck, interval);
}

// ============================================================
// UTILITIES
// ============================================================
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGINT', () => {
    console.log('');
    log('INFO', 'Monitor shutting down...');
    log('INFO', `Total checks performed: ${state.totalChecks}`);
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Monitor terminated');
    process.exit(0);
});

// ============================================================
// ENTRY POINT
// ============================================================
initEmail();
startMonitoring().catch((error) => {
    log('ERROR', `Monitor crashed: ${error.message}`);
    process.exit(1);
});
