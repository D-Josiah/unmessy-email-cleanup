// api/queue-consumer.js
import { EmailValidationService } from '../../src/services/email-validator.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize email validator service with the same configuration as the API
// but optimized for background processing
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Set strict timeout for Vercel
  const timeout = setTimeout(() => {
    console.error('QUEUE_CONSUMER: Function timeout');
    res.status(500).json({ error: 'Function timeout' });
  }, 8000); // 8 seconds max for serverless function
  
  try {
    // Basic auth via API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.QUEUE_API_KEY) {
      console.error('QUEUE_CONSUMER: Unauthorized access attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Extract the queue payload
    const payload = req.body;
    
    if (!payload || !payload.action) {
      console.error('QUEUE_CONSUMER: Invalid payload');
      return res.status(400).json({ error: 'Invalid payload, missing action' });
    }
    
    // Process the queue item
    const result = await processQueueItem(payload);
    clearTimeout(timeout);
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('QUEUE_CONSUMER: Unhandled error', { 
      message: error.message, 
      stack: error.stack 
    });
    
    clearTimeout(timeout);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

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
    case 'batchSave':
      return processBatchSave(payload);
    case 'cleanupOldValidations':
      return cleanupOldValidations(payload);
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
    });
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Process batch save requests
async function processBatchSave(payload) {
  const { validations, metadata } = payload;
  
  if (!Array.isArray(validations) || validations.length === 0) {
    return {
      success: false,
      error: 'Invalid batch format or empty batch'
    };
  }
  
  console.log('QUEUE_CONSUMER: Processing batch save', {
    batchSize: validations.length,
    source: metadata?.source || 'unknown'
  });
  
  // Results tracking
  const results = {
    totalProcessed: validations.length,
    succeeded: 0,
    failed: 0,
    errors: []
  };
  
  // Process each validation in sequence to avoid overwhelming the database
  for (const item of validations) {
    try {
      const { email, validationResult } = item;
      
      if (!email || !validationResult) {
        results.failed++;
        results.errors.push(`Invalid item: missing email or validation result`);
        continue;
      }
      
      const saveResult = await emailValidator.saveValidationResult(email, validationResult);
      
      if (saveResult.success) {
        results.succeeded++;
      } else {
        results.failed++;
        results.errors.push(`Failed to save ${email}: ${saveResult.error}`);
      }
    } catch (error) {
      results.failed++;
      results.errors.push(error.message);
    }
  }
  
  // Only keep the last 5 errors to prevent response size issues
  if (results.errors.length > 5) {
    const errorCount = results.errors.length;
    results.errors = results.errors.slice(0, 5);
    results.errors.push(`...and ${errorCount - 5} more errors`);
  }
  
  console.log('QUEUE_CONSUMER: Batch processing completed', {
    succeeded: results.succeeded,
    failed: results.failed,
    total: results.totalProcessed
  });
  
  return {
    success: results.succeeded > 0,
    results
  };
}

// Cleanup old validations (periodic maintenance)
async function cleanupOldValidations(payload) {
  const { daysOld = 180, limit = 500 } = payload;
  
  try {
    console.log('QUEUE_CONSUMER: Starting cleanup of old validations', {
      daysOld,
      limit
    });
    
    // Check Supabase connection first
    if (emailValidator.supabaseConnectionStatus !== 'connected') {
      try {
        await emailValidator._testSupabaseConnectionAsync();
        
        if (emailValidator.supabaseConnectionStatus !== 'connected') {
          throw new Error('Supabase connection failed');
        }
      } catch (error) {
        return {
          success: false,
          error: `Connection failed: ${error.message}`
        };
      }
    }
    
    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    const { count, error } = await emailValidator.supabase
      .from('email_validations')
      .delete()
      .lt('updated_at', cutoffDate.toISOString())
      .limit(limit);
    
    if (error) {
      throw new Error(`Cleanup failed: ${error.message}`);
    }
    
    console.log('QUEUE_CONSUMER: Cleanup completed successfully', {
      removedRecords: count || 0,
      cutoffDate: cutoffDate.toISOString()
    });
    
    return {
      success: true,
      removedRecords: count || 0,
      cutoffDate: cutoffDate.toISOString()
    };
  } catch (error) {
    console.error('QUEUE_CONSUMER: Cleanup failed', {
      error: error.message,
      stack: error.stack
    });
    
    return {
      success: false,
      error: error.message
    };
  }
}