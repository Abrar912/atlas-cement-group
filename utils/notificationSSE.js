/**
 * Server-Sent Events (SSE) Notification Manager
 * Manages SSE connections for real-time notification delivery
 */

class NotificationSSEManager {
    constructor() {
        // Map: sessionID -> Set of response objects (allow multiple tabs per session)
        this.connections = new Map();
        
        // Map: connectionID -> { sessionID, username, role, response }
        this.connectionDetails = new Map();
        
        // Track received notification IDs per session to prevent duplicates
        this.receivedNotifications = new Map(); // sessionID -> Set of notification IDs
        
        // Counter for generating unique connection IDs
        this.connectionCounter = 0;
    }

    /**
     * Add a new SSE connection
     * @param {string} sessionID - Unique session identifier
     * @param {Object} response - Express response object
     * @param {string} username - Authenticated username
     * @param {string} role - User role (admin/worker)
     * @returns {string} Unique connection ID
     */
    addConnection(sessionID, response, username, role) {
        // Generate unique connection ID for this specific connection
        const connectionId = `conn_${this.connectionCounter++}`;
        
        // Add to session's connection set (allow multiple connections per session)
        if (!this.connections.has(sessionID)) {
            this.connections.set(sessionID, new Set());
        }
        this.connections.get(sessionID).add(response);
        
        // Store connection details
        this.connectionDetails.set(connectionId, {
            sessionID,
            username,
            role,
            response
        });
        
        // Initialize received notifications tracking for this session
        if (!this.receivedNotifications.has(sessionID)) {
            this.receivedNotifications.set(sessionID, new Set());
        }
        
        console.log(`[SSE] Connection added: ${connectionId} for ${username} (${role}), session: ${sessionID}`);
        return connectionId;
    }

    /**
     * Remove an SSE connection
     * @param {string} sessionID - Session identifier
     * @param {Object} response - Response object to remove (optional, removes all if not provided)
     */
    removeConnection(sessionID, response = null) {
        if (!this.connections.has(sessionID)) {
            return;
        }
        
        const connectionSet = this.connections.get(sessionID);
        
        if (response) {
            // Remove specific connection
            connectionSet.delete(response);
            if (connectionSet.size === 0) {
                this.connections.delete(sessionID);
                this.receivedNotifications.delete(sessionID);
            }
        } else {
            // Remove all connections for this session
            connectionSet.forEach(res => {
                if (res && !res.writableEnded) {
                    res.end();
                }
            });
            this.connections.delete(sessionID);
            this.receivedNotifications.delete(sessionID);
        }
        
        console.log(`[SSE] Connection(s) removed for session: ${sessionID}`);
    }

    /**
     * Get all connections for a specific user
     * @param {string} username - Username to find connections for
     * @param {string} role - User role
     * @returns {Array} Array of response objects
     */
    getConnectionsForUser(username, role) {
        const connections = [];
        
        for (const [sessionID, connectionSet] of this.connections.entries()) {
            for (const response of connectionSet) {
                // Find connection details for this response
                for (const [connId, details] of this.connectionDetails.entries()) {
                    if (details.response === response && details.username === username && details.role === role) {
                        connections.push(response);
                        break;
                    }
                }
            }
        }
        
        return connections;
    }

    /**
     * Get all connections for admin users
     * @returns {Array} Array of response objects
     */
    getAdminConnections() {
        const connections = [];
        
        console.log('[SSE DEBUG] getAdminConnections called');
        console.log('[SSE DEBUG] Total sessions:', this.connections.size);
        
        for (const [sessionID, connectionSet] of this.connections.entries()) {
            console.log(`[SSE DEBUG] Session ${sessionID} has ${connectionSet.size} connections`);
            for (const response of connectionSet) {
                for (const [connId, details] of this.connectionDetails.entries()) {
                    if (details.response === response && details.role === 'admin') {
                        console.log(`[SSE DEBUG] Found admin connection: ${connId} for user ${details.username}`);
                        connections.push(response);
                        break;
                    }
                }
            }
        }
        
        console.log(`[SSE DEBUG] Returning ${connections.length} admin connections`);
        return connections;
    }

