// api/validate/email.js
import { EmailValidationService } from '../../src/services/email-validator.js';
import { ClientManagerService } from '../../src/services/client-manager.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Detailed logging for configuration and connection status
console.log('=============================================');
console.log('EMAIL VALIDATION API STARTUP - CLIENT AUTH ENABLED');
console.log('=============================================');

// Load configuration with explicit values and defaults
const config = {
  // ZeroBounce settings
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  
  // Email processing settings
  removeGmailAliases: true,
  checkAustralianTlds: true,
  
  // Supabase configuration - explicitly enabled by default
  useSupabase: process.env.USE_SUPABASE !== 'false', // Only disable if explicitly set to 'false'
  supabase: {
    url: process.env.SUPABASE_URL || 'https://noxlrexfrmakvnfqhxfx.supabase.co',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5veGxyZXhmcm1ha3ZuZnFoeGZ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjE1MDc4MywiZXhwIjoyMDYxNzI2NzgzfQ.he2TitvQURi4Un-SOo0kHJjIqJrAaw77ibmfpzkOV3k',
    // Custom Supabase options
    options: {
      auth: { 
        persistSession: false,
        autoRefreshToken: false
      },
      // Add custom fetch with longer timeout
      global: {
        headers: {
          'Content-Type': 'application/json'
        },
        fetch: (...args) => {
          return fetch(...args, {
            // Increase timeout significantly
            signal: AbortSignal.timeout(10000) // 10 seconds timeout
          });
        }
      }
    }
  },
  
  // ID generation settings
  clientId: process.env.CLIENT_ID || '00001',
  umessyVersion: process.env.UMESSY_VERSION || '100',
  
  // Timeouts - increased but staying within Vercel limits
  timeouts: {
    supabase: 8000,       // 8 seconds for Supabase operations 
    zeroBounce: 4000,     // 4 seconds for ZeroBounce operations
    validation: 7000,     // 7 seconds for overall validation
  }
};

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

// Initialize the client manager service
const clientManager = new ClientManagerService();

