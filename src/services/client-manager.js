// src/services/client-manager.js

export class ClientManagerService {
    constructor() {
      // In-memory storage for tracking client usage
      this.clientsUsage = new Map();
      
      // Load client data from environment variables
      this.clients = this.loadClientsFromEnv();
      
      console.log(`CLIENT_MANAGER_INIT: Loaded ${this.clients.size} clients from environment variables`);
    }
    
    // Load all client information from environment variables
    loadClientsFromEnv() {
      const clients = new Map();
      
      try {
        // Get all environment variables
        const envVars = Object.keys(process.env);
        
        // Find all client IDs from environment variables (CLIENT_1_ID, CLIENT_2_ID, etc.)
        const clientIdKeys = envVars.filter(key => /^CLIENT_\d+_ID$/.test(key));
        
        console.log(`CLIENT_MANAGER_INIT: Found ${clientIdKeys.length} potential clients in environment variables`);
        
        for (const idKey of clientIdKeys) {
          // Extract the client number (1, 2, etc.)
          const clientNum = idKey.match(/^CLIENT_(\d+)_ID$/)[1];
          
          const keyKey = `CLIENT_${clientNum}_KEY`;
          const emailLimitKey = `CLIENT_${clientNum}_EMAIL_LIMIT`;
          const nameKey = `CLIENT_${clientNum}_NAME`;
          
          if (process.env[idKey] && process.env[keyKey]) {
            const clientId = process.env[idKey];
            const apiKey = process.env[keyKey];
            const dailyEmailLimit = parseInt(process.env[emailLimitKey] || '10000', 10);
            const name = process.env[nameKey] || `Client ${clientNum}`;
            
            clients.set(apiKey, {
              clientId,
              apiKey,
              dailyEmailLimit,
              name
            });
            
            // Initialize usage tracking for this client
            this.resetClientUsageIfNewDay(clientId);
            
            console.log(`CLIENT_MANAGER_INIT: Loaded client ${clientId} (${name}) with ${dailyEmailLimit} daily email limit`);
          }
        }
      } catch (error) {
        console.error('CLIENT_MANAGER_ENV_ERROR:', {
          message: error.message,
          stack: error.stack
        });
      }
      
      return clients;
    }
    
    // Validate API key against stored client credentials
    validateApiKey(apiKey) {
      if (!apiKey) {
        console.log('CLIENT_MANAGER: Missing API key');
        return { valid: false, reason: 'missing_api_key' };
      }
      
      // Check if API key exists in our clients map
      if (this.clients.has(apiKey)) {
        const client = this.clients.get(apiKey);
        console.log(`CLIENT_MANAGER: API key ${apiKey.substring(0, 8)}... found for client ${client.clientId}`);
        return { valid: true, client };
      }
      
      // If we reach here, the API key is invalid
      console.log(`CLIENT_MANAGER: API key ${apiKey.substring(0, 8)}... not found`);
      return { valid: false, reason: 'invalid_api_key' };
    }
    
    // Reset client usage counter if it's a new day
    resetClientUsageIfNewDay(clientId) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
      
      // Initialize usage object for this client if it doesn't exist
      if (!this.clientsUsage.has(clientId)) {
        this.clientsUsage.set(clientId, {
          date: today,
          emailCount: 0
        });
        return;
      }
      
      // Reset count if it's a new day
      const usage = this.clientsUsage.get(clientId);
      if (usage.date !== today) {
        this.clientsUsage.set(clientId, {
          date: today,
          emailCount: 0
        });
      }
    }
    
    // Check if client has exceeded daily email limit
    checkEmailRateLimit(clientId) {
      // Make sure we're tracking the right day
      this.resetClientUsageIfNewDay(clientId);
      
      // Get client's limit
      let emailLimit = 10000; // Default limit
      for (const [apiKey, client] of this.clients.entries()) {
        if (client.clientId === clientId) {
          emailLimit = client.dailyEmailLimit;
          break;
        }
      }
      
      // Get current usage
      const usage = this.clientsUsage.get(clientId);
      if (!usage) {
        // This shouldn't happen, but just in case
        this.resetClientUsageIfNewDay(clientId);
        return { limited: false, remaining: emailLimit, emailCount: 0, emailLimit };
      }
      
      // Check if limit is exceeded
      if (usage.emailCount >= emailLimit) {
        console.log(`CLIENT_MANAGER: Client ${clientId} has exceeded email limit (${usage.emailCount}/${emailLimit})`);
        return { limited: true, remaining: 0, emailCount: usage.emailCount, emailLimit };
      }
      
      console.log(`CLIENT_MANAGER: Client ${clientId} has ${emailLimit - usage.emailCount} emails remaining`);
      return { limited: false, remaining: emailLimit - usage.emailCount, emailCount: usage.emailCount, emailLimit };
    }
    
    // Increment email count for a client
    incrementEmailCount(clientId) {
      // Make sure we're tracking the right day
      this.resetClientUsageIfNewDay(clientId);
      
      // Get current usage
      const usage = this.clientsUsage.get(clientId);
      
      // Increment count
      usage.emailCount++;
      this.clientsUsage.set(clientId, usage);
      
      console.log(`CLIENT_MANAGER: Incremented email count for client ${clientId} to ${usage.emailCount}`);
      return usage.emailCount;
    }
    
    // Get usage statistics for a client
    getClientStats(clientId) {
      // Make sure we're tracking the right day
      this.resetClientUsageIfNewDay(clientId);
      
      // Get client's limit
      let client = null;
      for (const [apiKey, c] of this.clients.entries()) {
        if (c.clientId === clientId) {
          client = c;
          break;
        }
      }
      
      if (!client) {
        return { found: false };
      }
      
      // Get current usage
      const usage = this.clientsUsage.get(clientId);
      
      return {
        found: true,
        clientId,
        name: client.name,
        dailyEmailLimit: client.dailyEmailLimit,
        usage: {
          date: usage.date,
          emailCount: usage.emailCount,
          remaining: client.dailyEmailLimit - usage.emailCount
        }
      };
    }
    
    // List all clients and their usage
    listClientsStats() {
      const stats = [];
      
      for (const [apiKey, client] of this.clients.entries()) {
        // Make sure we're tracking the right day
        this.resetClientUsageIfNewDay(client.clientId);
        
        // Get current usage
        const usage = this.clientsUsage.get(client.clientId);
        
        stats.push({
          clientId: client.clientId,
          name: client.name,
          apiKey: `${apiKey.substring(0, 8)}...`,
          dailyEmailLimit: client.dailyEmailLimit,
          usage: {
            date: usage.date,
            emailCount: usage.emailCount,
            remaining: client.dailyEmailLimit - usage.emailCount
          }
        });
      }
      
      return stats;
    }
  }