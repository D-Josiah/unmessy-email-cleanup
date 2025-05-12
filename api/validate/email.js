// api/email.js
import { EmailValidationService } from '../../src/services/email-validator.js';
import { ClientManagerService } from '../../src/services/client-manager.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Detailed logging for configuration and connection status
console.log('=============================================');
console.log('EMAIL VALIDATION API STARTUP - SECURED VERSION');
console.log('=============================================');

// Log environment variables (safely)
console.log('ENVIRONMENT VARIABLES CHECK:', {
  supabaseUrlSet: !!process.env.SUPABASE_URL,
  supabaseKeySet: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  useSupabaseSet: process.env.USE_SUPABASE,
  zeroBounceKeySet: !!process.env.ZERO_BOUNCE_API_KEY,
  useZeroBounceSet: process.env.USE_ZERO_BOUNCE,
  clientIdSet: !!process.env.CLIENT_ID,
  umessyVersionSet: !!process.env.UMESSY_VERSION,
  nodeEnv: process.env.NODE_ENV || 'not set'
});

// Determine if we're running in Vercel
const isVercel = !!process.env.VERCEL || !!process.env.VERCEL_URL;
console.log('RUNTIME ENVIRONMENT:', {
  isVercel,
  vercelRegion: process.env.VERCEL_REGION || 'unknown',
  platform: process.platform,
  nodeVersion: process.version
});

// Load configuration with explicit values and defaults
// UPDATED: Added ZeroBounce retry settings and increased timeouts
const config = {
  // ZeroBounce settings
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  zeroBounceMaxRetries: parseInt(process.env.ZERO_BOUNCE_MAX_RETRIES || '1', 10),
  
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
  
  // UPDATED: Timeouts - increased with additional ZeroBounce retry timeout
  timeouts: {
    supabase: 8000,             // 8 seconds for Supabase operations 
    zeroBounce: 6000,           // 6 seconds for ZeroBounce operations (up from 4000)
    zeroBounceRetry: 8000,      // 8 seconds for ZeroBounce retry operations (new)
    validation: 10000,          // 10 seconds for overall validation (up from 7000)
  }
};

// Log the configuration (safely)
console.log('API CONFIGURATION:', {
  useZeroBounce: config.useZeroBounce,
  zeroBounceMaxRetries: config.zeroBounceMaxRetries,
  useSupabase: config.useSupabase,
  supabaseUrlSet: !!config.supabase.url,
  supabaseKeyLength: config.supabase.key ? config.supabase.key.length : 0,
  timeouts: config.timeouts,
  clientId: config.clientId,
  umessyVersion: config.umessyVersion
});

// Initialize the client manager service
const clientManager = new ClientManagerService();

// Log loaded clients
console.log(`CLIENT MANAGER: Loaded ${clientManager.clients.size} client API keys`);

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

// Test Supabase connection immediately to ensure it's available for the first request
// The connection test has been improved to be more reliable
(async () => {
  try {
    console.log('STARTUP: Testing Supabase connection...');
    await emailValidator._testSupabaseConnectionAsync();
    
    // After the test, get the status
    console.log('SUPABASE CONNECTION STATUS:', emailValidator.supabaseConnectionStatus || 'unknown');
    
    if (emailValidator.supabaseConnectionStatus === 'connected') {
      console.log('✅ SUPABASE CONNECTION SUCCESSFUL: API is ready to use Supabase storage');
    } else {
      console.error('❌ SUPABASE CONNECTION ISSUE: API will operate without persistent storage');
      
      // Try one more time after a short delay
      setTimeout(async () => {
        try {
          console.log('STARTUP: Retrying Supabase connection test...');
          await emailValidator._testSupabaseConnectionAsync();
          
          if (emailValidator.supabaseConnectionStatus === 'connected') {
            console.log('✅ SUPABASE CONNECTION SUCCESSFUL ON RETRY: API is now ready for storage');
          }
        } catch (retryError) {
          console.error('STARTUP RETRY ERROR:', retryError);
        }
      }, 2000); // 2 second delay before retry
    }
  } catch (error) {
    console.error('STARTUP ERROR:', error);
  }
})();

