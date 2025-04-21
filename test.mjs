// test.mjs
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EmailValidationService } from './src/services/email-validator.js';

// Load environment variables
dotenv.config();

// Get current file directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load configuration from environment variables
const config = {
  useZeroBounce: process.env.USE_ZERO_BOUNCE === 'true',
  zeroBounceApiKey: process.env.ZERO_BOUNCE_API_KEY,
  removeGmailAliases: true,
  checkAustralianTlds: true,
  upstash: {
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN
  }
};

// Initialize the email validation service
const emailValidator = new EmailValidationService(config);

// Test function
async function testEmailValidation() {
  try {
    // Test with a few email addresses
    const emails = [
      'test@gmail.com',
      'test@gmial.com',  // Typo
      'test+label@gmail.com',  // Gmail alias
      'invalid.email',  // Invalid format
    ];
    
    console.log('Starting batch validation test...');
    const results = await emailValidator.validateBatch(emails);
    
    console.log('Validation Results:', JSON.stringify(results, null, 2));
    
    console.log('Testing Redis caching...');
    // Test if caching works by checking if the email is now known valid
    if (results[0].status === 'valid') {
      const isKnown = await emailValidator.isKnownValidEmail(emails[0]);
      console.log(`Is "${emails[0]}" known valid? ${isKnown}`);
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Run the test
testEmailValidation();