// Main API handler function
export default async function handler(req, res) {
  // Health check endpoint
  if (req.url && req.url.endsWith('/health')) {
    return healthCheck(req, res);
  }
  
  // Client stats endpoint
  if (req.url && req.url.endsWith('/stats')) {
    return statsHandler(req, res);
  }
  
  // Only allow POST method for the main endpoint
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get the API key from the request headers
    const apiKey = req.headers['x-api-key'];
    
    // Validate the API key
    const { valid, client, reason } = clientManager.validateApiKey(apiKey);
    
    if (!valid) {
      console.log('API REQUEST: Invalid API key', { reason });
      return res.status(401).json({ 
        error: 'Unauthorized',
        reason: reason
      });
    }
    
    // Check email rate limit for this client
    const { limited, remaining, emailCount, emailLimit } = clientManager.checkEmailRateLimit(client.clientId);
    
    if (limited) {
      console.log('API REQUEST: Email rate limit exceeded', { 
        clientId: client.clientId,
        emailCount,
        emailLimit
      });
      
      return res.status(429).json({
        error: 'Email rate limit exceeded',
        dailyLimit: emailLimit,
        used: emailCount,
        remaining: 0,
        resetIn: getTimeUntilMidnight()
      });
    }
    
    // Extract email from request body
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Log request info
    console.log('API REQUEST: Processing email validation', { 
      clientId: client.clientId,
      email,
      timestamp: new Date().toISOString()
    });
    
    // Quick invalid format check
    if (!emailValidator.isValidEmailFormat(email)) {
      console.log('VALIDATION: Invalid email format detected');
      
      // Generate unmessy fields for invalid format
      const now = new Date();
      const umCheckId = emailValidator.generateUmCheckId();
      
      // Increment email count for this client
      clientManager.incrementEmailCount(client.clientId);
      
      const result = {
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        // Add unmessy specific fields
        date_last_um_check: now.toISOString(),
        date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
        um_check_id: umCheckId,
        um_email: email,
        email: email,
        um_email_status: 'Unable to change',
        um_bounce_status: 'Likely to bounce',
        // Add client usage info
        client: {
          id: client.clientId,
          emailLimit,
          emailCount: emailCount + 1,
          remaining: remaining - 1
        }
      };
      
      // Log the result before returning
      console.log('API RESPONSE: Returning invalid format result', {
        clientId: client.clientId,
        email,
        status: result.status,
        subStatus: result.subStatus
      });
      
      return res.status(200).json(result);
    }
    
    // Set a strict global timeout to ensure we respond before Vercel's timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 9000); // 9 seconds (just under Vercel's 10-second limit)
    });
    
    try {
      // Log that we're starting validation
      console.log('VALIDATION: Starting validation process', {
        clientId: client.clientId,
        email,
        zeroBounceEnabled: config.useZeroBounce
      });
      
      // Race between validation and timeout
      const result = await Promise.race([
        emailValidator.validateEmail(email, { 
          skipZeroBounce: !config.useZeroBounce, 
          timeoutMs: config.timeouts.validation
        }),
        timeoutPromise
      ]);
      
      // Increment email count for this client
      clientManager.incrementEmailCount(client.clientId);
      
      // Get updated usage info
      const { limited, remaining, emailCount, emailLimit } = clientManager.checkEmailRateLimit(client.clientId);
      
      // Add client info to the result
      result.client = {
        id: client.clientId,
        emailLimit,
        emailCount,
        remaining
      };
      
      // Log success and return result
      console.log('API RESPONSE: Validation completed successfully', {
        clientId: client.clientId,
        email,
        status: result.status,
        wasCorrected: result.wasCorrected,
        umEmailStatus: result.um_email_status,
        umBounceStatus: result.um_bounce_status
      });
      
      return res.status(200).json(result);
    } catch (error) {
      // Log the error and fall back to quick validation
      console.error('VALIDATION ERROR: Validation timed out or failed', {
        clientId: client.clientId,
        email,
        error: error.message,
        stack: error.stack?.split('\n')[0]
      });
      
      // Increment email count for this client
      clientManager.incrementEmailCount(client.clientId);
      
      // Get quick validation result as a fallback
      const quickResult = emailValidator.quickValidate(email);
      
      // Get updated usage info
      const { limited, remaining, emailCount, emailLimit } = clientManager.checkEmailRateLimit(client.clientId);
      
      // Add client info to the result
      quickResult.client = {
        id: client.clientId,
        emailLimit,
        emailCount,
        remaining
      };
      
      console.log('API RESPONSE: Falling back to quick validation result', {
        clientId: client.clientId,
        email,
        fallbackStatus: quickResult.status
      });
      
      return res.status(200).json(quickResult);
    }
  } catch (error) {
    // Log the fatal error
    console.error('FATAL API ERROR:', {
      message: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      error: 'Error validating email',
      details: error.message
    });
  }
}

// Health check endpoint implementation
async function healthCheck(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get clients stats
    const clientsStats = clientManager.listClientsStats();
    
    // Return health status
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.1.0',
      environment: {
        nodeEnv: process.env.NODE_ENV || 'not set',
        isVercel: !!process.env.VERCEL || !!process.env.VERCEL_URL,
        vercelRegion: process.env.VERCEL_REGION || 'unknown'
      },
      clientsCount: clientsStats.length,
      supabaseEnabled: emailValidator.supabaseEnabled
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
}

// Stats handler implementation
async function statsHandler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get API key from headers
    const apiKey = req.headers['x-api-key'];
    
    // Check if this is an admin key
    const isAdmin = apiKey === process.env.ADMIN_API_KEY;
    
    // If not admin, validate the API key
    let clientId = null;
    if (!isAdmin) {
      const { valid, client, reason } = clientManager.validateApiKey(apiKey);
      
      if (!valid) {
        return res.status(401).json({ 
          error: 'Unauthorized',
          reason: reason
        });
      }
      
      clientId = client.clientId;
    }
    
    // If admin, show all clients stats
    if (isAdmin) {
      const clientsStats = clientManager.listClientsStats();
      
      return res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        clientsCount: clientsStats.length,
        clients: clientsStats
      });
    }
    
    // Otherwise, show only this client's stats
    const clientStats = clientManager.getClientStats(clientId);
    
    if (!clientStats.found) {
      return res.status(404).json({
        error: 'Client not found'
      });
    }
    
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      client: clientStats
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
}

// Helper function to get time until midnight
function getTimeUntilMidnight() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const diffMs = tomorrow - now;
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  return `${diffHrs}h ${diffMins}m`;
}