    /**
     * Get all connections for a specific worker
     * @param {string} username - Worker username
     * @returns {Array} Array of response objects
     */
    getWorkerConnections(username) {
        const connections = [];
        
        for (const [sessionID, connectionSet] of this.connections.entries()) {
            for (const response of connectionSet) {
                for (const [connId, details] of this.connectionDetails.entries()) {
                    if (details.response === response && details.role === 'worker' && details.username === username) {
                        connections.push(response);
                        break;
                    }
                }
            }
        }
        
        return connections;
    }

    /**
     * Broadcast a notification to appropriate recipients
     * @param {Object} notification - Notification object from database
     */
    broadcast(notification) {
        const recipient = notification.recipient;
        const type = notification.type;
        const message = notification.message;
        const id = notification.id;

        console.log(`[SSE DEBUG] Broadcasting notification ${id} to recipient: ${recipient}`);
        console.log(`[SSE DEBUG] Notification type: ${type}`);
        console.log(`[SSE DEBUG] Notification message: ${message}`);

        let targetConnections = [];

        // Determine target connections based on recipient
        if (recipient === 'admin' || recipient === null || recipient === 'all_admins') {
            // Send to all admin connections
            console.log('[SSE DEBUG] Target: all admin connections');
            targetConnections = this.getAdminConnections();
        } else if (recipient === 'all_workers') {
            // Send to all worker connections
            console.log('[SSE DEBUG] Target: all worker connections');
            for (const [sessionID, connectionSet] of this.connections.entries()) {
                for (const response of connectionSet) {
                    for (const [connId, details] of this.connectionDetails.entries()) {
                        if (details.response === response && details.role === 'worker') {
                            targetConnections.push(response);
                            break;
                        }
                    }
                }
            }
        } else {
            // Send to specific user (could be admin or worker)
            console.log('[SSE DEBUG] Target: specific user:', recipient);
            targetConnections = this.getConnectionsForUser(recipient, 'admin');
            if (targetConnections.length === 0) {
                targetConnections = this.getWorkerConnections(recipient);
            }
        }

        console.log(`[SSE DEBUG] Found ${targetConnections.length} target connections`);

        // Send notification to all target connections
        let sentCount = 0;
        targetConnections.forEach(response => {
            if (response && !response.writableEnded) {
                try {
                    const data = JSON.stringify(notification);
                    response.write(`data: ${data}\n\n`);
                    sentCount++;
                    console.log(`[SSE DEBUG] Sent notification ${id} to one connection`);
                } catch (error) {
                    console.error(`[SSE DEBUG] Error sending notification:`, error);
                }
            } else {
                console.log('[SSE DEBUG] Skipped closed/ended connection');
            }
        });

        console.log(`[SSE DEBUG] Notification ${id} sent to ${sentCount} connections`);
    }

    /**
     * Get connection statistics
     * @returns {Object} Statistics about active connections
     */
    getStats() {
        let adminCount = 0;
        let workerCount = 0;
        
        for (const [sessionID, connection] of this.connections.entries()) {
            if (connection.role === 'admin') {
                adminCount++;
            } else if (connection.role === 'worker') {
                workerCount++;
            }
        }
        
        return {
            total: this.connections.size,
            admin: adminCount,
            worker: workerCount
        };
    }

    /**
     * Clean up stale connections
     * Call this periodically to remove dead connections
     */
    cleanupStaleConnections() {
        for (const [sessionID, connectionSet] of this.connections.entries()) {
            const deadConnections = [];
            connectionSet.forEach(response => {
                if (response && response.writableEnded) {
                    deadConnections.push(response);
                }
            });
            
            deadConnections.forEach(response => {
                connectionSet.delete(response);
                // Clean up connection details
                for (const [connId, details] of this.connectionDetails.entries()) {
                    if (details.response === response) {
                        this.connectionDetails.delete(connId);
                        break;
                    }
                }
            });
            
            if (connectionSet.size === 0) {
                this.connections.delete(sessionID);
                this.receivedNotifications.delete(sessionID);
            }
        }
    }
}

// Export singleton instance
const notificationSSE = new NotificationSSEManager();

module.exports = notificationSSE;
