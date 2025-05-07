import { EmailValidationService } from '../../src/services/email-validator.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Detailed logging for configuration and connection status
console.log('=============================================');
console.log('EMAIL VALIDATION API STARTUP');
console.log('=============================================');

// Log environment variables (safely)
console.log('ENVIRONMENT VARIABLES CHECK:', {
  supabaseUrlSet: !!process.env.SUPABASE_URL,
  supabaseKeySet: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  useSupabaseSet: process.env.USE_SUPABASE,
  zeroBounceKeySet: !!process.env.ZERO_BOUNCE_API_KEY,
  useZeroBounceSet: process.env.USE_ZERO_BOUNCE,
  clientIdSet: !!process.env.CLIENT_ID,
  umessyVersionSet: !!process.env.UMESSY_VERSION
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
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5veGxyZXhmcm1ha3ZuZnFoeGZ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjE1MDc4MywiZXhwIjoyMDYxNzI2NzgzfQ.he2TitvQURi4Un-SOo0kHJjIqJrAaw77ibmfpzkOV3k'
  },
  
  // ID generation settings
  clientId: process.env.CLIENT_ID || '00001',
  umessyVersion: process.env.UMESSY_VERSION || '100',
  
  // Timeouts - adjusted for reliability
  timeouts: {
    supabase: 2000,       // 2 seconds for Supabase operations
    zeroBounce: 3000,     // 3 seconds for ZeroBounce operations
    validation: 4000,     // 4 seconds for overall validation
  }
};

// Log the configuration (safely)
console.log('API CONFIGURATION:', {
  useZeroBounce: config.useZeroBounce,
  useSupabase: config.useSupabase,
  supabaseUrlSet: !!config.supabase.url,
  supabaseKeyLength: config.supabase.key ? config.supabase.key.length : 0,
  clientId: config.clientId,
  umessyVersion: config.umessyVersion,
  timeouts: config.timeouts
});

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

// Test Supabase connection immediately and log result
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
    }
  } catch (error) {
    console.error('STARTUP ERROR:', error);
  }
})();

export default async function handler(req, res) {
  // Only allow POST method
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
    
    // Set a strict global timeout to ensure we respond before Vercel's timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 5000); // 5 seconds (half of Vercel's limit)
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
    
    // Try to correct typos
    const { corrected, email: correctedEmail } = emailValidator.correctEmailTypos(email);
    console.log('VALIDATION: Typo correction result', { 
      original: email,
      corrected: correctedEmail,
      wasChanged: corrected
    });
    
    // Get quick validation result as a fallback
    const quickResult = emailValidator.quickValidate(email);
    
    try {
      // Log that we're starting validation
      console.log('VALIDATION: Starting full validation process', {
        email,
        supabaseStatus: emailValidator.supabaseConnectionStatus || 'unknown',
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
      
      // Log success and return result
      console.log('API RESPONSE: Validation completed successfully', {
        email,
        status: result.status,
        wasCorrected: result.wasCorrected,
        umEmailStatus: result.um_email_status,
        umBounceStatus: result.um_bounce_status
      });
      
      return res.status(200).json(result);
    } catch (error) {
      // Log the error and fall back to quick result
      console.error('VALIDATION ERROR: Validation timed out or failed', {
        email,
        error: error.message,
        stack: error.stack?.split('\n')[0]
      });
      
      console.log('API RESPONSE: Falling back to quick validation result', {
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