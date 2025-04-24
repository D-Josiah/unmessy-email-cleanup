import { Redis } from '@upstash/redis';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Initialize Redis by default unless explicitly disabled
    this.redis = null;
    this.redisEnabled = !!(config.upstash && 
                           config.upstash.url && 
                           config.upstash.token &&
                           config.useRedis !== false);
    
    // Timeouts configuration with defaults - shorter timeouts to prevent HubSpot flow hanging
    this.timeouts = {
      redis: config.timeouts?.redis || 1500,
      zeroBounce: config.timeouts?.zeroBounce || 3000,
      hubspot: config.timeouts?.hubspot || 5000,
      validation: config.timeouts?.validation || 4000, 
      webhook: config.timeouts?.webhook || 6000
    };

    // Initialize Redis asynchronously, don't block main operations
    if (this.redisEnabled) {
      try {
        console.log('UPSTASH_INIT: Initializing Redis client');
        this.redis = new Redis({
          url: config.upstash.url,
          token: config.upstash.token,
        });
        
        // Test connection in background without blocking
        this._testRedisConnectionAsync();
      } catch (error) {
        console.error('UPSTASH_INIT_ERROR:', { message: error.message });
        // Still keep Redis enabled for future attempts
      }
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
      'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 
      'aol.com', 'protonmail.com', 'fastmail.com', 'mail.com', 'zoho.com',
      'yandex.com', 'gmx.com', 'live.com', 'msn.com', 'me.com', 'mac.com', 
      'googlemail.com', 'pm.me', 'tutanota.com', 'mailbox.org'
    ];
  }

  // Asynchronous test without blocking operations
  async _testRedisConnectionAsync() {
    if (!this.redis) return;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeouts.redis);
      
      const pingResult = await this.redis.ping({ signal: controller.signal });
      clearTimeout(timeoutId);
      console.log('UPSTASH_CONNECTION_TEST: Ping successful', { result: pingResult });
    } catch (error) {
      console.error('UPSTASH_CONNECTION_TEST_FAILED:', { message: error.message });
      // Non-blocking - just log the error
    }
  }

  // Generic timeout wrapper with AbortController
  async withTimeout(promiseFn, timeoutMs, errorMessage = 'Operation timeout') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      // Execute the function with the abort signal
      const result = await promiseFn(controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }
  
  // Non-blocking Redis check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.redisEnabled || !this.redis) {
      console.log('REDIS_CHECK: Redis not enabled, skipping check');
      return false;
    }

    try {
      // Use AbortController and timeout
      const result = await this.withTimeout(
        async (signal) => {
          const key = `email:${email}`;
          console.log('REDIS_CHECK: Attempting to check if email exists in Redis', { email, key });
          
          // Important: Redis.get() doesn't accept a signal parameter directly
          // We need to use the abort controller but not pass it to the get method
          const result = await this.redis.get(key);
          
          const found = !!result;
          console.log('REDIS_CHECK: Completed successfully', { 
            email, 
            found, 
            resultType: typeof result 
          });
          return found;
        },
        this.timeouts.redis,
        'Redis check timeout'
      );
      
      if (result) {
        console.log('REDIS_CHECK: Email found in Redis database', { email });
      } else {
        console.log('REDIS_CHECK: Email not found in Redis database', { email });
      }
      
      return result;
    } catch (error) {
      console.error('REDIS_GET_ERROR:', { message: error.message, email });
      return false; // Continue validation on failure
    }
  }
  
  // Non-blocking Redis add - doesn't throw, returns false on failure
  async addToKnownValidEmails(email) {
    if (!this.redisEnabled || !this.redis) {
      return false;
    }

    try {
      return await this.withTimeout(
        async (signal) => {
          const key = `email:${email}`;
          const data = {
            validatedAt: new Date().toISOString(),
            source: 'validation-service'
          };
          
          const setResult = await this.redis.set(
            key, 
            JSON.stringify(data), 
            { ex: 30 * 24 * 60 * 60, signal }
          );
          
          return setResult === 'OK';
        },
        this.timeouts.redis,
        'Redis add timeout'
      );
    } catch (error) {
      console.error('REDIS_ADD_ERROR:', { message: error.message, email });
      return false; // Don't let Redis failures block
    }
  }
  
  // Basic format validation - fast and synchronous  
  isValidEmailFormat(email) {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  }
  
  // Typo correction - fast and synchronous
  correctEmailTypos(email) {
    if (!email) {
      return { corrected: false, email };
    }
    
    let corrected = false;
    let cleanedEmail = email.trim().toLowerCase();
    
    // Remove spaces
    const noSpaceEmail = cleanedEmail.replace(/\s/g, '');
    if (noSpaceEmail !== cleanedEmail) {
      cleanedEmail = noSpaceEmail;
      corrected = true;
    }
    
    // Check for domain typos
    const [localPart, domain] = cleanedEmail.split('@');
    
    if (domain && this.domainTypos[domain]) {
      cleanedEmail = `${localPart}@${this.domainTypos[domain]}`;
      corrected = true;
    }
    
    // Handle Gmail aliases
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
    
    return { corrected, email: cleanedEmail };
  }
  
  // Fast domain check - synchronous
  isValidDomain(email) {
    try {
      const domain = email.split('@')[1];
      if (!domain) return false;
      return this.commonValidDomains.includes(domain);
    } catch (error) {
      return false;
    }
  }
  
  // Fast local validation without external services
  quickValidate(email) {
    // Step 1: Format check
    const formatValid = this.isValidEmailFormat(email);
    if (!formatValid) {
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
    
    // Step 2: Correct typos
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    
    // Step 3: Domain check
    const domainValid = this.isValidDomain(correctedEmail);
    const status = domainValid ? 'valid' : 'unknown';
    
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
  
  // ZeroBounce check with proper timeout handling
  async checkWithZeroBounce(email) {
    if (!this.config.zeroBounceApiKey || this.config.useZeroBounce === false) {
      console.log('ZEROBOUNCE_CHECK: ZeroBounce not configured or disabled, skipping check');
      return {
        email,
        status: 'check_skipped',
        recheckNeeded: true,
        source: 'configuration'
      };
    }

    try {
      console.log('ZEROBOUNCE_CHECK: Starting validation for email', { email });
      
      const result = await this.withTimeout(
        async (signal) => {
          const url = new URL('https://api.zerobounce.net/v2/validate');
          url.searchParams.append('api_key', this.config.zeroBounceApiKey);
          url.searchParams.append('email', email);
          url.searchParams.append('ip_address', '');
          
          console.log('ZEROBOUNCE_CHECK: Sending request to ZeroBounce API', { 
            email,
            url: url.toString().replace(this.config.zeroBounceApiKey, '[REDACTED]')
          });
          
          const response = await fetch(url.toString(), { signal });
          
          if (!response.ok) {
            throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
          }
          
          const result = await response.json();
          
          console.log('ZEROBOUNCE_CHECK: Received response from ZeroBounce API', { 
            email,
            status: result.status,
            subStatus: result.sub_status
          });
          
          // Map ZeroBounce status to our status
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
          
          console.log('ZEROBOUNCE_CHECK: Completed successfully', { 
            email, 
            status, 
            subStatus,
            recheckNeeded
          });
          
          // If valid, try to add to Redis in background (don't await)
          if (status === 'valid') {
            this.addToKnownValidEmails(email).catch(() => {});
          }
          
          return {
            email,
            status,
            subStatus,
            recheckNeeded,
            source: 'zerobounce',
            details: result
          };
        },
        this.timeouts.zeroBounce,
        'ZeroBounce check timeout'
      );
      
      return result;
    } catch (error) {
      console.error('ZEROBOUNCE_CHECK_ERROR:', { message: error.message, email });
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message
      };
    }
  }
  
  // Main validation with proper timeout and graceful fallback
  async validateEmail(email, options = {}) {
    const { skipZeroBounce = false, timeoutMs = this.timeouts.validation } = options;
    
    console.log('VALIDATION_PROCESS: Starting validation for email', { 
      email, 
      skipZeroBounce, 
      timeoutMs 
    });
    
    // Start with quick validation (synchronous, always works)
    const quickResult = this.quickValidate(email);
    
    // If format is invalid, return immediately
    if (!quickResult.formatValid) {
      console.log('VALIDATION_PROCESS: Invalid format detected, returning quick result');
      return quickResult;
    }
    
    // Set a global timeout for the entire validation process
    try {
      console.log('VALIDATION_PROCESS: Starting advanced validation checks');
      
      const result = await this.withTimeout(
        async () => {
          // Log the process
          console.log('VALIDATION_PROCESS: Running Redis and ZeroBounce checks in parallel');
          
          // Run Redis check and ZeroBounce check in parallel
          const [isKnownValid, zeroBounceResult] = await Promise.allSettled([
            this.isKnownValidEmail(quickResult.currentEmail),
            skipZeroBounce ? null : this.checkWithZeroBounce(quickResult.currentEmail)
          ]);
          
          // Start with the quick result and enhance it
          const result = { ...quickResult };
          
          // Add Redis result if successful
          if (isKnownValid.status === 'fulfilled' && isKnownValid.value === true) {
            console.log('VALIDATION_PROCESS: Email found in Redis database, marking as valid', { 
              email: quickResult.currentEmail 
            });
            
            result.isKnownValid = true;
            result.status = 'valid';
            result.recheckNeeded = false;
            result.validationSteps.push({ step: 'known_valid_check', passed: true });
            return result;
          } else {
            console.log('VALIDATION_PROCESS: Email not found in Redis or check failed', {
              email: quickResult.currentEmail,
              status: isKnownValid.status
            });
            
            result.isKnownValid = false;
            result.validationSteps.push({ 
              step: 'known_valid_check', 
              passed: false, 
              error: isKnownValid.status === 'rejected' ? isKnownValid.reason.message : null 
            });
          }
          
          // Add ZeroBounce result if available and successful
          if (!skipZeroBounce && zeroBounceResult?.status === 'fulfilled' && zeroBounceResult.value) {
            const bounceCheck = zeroBounceResult.value;
            
            console.log('VALIDATION_PROCESS: ZeroBounce check completed', {
              email: quickResult.currentEmail,
              status: bounceCheck.status,
              subStatus: bounceCheck.subStatus
            });
            
            // Only update if we got a definitive result
            if (bounceCheck.status === 'valid' || bounceCheck.status === 'invalid') {
              result.status = bounceCheck.status;
              result.subStatus = bounceCheck.subStatus;
              result.recheckNeeded = bounceCheck.recheckNeeded;
            }
            
            result.validationSteps.push({
              step: 'zerobounce_check',
              result: bounceCheck
            });
          } else if (!skipZeroBounce) {
            console.log('VALIDATION_PROCESS: ZeroBounce check failed or was skipped', {
              email: quickResult.currentEmail,
              error: zeroBounceResult?.reason?.message || 'Failed or skipped'
            });
            
            result.validationSteps.push({
              step: 'zerobounce_check',
              error: zeroBounceResult?.reason?.message || 'Failed or skipped'
            });
          }
          
          console.log('VALIDATION_PROCESS: All validation steps completed successfully', {
            email: quickResult.currentEmail,
            finalStatus: result.status,
            recheckNeeded: result.recheckNeeded
          });
          
          return result;
        },
        timeoutMs,
        'Validation timeout'
      );
      
      return result;
    } catch (error) {
      console.error('VALIDATION_TIMEOUT:', { message: error.message, email });
      console.log('VALIDATION_PROCESS: Using quick validation result as fallback due to timeout');
      // Return quick result on timeout
      return quickResult;
    }
  }
  
  // Batch validation with time budget management
  async validateBatch(emails, options = {}) {
    const { skipZeroBounce = false, timeoutPerEmailMs = 2000 } = options;
    
    const results = [];
    const batchStartTime = Date.now();
    const totalBatchTimeoutMs = Math.min(5000, emails.length * timeoutPerEmailMs);
    
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      
      // Calculate remaining time budget
      const elapsedTime = Date.now() - batchStartTime;
      const remainingTimeMs = totalBatchTimeoutMs - elapsedTime;
      
      // If we're running out of time, use quick validation for remaining emails
      if (remainingTimeMs < timeoutPerEmailMs / 2) {
        // Process remaining emails with quick validation
        for (let j = i; j < emails.length; j++) {
          results.push(this.quickValidate(emails[j]));
        }
        break;
      }
      
      try {
        // Validate with appropriate timeout
        const result = await this.validateEmail(email, {
          skipZeroBounce,
          timeoutMs: Math.min(remainingTimeMs, timeoutPerEmailMs)
        });
        
        results.push(result);
      } catch (error) {
        // Fall back to quick validation
        results.push(this.quickValidate(email));
      }
    }
    
    return results;
  }
  
  // Update HubSpot contact with proper timeout handling
  async updateHubSpotContact(contactId, validationResult) {
    console.log('HUBSPOT_UPDATE: Starting contact update', {
      contactId,
      validationStatus: validationResult.status,
      email: validationResult.currentEmail
    });
    
    if (!this.config.hubspot?.apiKey) {
      console.error('HUBSPOT_UPDATE: API key not configured');
      return {
        success: false,
        contactId,
        error: 'HubSpot API key not configured'
      };
    }

    try {
      console.log('HUBSPOT_UPDATE: Preparing properties for update');
      
      return await this.withTimeout(
        async (signal) => {
          // Prepare properties to update
          const properties = {
            email: validationResult.currentEmail,
            email_status: validationResult.status,
            email_recheck_needed: validationResult.recheckNeeded,
            email_check_date: new Date().toISOString(),
          };
          
          if (validationResult.wasCorrected) {
            properties.original_email = validationResult.originalEmail;
            properties.email_corrected = true;
          }
          
          if (validationResult.subStatus) {
            properties.email_sub_status = validationResult.subStatus;
          }
          
          console.log('HUBSPOT_UPDATE: Sending update request', {
            contactId,
            properties: Object.keys(properties).join(', ')
          });
          
          // Send update request
          const response = await fetch(
            `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.hubspot.apiKey}`
              },
              body: JSON.stringify({ properties }),
              signal
            }
          );
          
          console.log('HUBSPOT_UPDATE: Received response', {
            contactId,
            status: response.status,
            statusText: response.statusText
          });
          
          if (!response.ok) {
            throw new Error(`HubSpot API error: ${response.status} ${response.statusText}`);
          }
          
          const data = await response.json();
          
          console.log('HUBSPOT_UPDATE: Successfully updated contact', {
            contactId,
            responseId: data.id
          });
          
          return {
            success: true,
            contactId,
            hubspotResponse: data
          };
        },
        this.timeouts.hubspot,
        'HubSpot update timeout'
      );
    } catch (error) {
      console.error('HUBSPOT_UPDATE_ERROR:', { message: error.message, contactId });
      return {
        success: false,
        contactId,
        error: error.message
      };
    }
  }
}