// api/validate/batch.js
import { EmailValidationService } from '../../src/services/email-validator.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize email validator with standard API configuration
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  useSupabase: true,
  supabase: {
    url: process.env.SUPABASE_URL || 'https://noxlrexfrmakvnfqhxfx.supabase.co',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    options: { 
      auth: { persistSession: false, autoRefreshToken: false } 
    }
  },
  useRedis: process.env.USE_REDIS === 'true',
  upstash: {
    url: process.env.UPSTASH_REDIS_URL || '',
    token: process.env.UPSTASH_REDIS_TOKEN || ''
  },
  // Shorter timeouts for batch API to handle multiple emails
  timeouts: {
    zeroBounce: 2000,        // 2 seconds for ZeroBounce per email
    validation: 1500,         // 1.5 seconds per email validation
    supabase: 5000            // 5 seconds for Supabase operations
  }
};

// Initialize validator service
const emailValidator = new EmailValidationService(config);

export default async function handler(req, res) {
  // Only allow POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Set strict timeout for Vercel
  const timeout = setTimeout(() => {
    console.error('BATCH_API: Function timeout');
    res.status(500).json({ error: 'Function timeout' });
  }, 9000); // 9 seconds max for serverless function
  
  try {
    // Check authorization
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      console.error('BATCH_API: Unauthorized access attempt');
      clearTimeout(timeout);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Extract emails from request
    const { emails, options = {} } = req.body;
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      clearTimeout(timeout);
      return res.status(400).json({ error: 'Valid emails array is required' });
    }
    
    // Enforce reasonable batch size limits
    const MAX_BATCH_SIZE = 100;
    if (emails.length > MAX_BATCH_SIZE) {
      clearTimeout(timeout);
      return res.status(400).json({ 
        error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} emails`,
        message: 'Please break your request into smaller batches'
      });
    }
    
    // Log for monitoring
    console.log('BATCH_API: Processing batch validation request', { 
      batchSize: emails.length,
      saveResults: options.saveResults || false,
      skipZeroBounce: options.skipZeroBounce || false
    });
    
    // Filter out invalid format emails first to save processing time
    const validFormatEmails = emails.filter(email => 
      typeof email === 'string' && emailValidator.isValidEmailFormat(email)
    );
    
    // Track emails with invalid format
    const invalidFormatEmails = emails.filter(email => 
      !validFormatEmails.includes(email)
    );
    
    console.log('BATCH_API: Filtered batch', {
      originalCount: emails.length,
      validFormatCount: validFormatEmails.length,
      invalidFormatCount: invalidFormatEmails.length
    });
    
    // Validate the batch
    const validationResults = await emailValidator.validateBatch(validFormatEmails, {
      skipZeroBounce: options.skipZeroBounce || !config.useZeroBounce,
      timeoutPerEmailMs: Math.min(1500, 7000 / emails.length) // Dynamically adjust based on batch size
    });
    
    console.log('BATCH_API: Completed batch validation', {
      batchSize: validFormatEmails.length,
      resultsReturned: validationResults.length
    });
    
    // Add invalid format email results
    const invalidResults = invalidFormatEmails.map(email => ({
      originalEmail: email,
      currentEmail: email,
      formatValid: false,
      status: 'invalid',
      subStatus: 'bad_format',
      recheckNeeded: false
    }));
    
    // Combine all results
    const allResults = [...validationResults, ...invalidResults];
    
    // Save results if requested
    if (options.saveResults) {
      try {
        console.log('BATCH_API: Queueing batch results for saving');
        
        // Create a batch save payload
        const batchSavePayload = {
          action: 'batchSave',
          validations: validationResults.map(result => ({
            email: result.originalEmail,
            validationResult: result
          })),
          metadata: {
            source: 'batch_api',
            timestamp: Date.now(),
            batchId: `batch-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
          }
        };
        
        // Queue the results for saving in the background
        // Don't wait for this to complete before responding
        setTimeout(async () => {
          try {
            // In a real system, this would be sent to a queue
            // Here we're simulating by calling our queue consumer directly
            await fetch('/api/queue-consumer', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': process.env.QUEUE_API_KEY
              },
              body: JSON.stringify(batchSavePayload)
            });
            
            console.log('BATCH_API: Successfully queued batch for saving');
          } catch (queueError) {
            console.error('BATCH_API: Failed to queue batch for saving', { 
              error: queueError.message 
            });
          }
        }, 10);
      } catch (saveError) {
        console.error('BATCH_API: Error preparing batch save', { 
          error: saveError.message 
        });
        // Don't fail the request, just log the error
      }
    }
    
    // Return results to client
    clearTimeout(timeout);
    return res.status(200).json({
      success: true,
      totalProcessed: allResults.length,
      validFormat: validFormatEmails.length,
      invalidFormat: invalidFormatEmails.length,
      saved: options.saveResults || false,
      results: allResults
    });
  } catch (error) {
    console.error('BATCH_API: Unhandled error', { 
      message: error.message, 
      stack: error.stack 
    });
    
    clearTimeout(timeout);
    return res.status(500).json({
      success: false,
      error: 'Failed to process batch',
      details: error.message
    });
  }
}