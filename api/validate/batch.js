import { EmailValidationService } from '../../src/services/email-validator.js';

// Load configuration with Redis disabled by default
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
  useRedis: process.env.USE_REDIS === 'true',
  upstash: {
    url: process.env.UPSTASH_REDIS_URL || '',
    token: process.env.UPSTASH_REDIS_TOKEN || ''
  }
};

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

export default async function handler(req, res) {
  // Only allow POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { emails } = req.body;
    
    if (!emails || !Array.isArray(emails)) {
      return res.status(400).json({ error: 'Emails array is required' });
    }
    
    // Limit batch size to prevent abuse
    if (emails.length > 100) {
      return res.status(400).json({ 
        error: 'Batch size exceeded',
        message: 'Maximum batch size is 100 emails'
      });
    }
    
    // Log for debugging
    console.log(`Processing batch validation for ${emails.length} emails`);
    
    // CRITICAL: Set a strict global timeout to ensure we respond before Vercel's timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 8000); // Set to 8 seconds to be safe
    });
    
    try {
      // Race between batch validation and timeout
      const results = await Promise.race([
        emailValidator.validateBatch(emails, {
          // Skip ZeroBounce for large batches to save time
          skipZeroBounce: emails.length > 10,
          // Allocate time budget per email
          timeoutPerEmailMs: Math.min(2000, 8000 / emails.length)
        }),
        timeoutPromise
      ]);
      
      return res.status(200).json(results);
    } catch (error) {
      console.error('Batch validation timed out:', error.message);
      
      // If we hit a timeout, return quick validation results for all emails
      console.log('Falling back to quick validation for all emails');
      const quickResults = emails.map(email => emailValidator.quickValidate(email));
      return res.status(200).json(quickResults);
    }
  } catch (error) {
    console.error('Error validating email batch:', error);
    return res.status(500).json({
      error: 'Error validating email batch',
      details: error.message
    });
  }
}