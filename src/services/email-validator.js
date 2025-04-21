import { Redis } from '@upstash/redis';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Enhanced Redis initialization with comprehensive logging
    try {
      console.log('UPSTASH_INIT: Attempting to initialize Redis client', {
        url: config.upstash.url ? 'URL PROVIDED' : 'NO URL',
        tokenProvided: !!config.upstash.token
      });

      // Validate Redis configuration before initialization
      if (!config.upstash.url) {
        console.error('UPSTASH_INIT_ERROR: Redis URL is missing');
        this.redis = null;
        return;
      }

      if (!config.upstash.token) {
        console.error('UPSTASH_INIT_ERROR: Redis token is missing');
        this.redis = null;
        return;
      }

      this.redis = new Redis({
        url: config.upstash.url,
        token: config.upstash.token,
      });

      // Add a connection test
      this.testRedisConnection();
    } catch (error) {
      console.error('UPSTASH_INIT_FATAL_ERROR:', {
        message: error.message,
        stack: error.stack
      });
      this.redis = null;
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
    this.commonValidDomains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'aol.com'];
  }

  // Connection test method
  async testRedisConnection() {
    if (!this.redis) {
      console.error('UPSTASH_CONNECTION_TEST: Redis client not initialized');
      return;
    }

    try {
      console.log('UPSTASH_CONNECTION_TEST: Attempting ping');
      const pingResult = await this.withTimeout(
        this.redis.ping(),
        2000,
        'Redis ping timeout'
      );
      console.log('UPSTASH_CONNECTION_TEST: Ping successful', { result: pingResult });
    } catch (error) {
      console.error('UPSTASH_CONNECTION_TEST_FAILED:', {
        message: error.message,
        name: error.name,
        stack: error.stack
      });
    }
  }

  // Timeout wrapper method with reduced timeout values
  async withTimeout(promise, timeoutMs = 2000, errorMessage = 'Operation timeout') {
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
  
  // Add email to Redis store
  async addToKnownValidEmails(email) {
    if (!this.redis) {
      console.error('REDIS_ADD_ERROR: Redis client not initialized');
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
        2000,
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
  
  // Check if email exists in Redis store with fallback
  async isKnownValidEmail(email) {
    if (!this.redis) {
      console.error('REDIS_GET_ERROR: Redis client not initialized');
      return false;
    }

    const key = `email:${email}`;
    
    try {
      console.log('REDIS_GET: Attempting to retrieve email', { email, key });

      const result = await this.withTimeout(
        this.redis.get(key),
        2000,
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
      
      // Expanded list of valid domains
      const extendedValidDomains = [
        ...this.commonValidDomains,
        'protonmail.com', 
        'zoho.com', 
        'fastmail.com', 
        'pm.me', 
        'googlemail.com'
      ];
      
      return extendedValidDomains.includes(domain);
    } catch (error) {
      console.error('DOMAIN_VALIDATION_ERROR:', {
        message: error.message,
        email
      });
      return false;
    }
  }
  
  // ZeroBounce API check with proper timeout handling
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

      // Add timeout to fetch request
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout for ZeroBounce
      
      try {
        const response = await fetch(url.toString(), { signal: controller.signal });
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
        
        // If valid, add to our known valid emails
        if (status === 'valid') {
          await this.addToKnownValidEmails(email);
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
  
  // Main validation function with graceful timeout handling
  async validateEmail(email) {
    console.log('VALIDATION_PROCESS: Starting full email validation', { email });

    const result = {
      originalEmail: email,
      currentEmail: email,
      formatValid: false,
      wasCorrected: false,
      isKnownValid: false,
      domainValid: false,
      status: 'unknown',
      subStatus: null,
      recheckNeeded: true,
      validationSteps: []
    };
    
    // Step 1: Basic format check with regex
    result.formatValid = this.isValidEmailFormat(email);
    result.validationSteps.push({
      step: 'format_check',
      passed: result.formatValid
    });
    console.log('VALIDATION_PROCESS: Format check', { 
      formatValid: result.formatValid 
    });
    
    if (!result.formatValid) {
      result.status = 'invalid';
      result.subStatus = 'bad_format';
      result.recheckNeeded = false;
      console.log('VALIDATION_PROCESS: Invalid format, early return');
      return result;
    }
    
    // Step 2: Correct common typos
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    result.wasCorrected = corrected;
    result.currentEmail = correctedEmail;
    result.validationSteps.push({
      step: 'typo_correction',
      applied: corrected,
      original: email,
      corrected: correctedEmail
    });
    console.log('VALIDATION_PROCESS: Typo correction', { 
      corrected, 
      correctedEmail 
    });
    
    // Step 3: Check if it's a known valid email - handle Redis errors gracefully
    try {
      result.isKnownValid = await this.isKnownValidEmail(correctedEmail);
      result.validationSteps.push({
        step: 'known_valid_check',
        passed: result.isKnownValid
      });
      console.log('VALIDATION_PROCESS: Known valid check', { 
        isKnownValid: result.isKnownValid 
      });
      
      if (result.isKnownValid) {
        result.status = 'valid';
        result.recheckNeeded = false;
        console.log('VALIDATION_PROCESS: Known valid email, early return');
        return result;
      }
    } catch (error) {
      console.error('VALIDATION_PROCESS: Known valid check failed, continuing', { 
        error: error.message 
      });
      result.validationSteps.push({
        step: 'known_valid_check',
        passed: false,
        error: error.message
      });
    }
    
    // Step 4: Check if domain appears valid
    result.domainValid = this.isValidDomain(correctedEmail);
    result.validationSteps.push({
      step: 'domain_check',
      passed: result.domainValid
    });
    console.log('VALIDATION_PROCESS: Domain check', { 
      domainValid: result.domainValid 
    });
    
    // Step 5: If enabled, check with ZeroBounce - with timeout protection
    console.log('VALIDATION_PROCESS: ZeroBounce configuration', { 
      useZeroBounce: this.config.useZeroBounce 
    });

    if (this.config.useZeroBounce) {
      try {
        // We'll set a deadline for this entire function to ensure it completes within Vercel's time limit
        const bounceCheck = await this.checkWithZeroBounce(correctedEmail);
        console.log('VALIDATION_PROCESS: ZeroBounce check result', { 
          status: bounceCheck.status,
          subStatus: bounceCheck.subStatus,
          recheckNeeded: bounceCheck.recheckNeeded
        });
        
        result.status = bounceCheck.status;
        result.subStatus = bounceCheck.subStatus;
        result.recheckNeeded = bounceCheck.recheckNeeded;
        result.validationSteps.push({
          step: 'zerobounce_check',
          result: bounceCheck
        });
      } catch (error) {
        console.error('VALIDATION_PROCESS: ZeroBounce check failed', {
          message: error.message,
          name: error.name,
          stack: error.stack
        });
        
        result.status = 'check_failed';
        result.recheckNeeded = true;
        result.validationSteps.push({
          step: 'zerobounce_check',
          error: error.message
        });
      }
    } else {
      console.log('VALIDATION_PROCESS: ZeroBounce not enabled');
      // Without ZeroBounce, rely on domain check
      result.status = result.domainValid ? 'unknown' : 'invalid';
      result.recheckNeeded = result.domainValid;
    }
    
    console.log('VALIDATION_PROCESS: Validation complete', { 
      status: result.status,
      recheckNeeded: result.recheckNeeded
    });
    return result;
  }
  
  // Process a batch of emails with better timeout handling
  async validateBatch(emails) {
    console.log('BATCH_VALIDATION: Starting batch validation', { 
      totalEmails: emails.length 
    });

    const results = [];
    
    for (const email of emails) {
      try {
        console.log('BATCH_VALIDATION: Validating individual email', { email });
        // Set a timeout for individual email validation
        const validationPromise = this.validateEmail(email);
        const result = await this.withTimeout(
          validationPromise,
          8000, // 8-second timeout for each email validation
          `Validation timeout for email: ${email}`
        );
        results.push(result);
        
        // Add a small delay to avoid rate limits if using ZeroBounce
        if (this.config.useZeroBounce) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (error) {
        console.error('BATCH_VALIDATION: Error validating email', {
          email,
          message: error.message,
          name: error.name,
          stack: error.stack
        });
        results.push({
          originalEmail: email,
          currentEmail: email,
          status: 'check_failed',
          error: error.message
        });
      }
    }
    
    console.log('BATCH_VALIDATION: Batch validation complete', { 
      totalProcessed: results.length 
    });
    return results;
  }
  
  // Update HubSpot contact with timeout protection
  async updateHubSpotContact(contactId, validationResult) {
    console.log('HUBSPOT_UPDATE: Starting contact update', { 
      contactId, 
      validationStatus: validationResult.status 
    });

    try {
      // Validate HubSpot configuration
      if (!this.config.hubspot || !this.config.hubspot.apiKey) {
        console.error('HUBSPOT_UPDATE_ERROR: API key not configured');
        throw new Error('HubSpot API key not configured');
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
        properties: Object.keys(properties) 
      });

      // Add timeout to HubSpot API call
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
      
      try {
        // Send update request with abort signal
        const response = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
          { ...fetchOptions, signal: controller.signal }
        );
        clearTimeout(timeoutId);
        
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
          responseId: data.id 
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