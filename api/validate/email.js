import { EmailValidationService } from '../../src/services/email-validator.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Detailed logging for configuration and connection status
console.log('=============================================');
console.log('EMAIL VALIDATION API STARTUP - OPTIMIZED VERSION');
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
  
  // Timeouts - increased for reliability but staying within Vercel limits
  timeouts: {
    supabase: 6000,      // 6 seconds for Supabase operations
    zeroBounce: 4000,    // 4 seconds for ZeroBounce operations
    validation: 4000,    // 4 seconds for overall validation
  }
};

// Log the configuration (safely)
console.log('API CONFIGURATION:', {
  useZeroBounce: config.useZeroBounce,
  useSupabase: config.useSupabase,
  supabaseUrlSet: !!config.supabase.url,
  supabaseKeyLength: config.supabase.key ? config.supabase.key.length : 0,
  timeouts: config.timeouts,
  clientId: config.clientId,
  umessyVersion: config.umessyVersion
});

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

// Test Supabase connection after a short delay to allow server startup
// In Vercel, we don't want to block cold starts, so we do this in the background
setTimeout(async () => {
  try {
    console.log('STARTUP: Testing Supabase connection (delayed)...');
    await emailValidator._testSupabaseConnectionAsync();
    
    // After the test, get the status
    console.log('SUPABASE CONNECTION STATUS:', emailValidator.supabaseConnectionStatus || 'unknown');
    
    if (emailValidator.supabaseConnectionStatus === 'connected') {
      console.log('✅ SUPABASE CONNECTION SUCCESSFUL: API is ready to use Supabase storage');
    } else {
      console.error('❌ SUPABASE CONNECTION ISSUE: API will operate without persistent storage');
    }
  } catch (error) {
    console.error('STARTUP ERROR:', error);
  }
}, 1000); // 1 second delay

// Optional: Setup for Vercel queue if available
let vercelQueue;
try {
  // Check if Vercel Queue is available
  if (isVercel && process.env.ENABLE_VERCEL_QUEUE === 'true') {
    // This is a dynamic import because the module might not be available
    import('@vercel/functions').then(({ Queue }) => {
      if (Queue) {
        vercelQueue = new Queue('email-validation-tasks');
        console.log('STARTUP: Vercel Queue initialized successfully');
      }
    }).catch(err => {
      console.log('STARTUP: Vercel Queue not available', { error: err.message });
    });
  }
} catch (error) {
  console.log('STARTUP: Error initializing Vercel Queue', { error: error.message });
}

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
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Log request info
    console.log('API REQUEST: Processing email validation', { 
      email,
      timestamp: new Date().toISOString(),
      supabaseStatus: emailValidator.supabaseConnectionStatus || 'unknown'
    });
    
    // First do a quick format check - if invalid, return immediately
    if (!emailValidator.isValidEmailFormat(email)) {
      console.log('VALIDATION: Invalid email format detected');
      
      // Generate unmessy fields for invalid format
      const now = new Date();
      const umCheckId = emailValidator.generateUmCheckId();
      
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
        um_bounce_status: 'Likely to bounce'
      };
      
      // Log the result before returning
      console.log('API RESPONSE: Returning invalid format result', {
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
      }, 8000); // 8 seconds (increased from 5s but still well under Vercel's limit)
    });
    
    try {
      // Quick validation steps (format check, typo correction, domain check)
      // These are fast and synchronous
      const quickResult = emailValidator.performQuickValidation(email);
      
      // Log that we're starting validation
      console.log('VALIDATION: Starting optimized validation process', {
        email,
        supabaseStatus: emailValidator.supabaseConnectionStatus || 'unknown',
        zeroBounceEnabled: config.useZeroBounce,
        hasQueue: !!vercelQueue
      });
      
      // Race between validation and timeout
      // Validation now has split steps that complete faster
      const result = await Promise.race([
        emailValidator.validateEmail(email, { 
          skipZeroBounce: !config.useZeroBounce, 
          timeoutMs: config.timeouts.validation
        }),
        timeoutPromise
      ]);
      
      // Log success and return result
      console.log('API RESPONSE: Validation completed successfully', {
        email,
        status: result.status,
        wasCorrected: result.wasCorrected,
        umEmailStatus: result.um_email_status,
        umBounceStatus: result.um_bounce_status
      });
      
      // If we have a Vercel Queue, queue the background save operation
      // This ensures it completes even if the function has exited
      if (vercelQueue && config.useSupabase) {
        try {
          await vercelQueue.enqueue({
            action: 'saveValidation',
            email: email,
            validationResult: result
          });
          console.log('QUEUE: Successfully queued validation save', { email });
        } catch (queueError) {
          console.error('QUEUE_ERROR: Failed to queue validation save', {
            error: queueError.message,
            email
          });
        }
      }
      
      return res.status(200).json(result);
    } catch (error) {
      // Log the error and fall back to quick validation
      console.error('VALIDATION ERROR: Validation timed out or failed', {
        email,
        error: error.message,
        stack: error.stack?.split('\n')[0]
      });
      
      // Get quick validation result as a fallback
      const quickResult = emailValidator.performQuickValidation(email);
      
      console.log('API RESPONSE: Falling back to quick validation result', {
        email,
        fallbackStatus: quickResult.status
      });
      
      // Still attempt to queue background save for audit trail
      if (vercelQueue && config.useSupabase) {
        try {
          await vercelQueue.enqueue({
            action: 'saveValidation',
            email: email,
            validationResult: quickResult,
            isFallback: true
          });
          console.log('QUEUE: Queued fallback validation save', { email });
        } catch (queueError) {
          console.error('QUEUE_ERROR: Failed to queue fallback save', {
            error: queueError.message
          });
        }
      }
      
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
    
    // Return health status
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: {
        nodeEnv: process.env.NODE_ENV || 'not set',
        isVercel: isVercel,
        vercelRegion: process.env.VERCEL_REGION || 'unknown'
      },
      queue: {
        available: !!vercelQueue,
        enabled: process.env.ENABLE_VERCEL_QUEUE === 'true'
      },
      supabase: {
        status: supabaseStatus,
        enabled: emailValidator.supabaseEnabled,
        url: emailValidator.config.supabase.url ? `${emailValidator.config.supabase.url.substring(0, 15)}...` : 'not set',
        keyPresent: !!emailValidator.config.supabase.key,
        directCheck: directCheckResult
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
}