// Main API handler function
export default async function handler(req, res) {
  // Health check endpoint
  if (req.url && req.url.endsWith('/health')) {
    return healthCheck(req, res);
  }
  
  // Only allow POST method for the main endpoint
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get API key from request
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    // Validate API key
    const keyValidation = clientManager.validateApiKey(apiKey);
    
    if (!keyValidation.valid) {
      console.log('API REQUEST: Invalid API key', { 
        apiKey: apiKey ? `${apiKey.substring(0, 8)}...` : 'missing',
        reason: keyValidation.reason
      });
      
      return res.status(401).json({ 
        error: 'Unauthorized', 
        reason: keyValidation.reason === 'missing_api_key' ? 'API key is required' : 'Invalid API key'
      });
    }
    
    // Get client details from validation result
    const client = keyValidation.client;
    
    // Check rate limit
    const limitCheck = clientManager.checkEmailRateLimit(client.clientId);
    
    if (limitCheck.limited) {
      console.log('API REQUEST: Rate limit exceeded', {
        clientId: client.clientId,
        clientName: client.name,
        emailCount: limitCheck.emailCount,
        emailLimit: limitCheck.emailLimit
      });
      
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: limitCheck.emailLimit,
        used: limitCheck.emailCount,
        remaining: limitCheck.remaining
      });
    }
    
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Log request info with client details
    console.log('API REQUEST: Processing email validation', { 
      clientId: client.clientId,
      clientName: client.name,
      email,
      timestamp: new Date().toISOString(),
      supabaseStatus: emailValidator.supabaseConnectionStatus || 'unknown'
    });
    
    // Quick invalid format check
    if (!emailValidator.isValidEmailFormat(email)) {
      console.log('VALIDATION: Invalid email format detected');
      
      // UPDATED: Generate unmessy fields for invalid format with new date format and millisecond epoch
      const now = new Date();
      const formattedDate = emailValidator.formatDateString(now);
      const epochTimeMs = now.getTime(); // Use milliseconds for uniqueness
      const umCheckId = emailValidator.generateUmCheckId(client.clientId);
      
      const result = {
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        // Add unmessy specific fields with updated formats
        date_last_um_check: formattedDate,
        date_last_um_check_epoch: epochTimeMs,
        um_check_id: umCheckId,
        um_email: email,
        email: email,
        um_email_status: 'Unable to change',
        um_bounce_status: 'Likely to bounce'
      };
      
      // Increment the client's email count even for invalid emails
      clientManager.incrementEmailCount(client.clientId);
      
      // Get client stats for the response
      const clientStats = clientManager.getClientStats(client.clientId);
      
      // Add client information to the result
      const responseWithClientInfo = {
        ...result,
        client: {
          id: client.clientId,
          name: client.name,
          emailCount: clientStats.usage.emailCount,
          emailLimit: client.dailyEmailLimit,
          remaining: client.dailyEmailLimit - clientStats.usage.emailCount
        }
      };
      
      // Log the result before returning
      console.log('API RESPONSE: Returning invalid format result', {
        clientId: client.clientId,
        email,
        status: result.status,
        subStatus: result.subStatus
      });
      
      return res.status(200).json(responseWithClientInfo);
    }
    
    // UPDATED: Set a strict global timeout to ensure we respond before Vercel's timeout
    // Increased from 9000 to 9500 to accommodate retries
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 9500); // 9.5 seconds (just under Vercel's 10-second limit)
    });
    
    try {
      // Log that we're starting validation
      console.log('VALIDATION: Starting validation process', {
        clientId: client.clientId,
        email,
        supabaseStatus: emailValidator.supabaseConnectionStatus || 'unknown',
        zeroBounceEnabled: config.useZeroBounce
      });
      
      // Race between validation and timeout
      // NOTE: The updated validateEmail method now saves data synchronously
      const result = await Promise.race([
        emailValidator.validateEmail(email, { 
          skipZeroBounce: !config.useZeroBounce, 
          timeoutMs: config.timeouts.validation,
          clientId: client.clientId // Pass client ID to the validation service
        }),
        timeoutPromise
      ]);
      
      // Increment the client's email count for successful validation
      clientManager.incrementEmailCount(client.clientId);
      
      // Get client stats for the response
      const clientStats = clientManager.getClientStats(client.clientId);
      
      // Add client information to the result
      const responseWithClientInfo = {
        ...result,
        client: {
          id: client.clientId,
          name: client.name,
          emailCount: clientStats.usage.emailCount,
          emailLimit: client.dailyEmailLimit,
          remaining: client.dailyEmailLimit - clientStats.usage.emailCount
        }
      };
      
      // Log success and return result
      console.log('API RESPONSE: Validation completed successfully', {
        clientId: client.clientId,
        email,
        status: result.status,
        wasCorrected: result.wasCorrected,
        umEmailStatus: result.um_email_status,
        umBounceStatus: result.um_bounce_status,
        usageStats: {
          count: clientStats.usage.emailCount,
          limit: client.dailyEmailLimit,
          remaining: client.dailyEmailLimit - clientStats.usage.emailCount
        }
      });
      
      return res.status(200).json(responseWithClientInfo);
    } catch (error) {
      // Log the error and fall back to quick validation
      console.error('VALIDATION ERROR: Validation timed out or failed', {
        clientId: client.clientId,
        email,
        error: error.message,
        stack: error.stack?.split('\n')[0]
      });
      
      // UPDATED: Get quick validation result as a fallback with new date format
      const quickResult = await emailValidator.quickValidate(email, client.clientId);
      
      // Increment the client's email count even for fallback results
      clientManager.incrementEmailCount(client.clientId);
      
      // Get client stats for the response
      const clientStats = clientManager.getClientStats(client.clientId);
      
      // Add client information to the result
      const responseWithClientInfo = {
        ...quickResult,
        client: {
          id: client.clientId,
          name: client.name,
          emailCount: clientStats.usage.emailCount,
          emailLimit: client.dailyEmailLimit,
          remaining: client.dailyEmailLimit - clientStats.usage.emailCount
        }
      };
      
      console.log('API RESPONSE: Falling back to quick validation result', {
        clientId: client.clientId,
        email,
        fallbackStatus: quickResult.status,
        usageStats: {
          count: clientStats.usage.emailCount,
          limit: client.dailyEmailLimit,
          remaining: client.dailyEmailLimit - clientStats.usage.emailCount
        }
      });
      
      return res.status(200).json(responseWithClientInfo);
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

// Health check endpoint implementation with added client stats
async function healthCheck(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Check Supabase connection
    let supabaseStatus = emailValidator.supabaseConnectionStatus || 'unknown';
    let directCheckResult = null;
    
    // If connection status is not connected, try a direct check
    if (supabaseStatus !== 'connected' && emailValidator.supabase) {
      try {
        const { data, error: queryError } = await emailValidator.supabase
          .from('contacts')
          .select('count(*)', { count: 'exact', head: true });
          
        if (queryError) {
          directCheckResult = {
            status: 'error',
            error: queryError.message,
            code: queryError.code
          };
        } else {
          directCheckResult = {
            status: 'success',
            data
          };
          // Update status if direct check succeeded
          supabaseStatus = 'connected_direct';
        }
      } catch (e) {
        directCheckResult = {
          status: 'exception',
          error: e.message
        };
      }
    }
    
    // Get client statistics - redacted for health check
    const clientStats = clientManager.listClientsStats().map(client => ({
      clientId: client.clientId,
      name: client.name,
      dailyEmailLimit: client.dailyEmailLimit,
      usage: {
        date: client.usage.date,
        emailCount: client.usage.emailCount,
        remaining: client.usage.remaining
      }
    }));
    
    // Return health status with ZeroBounce retry settings
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: {
        nodeEnv: process.env.NODE_ENV || 'not set',
        isVercel: isVercel,
        vercelRegion: process.env.VERCEL_REGION || 'unknown'
      },
      supabase: {
        status: supabaseStatus,
        enabled: emailValidator.supabaseEnabled,
        url: emailValidator.config.supabase.url ? `${emailValidator.config.supabase.url.substring(0, 15)}...` : 'not set',
        keyPresent: !!emailValidator.config.supabase.key,
        directCheck: directCheckResult
      },
      zeroBounce: {
        enabled: config.useZeroBounce,
        maxRetries: config.zeroBounceMaxRetries,
        timeouts: {
          initial: config.timeouts.zeroBounce,
          retry: config.timeouts.zeroBounceRetry
        }
      },
      clients: {
        count: clientManager.clients.size,
        stats: clientStats
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
}