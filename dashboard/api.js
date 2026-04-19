/**
 * ServerPilot API Client
 * Handles all communication with the Windows Server Agent REST API
 */

class ServerAPI {
    constructor() {
        this.baseUrl = '';
        this.username = '';
        this.password = '';
        this.connected = false;
        this.abortController = null;
    }

    /**
     * Configure the API connection
     */
    configure(host, port, username, password) {
        this.baseUrl = `https://${host}:${port}/api`;
        this.username = username;
        this.password = password;
    }

    /**
     * Make an authenticated API request
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Basic ' + btoa(`${this.username}:${this.password}`),
                    ...options.headers,
                },
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeout);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out. Check if the server is reachable.');
            }
            throw error;
        }
    }

    /**
     * Test the connection to the server
     */
    async testConnection() {
        try {
            const healthResult = await this.request('/health');
            // Also test an authenticated endpoint to ensure credentials are valid
            await this.request('/system/info');
            
            if (healthResult.success) {
                this.connected = true;
                return healthResult.data;
            }
            throw new Error('Health check failed');
        } catch (error) {
            this.connected = false;
            throw error;
        }
    }

    // ==========================================
    // System Endpoints
    // ==========================================

    async getSystemInfo() {
        return this.request('/system/info');
    }

    async getRebootStatus() {
        return this.request('/system/reboot/status');
    }

    async scheduleReboot(delayMinutes = 5, reason = 'Scheduled reboot') {
        return this.request('/system/reboot', {
            method: 'POST',
            body: JSON.stringify({ delay_minutes: delayMinutes, reason }),
        });
    }

    async cancelReboot() {
        return this.request('/system/reboot/cancel', { method: 'POST' });
    }

    async getEvents(logName = 'System', count = 50, level = '') {
        const params = new URLSearchParams({ log: logName, count, level });
        return this.request(`/system/events?${params}`);
    }

    // ==========================================
    // Windows Update Endpoints
    // ==========================================

    async getPendingUpdates() {
        return this.request('/updates/pending');
    }

    async getUpdateHistory(count = 50) {
        return this.request(`/updates/history?count=${count}`);
    }

    async installUpdates(updateIds = []) {
        return this.request('/updates/install', {
            method: 'POST',
            body: JSON.stringify({ update_ids: updateIds }),
        });
    }

    async getUpdateSettings() {
        return this.request('/updates/settings');
    }

    async getUpdateSchedule() {
        return this.request('/updates/schedule');
    }

    async createUpdateSchedule(name, time, frequency = 'Daily') {
        return this.request('/updates/schedule', {
            method: 'POST',
            body: JSON.stringify({ name, time, frequency }),
        });
    }

    // ==========================================
    // Process Endpoints
    // ==========================================

    async getProcesses(filter = '') {
        const params = filter ? `?filter=${encodeURIComponent(filter)}` : '';
        return this.request(`/processes${params}`);
    }

    async startProcess(path, args = '', workingDirectory = '') {
        return this.request('/processes/start', {
            method: 'POST',
            body: JSON.stringify({ path, arguments: args, working_directory: workingDirectory }),
        });
    }

    async stopProcess(pid, force = false) {
        return this.request('/processes/stop', {
            method: 'POST',
            body: JSON.stringify({ pid, force }),
        });
    }

    // ==========================================
    // Service Endpoints
    // ==========================================

    async getServices(filter = '') {
        const params = filter ? `?filter=${encodeURIComponent(filter)}` : '';
        return this.request(`/services${params}`);
    }

    async controlService(name, action) {
        return this.request('/services/action', {
            method: 'POST',
            body: JSON.stringify({ name, action }),
        });
    }

    // ==========================================
    // Certificate Endpoints
    // ==========================================

    async getCertificates(location = 'LocalMachine', store = 'My', expiringDays = 0) {
        const params = new URLSearchParams({
            location,
            store,
            expiring_days: expiringDays
        });
        return this.request(`/certificates?${params}`);
    }

    // ==========================================
    // Local Users Endpoints
    // ==========================================

    async getUsers() {
        return this.request('/users');
    }

    async manageUser(username, action, password = '') {
        return this.request('/users/action', {
            method: 'POST',
            body: JSON.stringify({ username, action, password }),
        });
    }
}

// Singleton instance
const api = new ServerAPI();
