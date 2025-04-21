import { Redis } from '@upstash/redis';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Initialize Redis only if explicitly enabled
    this.redis = null;
    this.redisEnabled = !!(config.upstash && 
                          config.upstash.url && 
                          config.upstash.token &&
                          config.useRedis !== false);

    // Only initialize Redis if explicitly enabled
    if (this.redisEnabled) {
      try {
        console.log('UPSTASH_INIT: Attempting to initialize Redis client', {
          url: config.upstash.url ? 'URL PROVIDED' : 'NO URL',
          tokenProvided: !!config.upstash.token
        });

        this.redis = new Redis({
          url: config.upstash.url,
          token: config.upstash.token,
        });

        // Test connection but don't block initialization
        this.testRedisConnection().catch(err => {
          console.error('Redis connection test failed:', err.message);
          // Disable Redis if connection test fails
          this.redis = null;
          this.redisEnabled = false;
        });
      } catch (error) {
        console.error('UPSTASH_INIT_FATAL_ERROR:', {
          message: error.message,
          stack: error.stack
        });
        this.redis = null;
        this.redisEnabled = false;
      }
    } else {
      console.log('UPSTASH_INIT: Redis disabled by configuration');
    }
    
    // Common email domain typos
    this.domainTypos = {
      'gmial.com': 'gmail.com',
      'gmal.com': 'gmail.com',
      'gmail.cm': 'gmail.com',
      'gmail.co': 'gmail.com',
      'gamil.com': 'gmail.com',
      'hotmial.com': 'hotmail.com',
      'hotmail.cm': 'hotmail.com',
      'yahoo.cm': 'yahoo.com',
      'yaho.com': 'yahoo.com',
      'outlook.cm': 'outlook.com',
      'outlok.com': 'outlook.com'
    };
    
    this.australianTlds = ['.com.au', '.net.au', '.org.au', '.edu.au', '.gov.au', '.asn.au', '.id.au', '.au'];
    
    // Extended list of common domains for local validation
    this.commonValidDomains = [
      'gmail.com', 
      'outlook.com', 
      'hotmail.com', 
      'yahoo.com', 
      'icloud.com', 
      'aol.com',
      'protonmail.com',
      'fastmail.com',
      'mail.com',
      'zoho.com',
      'yandex.com',
      'gmx.com',
      'live.com',
      'msn.com',
      'me.com',
      'mac.com',
      'googlemail.com',
      'pm.me',
      'tutanota.com',
      'mailbox.org'
    ];
  }

  // Connection test method with short timeout
  async testRedisConnection() {
    if (!this.redis) {
      console.error('UPSTASH_CONNECTION_TEST: Redis client not initialized');
      return false;
    }

    try {
      console.log('UPSTASH_CONNECTION_TEST: Attempting ping');
      const pingResult = await this.withTimeout(
        this.redis.ping(),
        1000,
        'Redis ping timeout'
      );
      console.log('UPSTASH_CONNECTION_TEST: Ping successful', { result: pingResult });
      return true;
    } catch (error) {
      console.error('UPSTASH_CONNECTION_TEST_FAILED:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
      return false;
    }
  }

  // Ultra-short timeout wrapper method
  async withTimeout(promise, timeoutMs = 1000, errorMessage = 'Operation timeout') {
    console.log('TIMEOUT_WRAPPER: Initiating timeout-protected operation', {
      timeoutMs,
      errorMessage
    });

    const timeout = new Promise((_, reject) => 
      setTimeout(() => {
        console.warn('TIMEOUT_WRAPPER: Operation timed out', { timeoutMs, errorMessage });
        reject(new Error(errorMessage));
      }, timeoutMs)
    );
    
    try {
      const result = await Promise.race([promise, timeout]);
      console.log('TIMEOUT_WRAPPER: Operation completed successfully');
      return result;
    } catch (error) {
      console.error('TIMEOUT_WRAPPER: Operation failed', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
      throw error;
    }
  }
  
  // Add email to Redis store - Skip if Redis disabled
  async addToKnownValidEmails(email) {
    if (!this.redisEnabled || !this.redis) {
      console.log('REDIS_ADD: Redis disabled, skipping operation');
      return false;
    }

    const key = `email:${email}`;
    const data = {
      validatedAt: new Date().toISOString(),
      source: 'validation-service'
    };
    
    try {
      console.log('REDIS_ADD: Attempting to store email', { 
        email, 
        key, 
        expirationSeconds: 30 * 24 * 60 * 60 
      });

      const setResult = await this.withTimeout(
        this.redis.set(key, JSON.stringify(data), { ex: 30 * 24 * 60 * 60 }),
        1000,
        'Redis SET timeout'
      );
      
      console.log('REDIS_ADD: Store operation result', { 
        result: setResult,
        success: setResult === 'OK' 
      });

      return setResult === 'OK';
    } catch (error) {
      console.error('REDIS_ADD_ERROR:', {
        message: error.message,
        name: error.name,
        email,
        stack: error.stack
      });
      
      return false;
    }
  }
  
  // Check if email exists in Redis store - Skip if Redis disabled
  async isKnownValidEmail(email) {
    if (!this.redisEnabled || !this.redis) {
      console.log('REDIS_GET: Redis disabled, skipping check');
      return false;
    }

    const key = `email:${email}`;
    
    try {
      console.log('REDIS_GET: Attempting to retrieve email', { email, key });

      const result = await this.withTimeout(
        this.redis.get(key),
        1000,
        'Redis GET timeout'
      );
      
      const isKnown = !!result;
      console.log('REDIS_GET: Retrieval result', { 
        email, 
        found: isKnown,
        resultType: typeof result
      });
      
      return isKnown;
    } catch (error) {
      console.error('REDIS_GET_ERROR:', {
        message: error.message,
        name: error.name,
        email,
        stack: error.stack
      });
      
      // Continue with other validation steps if Redis fails
      return false;
    }
  }
  
  // Basic email format check
  isValidEmailFormat(email) {
    // More comprehensive email validation regex
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  }
  
  // Clean and correct common email typos
  correctEmailTypos(email) {
    console.log('TYPO_CORRECTION: Starting email correction', { input: email });

    if (!email) {
      console.log('TYPO_CORRECTION: Empty email, returning as-is');
      return { corrected: false, email };
    }
    
    let corrected = false;
    let cleanedEmail = email.trim().toLowerCase();
    
    // Remove any spaces
    const noSpaceEmail = cleanedEmail.replace(/\s/g, '');
    if (noSpaceEmail !== cleanedEmail) {
      cleanedEmail = noSpaceEmail;
      corrected = true;
    }
    
    // Check for common domain typos
    const [localPart, domain] = cleanedEmail.split('@');
    
    if (domain && this.domainTypos[domain]) {
      cleanedEmail = `${localPart}@${this.domainTypos[domain]}`;
      corrected = true;
    }
    
    // Check for + alias in Gmail
    if (this.config.removeGmailAliases && domain === 'gmail.com' && localPart.includes('+')) {
      const baseLocal = localPart.split('+')[0];
      cleanedEmail = `${baseLocal}@gmail.com`;
      corrected = true;
    }
    
    // Check Australian TLDs
    if (this.config.checkAustralianTlds) {
      for (const tld of this.australianTlds) {
        const tldNoDot = tld.replace(/\./g, '');
        if (domain && domain.endsWith(tldNoDot) && !domain.endsWith(tld)) {
          const index = domain.lastIndexOf(tldNoDot);
          const newDomain = domain.substring(0, index) + tld;
          cleanedEmail = `${localPart}@${newDomain}`;
          corrected = true;
          break;
        }
      }
    }
    
    console.log('TYPO_CORRECTION: Correction result', { 
      corrected, 
      originalEmail: email, 
      correctedEmail: cleanedEmail 
    });
    
    return { corrected, email: cleanedEmail };
  }
  
  // Check if email domain is valid
  isValidDomain(email) {
    try {
      const domain = email.split('@')[1];
      
      if (!domain) return false;
      
      return this.commonValidDomains.includes(domain);
    } catch (error) {
      console.error('DOMAIN_VALIDATION_ERROR:', {
        message: error.message,
        email
      });
      return false;
    }
  }
  
  // Quick validation that doesn't use external services
  quickValidate(email) {
    console.log('QUICK_VALIDATION: Starting quick validation for', { email });
    
    // Step 1: Format check
    const formatValid = this.isValidEmailFormat(email);
    if (!formatValid) {
      console.log('QUICK_VALIDATION: Invalid format');
      return {
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        wasCorrected: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        validationSteps: [{ step: 'format_check', passed: false }]
      };
    }
    
    // Step 2: Correct common typos
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    
    // Step 3: Domain check
    const domainValid = this.isValidDomain(correctedEmail);
    
    // Determine status based on local validation only
    const status = domainValid ? 'valid' : 'unknown';
    
    console.log('QUICK_VALIDATION: Completed', { 
      formatValid, 
      corrected, 
      domainValid, 
      status 
    });
    
    return {
      originalEmail: email,
      currentEmail: correctedEmail,
      formatValid: true,
      wasCorrected: corrected,
      domainValid,
      status,
      recheckNeeded: !domainValid,
      validationSteps: [
        { step: 'format_check', passed: true },
        { step: 'typo_correction', applied: corrected, original: email, corrected: correctedEmail },
        { step: 'domain_check', passed: domainValid }
      ]
    };
  }
  
  // ZeroBounce API check with strict timeout
  async checkWithZeroBounce(email) {
    console.log('ZEROBOUNCE_CHECK: Starting validation', { email });

    // Validate ZeroBounce configuration
    if (!this.config.zeroBounceApiKey) {
      console.error('ZEROBOUNCE_ERROR: API key not configured');
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: 'ZeroBounce API key not configured'
      };
    }

    try {
      const url = new URL('https://api.zerobounce.net/v2/validate');
      url.searchParams.append('api_key', this.config.zeroBounceApiKey);
      url.searchParams.append('email', email);
      url.searchParams.append('ip_address', '');
      
      console.log('ZEROBOUNCE_CHECK: Sending request', { url: url.toString() });

      // Add strict timeout to fetch request - 3 seconds max
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log('ZEROBOUNCE_CHECK: Aborting request due to timeout');
        controller.abort();
      }, 3000);
      
      try {
        const response = await fetch(url.toString(), { 
          signal: controller.signal,
          // Set additional fetch timeout options
          timeout: 3000
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          console.error('ZEROBOUNCE_ERROR: API response not OK', {
            status: response.status,
            statusText: response.statusText
          });
          throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('ZEROBOUNCE_CHECK: API response received', { 
          status: result.status,
          subStatus: result.sub_status
        });
        
        // Map ZeroBounce status to our simplified status
        let status, subStatus, recheckNeeded;
        
        switch (result.status) {
          case 'valid':
            status = 'valid';
            recheckNeeded = false;
            break;
          case 'invalid':
            status = 'invalid';
            subStatus = result.sub_status;
            recheckNeeded = false;
            break;
          case 'catch-all':
            status = 'unknown';
            recheckNeeded = true;
            break;
          case 'unknown':
            status = 'unknown';
            recheckNeeded = true;
            break;
          case 'spamtrap':
            status = 'invalid';
            subStatus = 'spamtrap';
            recheckNeeded = false;
            break;
          case 'abuse':
            status = 'invalid';
            subStatus = 'abuse';
            recheckNeeded = false;
            break;
          default:
            status = 'check_failed';
            recheckNeeded = true;
        }
        
        // If valid, try to add to our known valid emails but don't wait for it
        if (status === 'valid') {
          this.addToKnownValidEmails(email).catch(err => {
            console.error('Failed to add valid email to Redis:', err.message);
          });
        }
        
        const finalResult = {
          email,
          status,
          subStatus,
          recheckNeeded,
          source: 'zerobounce',
          details: result
        };

        console.log('ZEROBOUNCE_CHECK: Final result', finalResult);
        
        return finalResult;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      console.error('ZEROBOUNCE_CHECK_ERROR:', {
        message: error.message,
        name: error.name,
        email,
        stack: error.stack
      });
      
      // If AbortError, it's a timeout
      if (error.name === 'AbortError') {
        console.error('ZEROBOUNCE_TIMEOUT: Request timed out after 3 seconds');
      }
      
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message
      };
    }
  }
  
  // Main validation function with strict timeout handling
  async validateEmail(email, options = {}) {
    const { skipZeroBounce = false, timeoutMs = 5000 } = options;
    
    console.log('VALIDATION_PROCESS: Starting email validation', { 
      email, 
      skipZeroBounce,
      timeoutMs
    });

    // Start with quick validation that doesn't depend on external services
    const quickResult = this.quickValidate(email);
    
    // If format is invalid, we can return immediately
    if (!quickResult.formatValid) {
      console.log('VALIDATION_PROCESS: Invalid format, using quick result');
      return quickResult;
    }
    
    // Try to get a more detailed validation, but with timeout protection
    const validationPromise = this._fullValidation(quickResult.currentEmail, skipZeroBounce);
    
    // Set a timeout to ensure we don't hang
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.warn('VALIDATION_PROCESS: Timeout after', { timeoutMs });
        reject(new Error('Validation timeout'));
      }, timeoutMs);
    });
    
    try {
      // Race between validation and timeout
      const fullResult = await Promise.race([validationPromise, timeoutPromise]);
      console.log('VALIDATION_PROCESS: Completed successfully');
      return fullResult;
    } catch (error) {
      console.error('VALIDATION_PROCESS: Error or timeout', { 
        error: error.message, 
        fallbackToQuick: true 
      });
      
      // Fall back to quick result if full validation fails or times out
      return quickResult;
    }
  }
  
  // Internal method for full validation with all checks
  async _fullValidation(email, skipZeroBounce = false) {
    const result = {
      originalEmail: email,
      currentEmail: email,
      formatValid: true, // We already checked this in quickValidate
      wasCorrected: false,
      isKnownValid: false,
      domainValid: false,
      status: 'unknown',
      subStatus: null,
      recheckNeeded: true,
      validationSteps: [
        { step: 'format_check', passed: true }
      ]
    };
    
    // Step 1: Correct common typos (already done in quickValidate, but we need to track it)
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    result.wasCorrected = corrected;
    result.currentEmail = correctedEmail;
    result.validationSteps.push({
      step: 'typo_correction',
      applied: corrected,
      original: email,
      corrected: correctedEmail
    });
    
    // Step 2: Check if it's a known valid email (if Redis is enabled)
    try {
      result.isKnownValid = await this.isKnownValidEmail(correctedEmail);
      result.validationSteps.push({
        step: 'known_valid_check',
        passed: result.isKnownValid
      });
      
      if (result.isKnownValid) {
        result.status = 'valid';
        result.recheckNeeded = false;
        console.log('VALIDATION_PROCESS: Known valid email');
        return result;
      }
    } catch (error) {
      console.error('VALIDATION_PROCESS: Known valid check failed', { 
        error: error.message 
      });
      result.validationSteps.push({
        step: 'known_valid_check',
        passed: false,
        error: error.message
      });
    }
    
    // Step 3: Check if domain appears valid
    result.domainValid = this.isValidDomain(correctedEmail);
    result.validationSteps.push({
      step: 'domain_check',
      passed: result.domainValid
    });
    
    // If domain is valid from our list, we can consider it valid
    if (result.domainValid) {
      result.status = 'valid';
      result.recheckNeeded = false;
      return result;
    }
    
    // Step 4: If enabled and not skipped, check with ZeroBounce
    if (this.config.useZeroBounce && !skipZeroBounce) {
      try {
        const bounceCheck = await this.checkWithZeroBounce(correctedEmail);
        
        result.status = bounceCheck.status;
        result.subStatus = bounceCheck.subStatus;
        result.recheckNeeded = bounceCheck.recheckNeeded;
        result.validationSteps.push({
          step: 'zerobounce_check',
          result: bounceCheck
        });
      } catch (error) {
        console.error('VALIDATION_PROCESS: ZeroBounce check failed', {
          message: error.message
        });
        
        result.status = 'check_failed';
        result.recheckNeeded = true;
        result.validationSteps.push({
          step: 'zerobounce_check',
          error: error.message
        });
      }
    } else {
      console.log('VALIDATION_PROCESS: ZeroBounce check skipped');
      result.validationSteps.push({
        step: 'zerobounce_check',
        skipped: true
      });
      
      // Without ZeroBounce, rely on domain check
      result.status = 'unknown';
      result.recheckNeeded = true;
    }
    
    return result;
  }
  
  // Process a batch of emails with better timeout handling
  async validateBatch(emails, options = {}) {
    const { skipZeroBounce = false, timeoutPerEmailMs = 3000 } = options;
    
    console.log('BATCH_VALIDATION: Starting batch validation', { 
      totalEmails: emails.length,
      skipZeroBounce,
      timeoutPerEmailMs
    });

    const results = [];
    
    // Set a maximum time budget for the entire batch
    const maxBatchTimeMs = Math.min(9000, emails.length * timeoutPerEmailMs);
    const batchEndTime = Date.now() + maxBatchTimeMs;
    
    for (const email of emails) {
      try {
        // Calculate remaining time for this email
        const remainingTime = batchEndTime - Date.now();
        if (remainingTime <= 0) {
          console.warn('BATCH_VALIDATION: Time budget exceeded, using quick validation for remaining emails');
          // Use quick validation for remaining emails
          results.push(this.quickValidate(email));
          continue;
        }
        
        console.log('BATCH_VALIDATION: Validating email with remaining time', { 
          email, 
          remainingTimeMs: remainingTime 
        });
        
        // Validate with appropriate timeout
        const result = await this.validateEmail(email, {
          skipZeroBounce,
          timeoutMs: Math.min(remainingTime, timeoutPerEmailMs)
        });
        
        results.push(result);
      } catch (error) {
        console.error('BATCH_VALIDATION: Error validating email', {
          email,
          message: error.message
        });
        
        // Fall back to quick validation on error
        results.push(this.quickValidate(email));
      }
    }
    
    console.log('BATCH_VALIDATION: Batch validation complete', { 
      totalProcessed: results.length 
    });
    
    return results;
  }
  
  // Update HubSpot contact with improved error handling and logging
  async updateHubSpotContact(contactId, validationResult) {
    console.log('HUBSPOT_UPDATE: Starting contact update', { 
      contactId, 
      validationStatus: validationResult.status,
      currentEmail: validationResult.currentEmail
    });

    try {
      // Validate HubSpot configuration
      if (!this.config.hubspot || !this.config.hubspot.apiKey) {
        console.error('HUBSPOT_UPDATE_ERROR: API key not configured');
        return {
          success: false,
          contactId,
          error: 'HubSpot API key not configured'
        };
      }
      
      // Prepare properties to update
      const properties = {
        email: validationResult.currentEmail,
        email_status: validationResult.status,
        email_recheck_needed: validationResult.recheckNeeded,
        email_check_date: new Date().toISOString(),
      };
      
      // Add additional properties if email was corrected
      if (validationResult.wasCorrected) {
        properties.original_email = validationResult.originalEmail;
        properties.email_corrected = true;
      }
      
      // Add sub-status if present
      if (validationResult.subStatus) {
        properties.email_sub_status = validationResult.subStatus;
      }
      
      // Prepare fetch options
      const fetchOptions = {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.hubspot.apiKey}`
        },
        body: JSON.stringify({ properties })
      };

      console.log('HUBSPOT_UPDATE: Sending update request', { 
        contactId, 
        properties: Object.keys(properties),
        requestBody: JSON.stringify({ properties })
      });

      // Add strict timeout to HubSpot API call - 8 seconds max for HubSpot
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log('HUBSPOT_UPDATE: Aborting request due to timeout');
        controller.abort();
      }, 8000);
      
      try {
        // Log the full request details for debugging
        console.log('HUBSPOT_UPDATE: Request details', {
          url: `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer [REDACTED]'
          },
          body: JSON.stringify({ properties })
        });
        
        // Send update request with abort signal
        const response = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
          { ...fetchOptions, signal: controller.signal }
        );
        clearTimeout(timeoutId);
        
        // Log the response status for debugging
        console.log('HUBSPOT_UPDATE: Response status', {
          status: response.status,
          statusText: response.statusText
        });
        
        // Check response
        if (!response.ok) {
          const errorBody = await response.text();
          console.error('HUBSPOT_UPDATE_ERROR: API response not OK', {
            status: response.status,
            statusText: response.statusText,
            errorBody
          });
          throw new Error(`HubSpot API error: ${response.status} ${response.statusText}`);
        }
        
        // Parse and log successful response
        const data = await response.json();
        console.log('HUBSPOT_UPDATE: Update successful', { 
          contactId, 
          responseId: data.id,
          responseData: JSON.stringify(data).substring(0, 200)
        });
        
        return {
          success: true,
          contactId,
          hubspotResponse: data
        };
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      console.error('HUBSPOT_UPDATE_FATAL_ERROR:', {
        contactId,
        message: error.message,
        name: error.name,
        stack: error.stack
      });
      
      // Special handling for AbortError (timeout)
      if (error.name === 'AbortError') {
        return {
          success: false,
          contactId,
          error: 'HubSpot API request timed out'
        };
      }
      
      return {
        success: false,
        contactId,
        error: error.message
      };
    }
  }
}