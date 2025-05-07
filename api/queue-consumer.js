// api/queue-consumer.js
import { EmailValidationService } from '../../src/services/email-validator.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize email validator service with the same configuration as the API
// but optimized for background processing
const config = {
  useZeroBounce: false, // Not needed for background operations
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  useSupabase: true, // Always enable for background processor
  supabase: {
    url: process.env.SUPABASE_URL || 'https://noxlrexfrmakvnfqhxfx.supabase.co',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5veGxyZXhmcm1ha3ZuZnFoeGZ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjE1MDc4MywiZXhwIjoyMDYxNzI2NzgzfQ.he2TitvQURi4Un-SOo0kHJjIqJrAaw77ibmfpzkOV3k',
    options: {
      auth: { 
        persistSession: false,
        autoRefreshToken: false
      },
      global: {
        headers: {
          'Content-Type': 'application/json'
        },
        fetch: (...args) => {
          return fetch(...args, {
            // Longer timeout for background operations
            signal: AbortSignal.timeout(25000) // 25 seconds timeout
          });
        }
      }
    }
  },
  clientId: process.env.CLIENT_ID || '00001',
  umessyVersion: process.env.UMESSY_VERSION || '100',
  // Much longer timeouts for background processing
  timeouts: {
    supabase: 20000,      // 20 seconds for Supabase operations
    validation: 25000     // 25 seconds for overall validation
  }
};

// Initialize the validator
const emailValidator = new EmailValidationService(config);

export async function processQueueItem(payload) {
  // Log the queue item received
  console.log('QUEUE_CONSUMER: Processing queue item', {
    action: payload.action,
    email: payload.email,
    isFallback: payload.isFallback || false
  });
  
  // Handle different action types
  switch (payload.action) {
    case 'saveValidation':
      return processValidationSave(payload);
    default:
      console.error('QUEUE_CONSUMER: Unknown action type', { action: payload.action });
      return { success: false, error: 'Unknown action type' };
  }
}

// Process a validation save request
async function processValidationSave(payload) {
  const { email, validationResult, isFallback } = payload;
  
  try {
    console.log('QUEUE_CONSUMER: Saving validation result', { 
      email, 
      resultStatus: validationResult.status,
      isFallback: isFallback || false 
    });
    
    // Check connection status first and test if necessary
    if (emailValidator.supabaseConnectionStatus === 'pending') {
      try {
        console.log('QUEUE_CONSUMER: Testing Supabase connection');
        await emailValidator._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('QUEUE_CONSUMER: Connection test failed', { error: error.message });
      }
    }
    
    // Only proceed if connected
    if (emailValidator.supabaseConnectionStatus !== 'connected') {
      console.error('QUEUE_CONSUMER: Cannot save, Supabase not connected', {
        status: emailValidator.supabaseConnectionStatus
      });
      return { success: false, error: 'Supabase not connected' };
    }
    
    // Save result to Supabase
    const saveResult = await emailValidator.saveValidationResult(email, validationResult);
    
    console.log('QUEUE_CONSUMER: Save operation completed', {
      success: saveResult.success,
      operation: saveResult.operation,
      resultId: saveResult.data?.id
    });
    
    return saveResult;
  } catch (error) {
    console.error('QUEUE_CONSUMER: Error saving validation result', {
      email,
      error: error.message,
      stack: error.stack