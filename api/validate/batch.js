import { EmailValidationService } from '../../src/services/email-validator.js';

// Load configuration
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY || '',
  removeGmailAliases: true,
  checkAustralianTlds: true,
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
    
    const results = await emailValidator.validateBatch(emails);
    
    return res.status(200).json(results);
    
  } catch (error) {
    console.error('Error validating email batch:', error);
    return res.status(500).json({
      error: 'Error validating email batch',
      details: error.message,
      stack: error.stack
    });
  }
}