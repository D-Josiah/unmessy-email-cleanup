// api/validate/name.js
import { NameValidationService } from '../../src/services/name-validator.js';
import { ClientManagerService } from '../../src/services/client-manager.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Detailed logging for configuration and connection status
console.log('=============================================');
console.log('NAME VALIDATION API STARTUP');
console.log('=============================================');

// Log environment variables (safely)
console.log('ENVIRONMENT VARIABLES CHECK:', {
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
  // Name processing settings
  fixCommonNameErrors: true,
  
  // Default rate limit (overridden by client-specific settings)
  defaultDailyLimit: 1000,
  
  // ID generation settings
  clientId: process.env.CLIENT_ID || '00001',
  umessyVersion: process.env.UMESSY_VERSION || '100',
  
  // Timeouts
  timeouts: {
    validation: 5000,         // 5 seconds for validation (names are fast)
  }
};

// Log the configuration
console.log('API CONFIGURATION:', {
  fixCommonNameErrors: config.fixCommonNameErrors,
  defaultDailyLimit: config.defaultDailyLimit,
  timeouts: config.timeouts,
  clientId: config.clientId,
  umessyVersion: config.umessyVersion
});

// Initialize the client manager service
const clientManager = new ClientManagerService(config.defaultDailyLimit);

// Log loaded clients
console.log(`CLIENT MANAGER: Loaded ${clientManager.clients.size} client API keys with default rate limit of ${config.defaultDailyLimit} requests/day`);

// Initialize the name validation service
const nameValidator = new NameValidationService(config);

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
    
    const { name, first_name, last_name } = req.body;
    
    // Check if we have either a full name or first/last components
    if (!name && (!first_name && !last_name)) {
      return res.status(400).json({ 
        error: 'Either a full name or first_name/last_name components are required' 
      });
    }
    
    // Log request info with client details
    console.log('API REQUEST: Processing name validation', { 
      clientId: client.clientId,
      clientName: client.name,
      name: name || null,
      first_name: first_name || null,
      last_name: last_name || null,
      timestamp: new Date().toISOString()
    });
    
    // Set a global timeout to ensure we respond before Vercel's timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Function timeout to prevent Vercel runtime timeout'));
      }, 8000); // 8 seconds (just under Vercel's 10-second limit)
    });
    
    try {
      // Log that we're starting validation
      console.log('VALIDATION: Starting validation process', {
        clientId: client.clientId,
        inputType: name ? 'full_name' : 'separate_components'
      });
      
      let result;
      
      // Handle validation differently based on input type
      if (name) {
        // Process full name
        result = await Promise.race([
          Promise.resolve(nameValidator.validateName(name)),
          timeoutPromise
        ]);
      } else {
        // Process separate first/last components
        result = await Promise.race([
          Promise.resolve(nameValidator.validateSeparateNames(first_name, last_name)),
          timeoutPromise
        ]);
      }
      
      // Increment the client's count for successful validation
      clientManager.incrementEmailCount(client.clientId);
      
      // Get client stats for the response
      const clientStats = clientManager.getClientStats(client.clientId);
      
      // Format names for Hubspot compatibility
      const formattedFirstName = result.honorific 
        ? `${result.honorific} ${result.firstName}`.trim() 
        : result.firstName;
        
      const formattedLastName = result.suffix 
        ? `${result.lastName} ${result.suffix}`.trim() 
        : result.lastName;
      
      // Determine if the name was changed during processing
      const originalFullName = name || `${first_name || ''} ${last_name || ''}`.trim();
      const processedFullName = `${formattedFirstName} ${formattedLastName}`.trim();
      
      // Compare exact case to detect capitalization changes
      const nameWasChanged = originalFullName !== processedFullName;
      
      // Create a response with UM-prefixed fields, aligned with Unmessy conventions
      const apiResponse = {
        // Original request info
        original_name: result.originalName,
        input_type: name ? 'full_name' : 'separate_components',
        
        // Validation result with um_ prefix, formatted for Hubspot
        um_first_name: formattedFirstName,
        um_last_name: formattedLastName,
        um_middle_name: result.middleName || '',
        
        // Unmessy standard fields
        um_name_status: nameWasChanged ? 'Changed' : 'Unchanged',
        um_name_format: result.formatValid ? 'Valid' : 'Invalid',
        um_name: processedFullName,  // The final formatted name
        
        // Original parsed components (for reference)
        original_components: {
          first_name: result.firstName,
          last_name: result.lastName,
          middle_name: result.middleName || '',
          honorific: result.honorific || '',
          suffix: result.suffix || ''
        },
        
        // Status information (detailed validation info)
        validation_details: {
          status: result.status,
          sub_status: result.subStatus,
          format_valid: result.formatValid,
          confidence_level: result.confidenceLevel,
          script: result.script,
          potential_issues: result.potentialIssues,
          is_comma_format: result.isCommaFormat || false
        },
        
        // Client usage information
        client: {
          id: client.clientId,
          name: client.name,
          processed_count: clientStats.usage.emailCount,
          daily_limit: client.dailyEmailLimit,
          remaining: client.dailyEmailLimit - clientStats.usage.emailCount
        }
      };
      
      // Log success and return result
      console.log('API RESPONSE: Validation completed successfully', {
        clientId: client.clientId,
        inputType: name ? 'full_name' : 'separate_components',
        um_name_status: apiResponse.um_name_status,
        um_name_format: apiResponse.um_name_format,
        um_first_name: apiResponse.um_first_name,
        um_last_name: apiResponse.um_last_name
      });
      
      return res.status(200).json(apiResponse);
    } catch (error) {
      // Log the error
      console.error('VALIDATION ERROR: Name validation failed', {
        clientId: client.clientId,
        name,
        error: error.message,
        stack: error.stack?.split('\n')[0]
      });
      
      return res.status(500).json({
        error: 'Error validating name',
        details: error.message
      });
    }
  } catch (error) {
    // Log the fatal error
    console.error('FATAL API ERROR:', {
      message: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      error: 'Error validating name',
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
      name_validation: {
        status: 'operational',
        honorifics: Array.from(nameValidator.honorifics).slice(0, 5),
        suffixes: Array.from(nameValidator.suffixes).slice(0, 5),
        specialCaseCorrections: Array.from(nameValidator.specialCaseCorrections.entries()).slice(0, 3)
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